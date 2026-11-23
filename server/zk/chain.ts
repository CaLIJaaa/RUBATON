import { AbiCoder, Contract, Interface, getAddress, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { resolve } from 'node:path';
import { VaultChain, VAULT_ABI } from '../chain.ts';
import type { ServerConfig } from '../config.ts';
import { tokenMetadata } from '../config.ts';
import type { PublicReceiptBatch, PublicationPreparation, Token, WithdrawalRecord } from '../types.ts';
import type { ZkRubaEngine } from './engine.ts';
import { Groth16TransitionProver } from './prover.ts';
import { checkedSignals, SIGNAL, ZK_PROOF_MODE, ZK_WITHDRAWAL_MODE, type ProveableTransition, type ZkSignedPublication, type ZkWithdrawalTicket } from './types.ts';
import type { PublicationMetadata, DaRecord, PoolDa } from '../../zk/schema.ts';

export const ZK_PUBLICATION_TYPES = {
  ZkPublication: [
    { name: 'headerDigest', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signerEpoch', type: 'uint256' },
  ],
};
export const zkPublicationDomain = (chainId: bigint, vault: string) => ({ name: 'RubaZkPublication', version: '2', chainId, verifyingContract: vault });
export const zkHeaderDigest = (signals: readonly bigint[]) => keccak256(AbiCoder.defaultAbiCoder().encode(['uint256[13]'], [signals]));

const METADATA = '(uint256 kind,uint256 slot,address owner,uint256 commitment,uint256 eventId,uint256 token,uint256 amount,uint256 reference,bytes signature)';
const ACCOUNT_DA = '(uint256 kind,uint256 slot,address owner,uint256 newLeaf,uint256[7] ciphertext)';
const POOL_DA = '(uint256 poolHash,uint256[6] poolCiphertext)';
const PROOF = '(uint256[2] a,uint256[2][2] b,uint256[2] c)';
const AUTHORIZATION = '(uint256 deadline,uint256 signerEpoch,bytes signature)';
const WITHDRAWAL = '(address account,address token,uint256 amount,uint256 nonce,uint256 spendNonce,uint256 salt)';
export const ZK_VAULT_ABI = [
  ...VAULT_ABI,
  'function proofMode() view returns (string)',
  'function ZK_VERSION() view returns (uint256)',
  'function withdrawalMode() view returns (string)',
  'function verifier() view returns (address)',
  'function poseidon2() view returns (address)',
  'function verifierCodeHash() view returns (bytes32)',
  'function poseidonCodeHash() view returns (bytes32)',
  'function domain() view returns (uint256)',
  'function poolKeyCommit() view returns (uint256)',
  'function stateVersion() view returns (uint256)',
  'function inboxCursor() view returns (uint256)',
  'function nextTradeId() view returns (uint256)',
  'function nextInboxEventId() view returns (uint256)',
  'function genesisStateRoot() view returns (bytes32)',
  'function transitions(uint256) view returns (uint256[13])',
  'function inbox(uint256) view returns (uint256 kind,address owner,uint256 tokenIndex,uint256 amount,uint256 referenceId)',
  'function ownerSlotPlusOne(address) view returns (uint256)',
  'function slotOwners(uint256) view returns (address)',
  `function publishZkTransition(uint256[13] publicSignals,${METADATA}[8] operations,${ACCOUNT_DA}[8] accountDA,${POOL_DA} poolDA,${PROOF} proof,${AUTHORIZATION} authorization)`,
  `function publishProvenTransition(uint256[13] publicSignals,${METADATA}[8] operations,${ACCOUNT_DA}[8] accountDA,${POOL_DA} poolDA,${PROOF} proof)`,
  `function publishProvenTransitionAndWithdraw(uint256[13] publicSignals,${METADATA}[8] operations,${ACCOUNT_DA}[8] accountDA,${POOL_DA} poolDA,${PROOF} proof,${WITHDRAWAL} withdrawal)`,
  `function withdrawProven(${WITHDRAWAL} withdrawal)`,
  'function withdrawalClaims(uint256) view returns (address owner,uint256 slot,uint256 stateVersion)',
  'function spentWithdrawalCommitments(uint256) view returns (bool)',
  'event CanonicalInboxAppended(uint256 indexed eventId,uint256 kind,address indexed owner,uint256 tokenIndex,uint256 amount,uint256 referenceId)',
  'event ZkTransitionPublished(uint256 indexed stateVersion,uint256 indexed tradeBatchId,uint256[13] publicSignals)',
];

interface LocalTransition extends ProveableTransition {
  metadata: PublicationMetadata[];
  accountDA: DaRecord[];
  poolDA: PoolDa;
  tradeBatchId?: bigint | string;
}
type EventRecord = { eventId: bigint; kind: 2 | 7; owner: string; token: 'RUBA' | 'USDT'; amount: bigint; reference: bigint; legacyEventId: string; transactionHash: string; blockNumber: number };
const rootHex = (value: bigint | string) => zeroPadValue(toBeHex(BigInt(value)), 32);
const sameSignals = (left: readonly (bigint | string)[], right: readonly (bigint | string)[]) => {
  const a = checkedSignals(left), b = checkedSignals(right);
  return a.every((value, index) => value === b[index]);
};
class InconsistentCanonicalRead extends Error {}

/** ZK-only observer/prover. Neither proof creation nor publication spends operator ETH. */
export class ZkVaultChain extends VaultChain {
  declare readonly engine: ZkRubaEngine;
  readonly zkVault: Contract;
  readonly zkAbi = new Interface(ZK_VAULT_ABI);
  readonly prover: Groth16TransitionProver;
  private zkFatal?: string;
  private observerQueue?: Promise<unknown>;

  private serialObservation<T>(operation: () => Promise<T>): Promise<T> {
    const result = (this.observerQueue ?? Promise.resolve()).then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
          if (!(error instanceof InconsistentCanonicalRead) || attempt >= 2) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    });
    this.observerQueue = result.catch(() => undefined);
    return result;
  }

  constructor(config: ServerConfig, engine: ZkRubaEngine, prover?: Groth16TransitionProver) {
    super(config, engine);
    this.zkVault = new Contract(config.vaultAddress, ZK_VAULT_ABI, this.provider);
    const artifactsDir = (config as ServerConfig & { zkArtifactsDir?: string }).zkArtifactsDir ?? resolve('zk/artifacts');
    this.prover = prover ?? new Groth16TransitionProver(engine.db, artifactsDir);
  }

  override async initialize(): Promise<void> {
    const manifest = this.prover.initialize();
    if ((await this.provider.getNetwork()).chainId !== this.config.chainId) throw new Error('RPC chain ID differs from CHAIN_ID');
    if (await this.provider.getCode(this.config.vaultAddress) === '0x') throw new Error('ZK Vault address has no contract');
    try {
      if (await this.zkVault.proofMode() !== ZK_PROOF_MODE || BigInt(await this.zkVault.ZK_VERSION()) !== 2n) throw new Error('Wrong proof mode');
    } catch { throw new Error('ZK mode requires ZkRubaVault v2 with real Groth16 verification; legacy fallback is disabled'); }
    try {
      if (await this.zkVault.withdrawalMode() !== ZK_WITHDRAWAL_MODE) throw new Error('Wrong withdrawal mode');
    } catch { throw new Error('ZK mode requires a new Vault with withdrawalMode=proven-reservation-v1; old operator-authorized ZK Vaults are unsupported'); }
    const [verifier, poseidon, verifierHash, poseidonHash, domain, poolKeyCommit, genesis, ruba, usdt] = await Promise.all([
      this.zkVault.verifier(), this.zkVault.poseidon2(), this.zkVault.verifierCodeHash(), this.zkVault.poseidonCodeHash(),
      this.zkVault.domain(), this.zkVault.poolKeyCommit(), this.zkVault.genesisStateRoot(),
      this.vault.ruba(), this.vault.usdt(),
    ]);
    const [verifierCode, poseidonCode] = await Promise.all([this.provider.getCode(verifier), this.provider.getCode(poseidon)]);
    if (verifierCode === '0x' || keccak256(verifierCode).toLowerCase() !== String(verifierHash).toLowerCase()
      || String(verifierHash).toLowerCase() !== manifest.verifierRuntimeCodeHash.toLowerCase()) throw new Error('ZK verifier bytecode differs from pinned proving artifacts');
    if (poseidonCode === '0x' || keccak256(poseidonCode).toLowerCase() !== String(poseidonHash).toLowerCase()
      || String(poseidonHash).toLowerCase() !== manifest.poseidonRuntimeCodeHash.toLowerCase()) throw new Error('ZK Poseidon bytecode differs from the pinned hash');
    if (BigInt(domain) !== BigInt(this.engine.getDomain()) || BigInt(poolKeyCommit) !== BigInt(this.engine.getPoolKeyCommit())
      || BigInt(genesis) !== BigInt(this.engine.getGenesisStateRoot())) throw new Error('ZK domain, pool recovery key or genesis differs from durable engine state');
    if (getAddress(ruba) !== this.config.rubaAddress || getAddress(usdt) !== this.config.usdtAddress) throw new Error('Configured token addresses differ from ZK Vault tokens');
    const decimalsAbi = ['function decimals() view returns (uint8)'];
    const decimals = await Promise.all([new Contract(ruba, decimalsAbi, this.provider).decimals(), new Contract(usdt, decimalsAbi, this.provider).decimals()]);
    const expectedMetadata = tokenMetadata(this.config);
    if (BigInt(decimals[0]) !== BigInt(expectedMetadata.RUBA.decimals) || BigInt(decimals[1]) !== BigInt(expectedMetadata.USDT.decimals)) throw new Error('Token decimals differ from configured market metadata');
    if ((await this.confirmedBlock()).number < this.config.deploymentBlock) throw new Error('Vault deployment is not confirmed yet; wait before starting the market');
    this.assertJournalContinuity();
    await this.observeTransitions();
    await this.sync();
  }

  private fail(message: string): never { this.zkFatal = message; throw new Error(message); }
  /** Read-only consumers must not report accepted state after a fatal reconciliation error. */
  assertHealthy(): void { if (this.zkFatal) throw new Error(this.zkFatal); }
  private transitions(): LocalTransition[] { return this.engine.listTransitions() as unknown as LocalTransition[]; }
  private transition(version: bigint): LocalTransition | undefined { return this.engine.getTransition(version) as unknown as LocalTransition | undefined; }
  private head(): LocalTransition | undefined { return this.engine.getPendingTransition() as unknown as LocalTransition | undefined; }

  private tradeCount(signals: bigint[]): bigint {
    const count = signals[SIGNAL.newTradeId] - signals[SIGNAL.previousTradeId];
    const mode = signals[SIGNAL.mode];
    if ((mode !== 0n && mode !== 1n) || (mode === 0n ? count !== 0n : count < 1n || count > 4n)
      || (mode === 0n && signals[SIGNAL.receiptsRoot] !== 0n)) this.fail('ZK journal contains an invalid transition mode/trade sequence');
    return count;
  }

  private tradeBatchIdAt(version: bigint): bigint {
    return BigInt(this.transitions().filter((transition) => BigInt(transition.stateVersion) <= version
      && checkedSignals(transition.publicSignals)[SIGNAL.mode] === 1n).length);
  }

  private assertJournalContinuity(): void {
    let previousRoot = BigInt(this.engine.getGenesisStateRoot());
    let previousCursor = 0n, previousTrade = 1n, version = 0n, tradeBatchId = 0n;
    for (const transition of this.transitions()) {
      const signals = checkedSignals(transition.publicSignals);
      if (signals[SIGNAL.stateVersion] !== ++version || BigInt(transition.stateVersion) !== version
        || signals[SIGNAL.previousRoot] !== previousRoot || signals[SIGNAL.previousInboxCursor] !== previousCursor
        || signals[SIGNAL.previousTradeId] !== previousTrade || signals[SIGNAL.domain] !== BigInt(this.engine.getDomain())
        || signals[SIGNAL.poolKeyCommit] !== BigInt(this.engine.getPoolKeyCommit())) this.fail('ZK journal state chain differs from its genesis; restore/reconcile the durable database');
      const mode = signals[SIGNAL.mode];
      this.tradeCount(signals);
      if (mode === 1n && BigInt(transition.tradeBatchId ?? 0n) !== ++tradeBatchId) this.fail('ZK journal trade batch IDs are not sequential');
      previousRoot = signals[SIGNAL.newRoot]; previousCursor = signals[SIGNAL.newInboxCursor]; previousTrade = signals[SIGNAL.newTradeId];
    }
  }

  override async sync(): Promise<void> {
    return this.serialObservation(() => this.syncCanonical());
  }

  private async syncCanonical(): Promise<void> {
    this.assertHealthy();
    const checkpoint = this.engine.db.prepare('SELECT block_number,block_hash FROM indexer_checkpoint WHERE id=1').get() as { block_number: number; block_hash: string } | undefined;
    if (checkpoint && (await this.provider.getBlock(checkpoint.block_number))?.hash !== checkpoint.block_hash) this.fail('ZK indexer checkpoint changed after chain reorganization; reconcile before resuming');
    await this.observeTransitions();
    const target = await this.confirmedBlock();
    const count = BigInt(await this.zkVault.nextInboxEventId({ blockTag: target.number })) - 1n;
    if (count < this.engine.getCurrentInboxCursor()) this.fail('Canonical inbox is behind the durable ZK journal');
    while (this.engine.getCurrentInboxCursor() < count) {
      // Reserved swap capacity is backpressure, not a fatal sync error. Reading
      // inbox by its cursor permits safely resuming even within the same block.
      if (!this.engine.canApplyInboxRecord()) break;
      const eventId = this.engine.getCurrentInboxCursor() + 1n;
      const record = await this.readInboxRecord(eventId, target.number);
      // Deposits may arrive before their owner's proven registration. Leave
      // them in the canonical inbox until the matching account exists.
      if (!this.engine.canApplyInboxRecord(record)) break;
      this.engine.applyInboxRecord(record);
    }
    const after = await this.provider.getBlock(target.number);
    if (after?.hash !== target.hash) throw new Error('Chain changed while reading canonical ZK inbox');
    this.engine.db.prepare('INSERT INTO indexer_checkpoint VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash')
      .run(target.number, target.hash!);
  }

  private async readInboxRecord(eventId: bigint, confirmedNumber: number): Promise<EventRecord> {
    const stored = await this.zkVault.inbox(eventId, { blockTag: confirmedNumber });
    const kind = Number(stored.kind);
    if (kind === 0) throw new InconsistentCanonicalRead(`RPC snapshot is inconsistent: counted inbox event ${eventId} is absent at block ${confirmedNumber}; synchronize again`);
    if (kind !== 2 && kind !== 7) this.fail(`Canonical ZK inbox contains an unsupported operation (event ${eventId}, block ${confirmedNumber}, kind ${kind})`);
    const owner = getAddress(stored.owner), tokenIndex = BigInt(stored.tokenIndex), amount = BigInt(stored.amount), reference = BigInt(stored.referenceId);
    if ((tokenIndex !== 0n && tokenIndex !== 1n) || amount <= 0n) this.fail('Canonical ZK inbox record is invalid');
    const token = tokenIndex === 0n ? 'RUBA' : 'USDT';
    const topic = this.zkAbi.getEvent('CanonicalInboxAppended')!.topicHash;
    const logs = await this.findLogs([topic, zeroPadValue(toBeHex(eventId), 32)], confirmedNumber);
    if (logs.length !== 1) this.fail('Canonical ZK inbox event is missing or duplicated');
    const log = logs[0], parsed = this.zkAbi.parseLog(log);
    if (!parsed || parsed.args.eventId !== eventId || Number(parsed.args.kind) !== kind || getAddress(parsed.args.owner) !== owner
      || BigInt(parsed.args.tokenIndex) !== tokenIndex || BigInt(parsed.args.amount) !== amount || BigInt(parsed.args.referenceId) !== reference || log.removed) this.fail('Canonical inbox storage differs from its event');
    const receipt = await this.provider.getTransactionReceipt(log.transactionHash);
    if (!receipt || receipt.status !== 1 || receipt.blockNumber !== log.blockNumber || receipt.blockNumber > confirmedNumber) throw new Error('Canonical bridge transaction is not confirmed');
    const bridge = receipt.logs.find((candidate) => {
      if (getAddress(candidate.address) !== this.config.vaultAddress) return false;
      const event = this.abi.parseLog(candidate);
      if (kind === 2) return event?.name === 'Deposited' && event.args.depositId === reference && getAddress(event.args.account) === owner && this.token(event.args.token) === token && event.args.amount === amount;
      return event?.name === 'Withdrawn' && event.args.nonce === reference && getAddress(event.args.account) === owner && this.token(event.args.token) === token && event.args.amount === amount;
    });
    if (!bridge) this.fail('Canonical inbox record has no matching original deposit/payout event');
    return {
      eventId, kind: kind as 2 | 7, owner, token, amount, reference,
      legacyEventId: kind === 2 ? reference.toString() : `${this.config.chainId}:${this.config.vaultAddress}:${log.transactionHash}:${bridge.index}`,
      transactionHash: log.transactionHash, blockNumber: log.blockNumber,
    };
  }

  private async findLogs(topics: string[], confirmedNumber: number) {
    const found = [] as Awaited<ReturnType<typeof this.provider.getLogs>>;
    for (let from = this.config.deploymentBlock; from <= confirmedNumber; from += 1000) {
      found.push(...await this.provider.getLogs({ address: this.config.vaultAddress, topics, fromBlock: from, toBlock: Math.min(from + 999, confirmedNumber) }));
    }
    return found;
  }

  private async observeTransitions(): Promise<void> {
    this.assertHealthy();
    const confirmed = await this.confirmedBlock();
    const readAt = { blockTag: confirmed.number };
    const [versionValue, rootValue] = await Promise.all([
      this.zkVault.stateVersion(readAt), this.vault.stateRoot(readAt),
    ]);
    const latestVersion = BigInt(versionValue), latestRoot = BigInt(rootValue);
    const stable = async () => {
      if ((await this.provider.getBlock(confirmed.number))?.hash !== confirmed.hash) {
        throw new Error('Chain changed while reading the confirmed ZK state; retry synchronization');
      }
    };
    const mismatch = async (message: string): Promise<never> => { await stable(); return this.fail(message); };
    const checkpoint = this.engine.getAcceptedCheckpoint();
    if (BigInt(checkpoint.stateVersion) > latestVersion) return mismatch('Accepted ZK checkpoint is ahead of confirmed chain history; reconcile a reorganization before resuming');
    if (latestVersion === 0n) {
      if (latestRoot !== BigInt(this.engine.getGenesisStateRoot()) || BigInt(checkpoint.stateVersion) !== 0n
        || BigInt(checkpoint.root) !== latestRoot || BigInt(checkpoint.inboxCursor) !== 0n
        || BigInt(checkpoint.nextTradeId) !== 1n || BigInt(checkpoint.tradeBatchId) !== 0n) return mismatch('ZK chain genesis differs from accepted engine checkpoint');
      await stable();
      return;
    }
    const latest = this.transition(latestVersion);
    if (!latest) return mismatch('Accepted ZK state has no matching server journal; restore the database before resuming');
    if (!sameSignals(latest.publicSignals, await this.canonicalHeader(latestVersion, confirmed.number)) || BigInt(latest.publicSignals[SIGNAL.newRoot]) !== latestRoot) return mismatch('Accepted ZK state differs from the immutable server journal');
    if (BigInt(checkpoint.stateVersion) > 0n) {
      const acceptedLocal = this.transition(BigInt(checkpoint.stateVersion));
      const acceptedHeader = await this.canonicalHeader(BigInt(checkpoint.stateVersion), confirmed.number);
      if (!acceptedLocal || !sameSignals(acceptedLocal.publicSignals, acceptedHeader)
        || BigInt(checkpoint.root) !== acceptedHeader[SIGNAL.newRoot]
        || BigInt(checkpoint.inboxCursor) !== acceptedHeader[SIGNAL.newInboxCursor]
        || BigInt(checkpoint.nextTradeId) !== acceptedHeader[SIGNAL.newTradeId]
        || BigInt(checkpoint.tradeBatchId) !== this.tradeBatchIdAt(BigInt(checkpoint.stateVersion))) return mismatch('Accepted ZK checkpoint differs from its confirmed on-chain header');
      if (checkpoint.txHash || checkpoint.blockNumber !== undefined) {
        const publication = await this.transitionPublication(acceptedLocal, confirmed.number);
        if ((checkpoint.txHash && checkpoint.txHash !== publication.transactionHash)
          || (checkpoint.blockNumber !== undefined && checkpoint.blockNumber !== publication.blockNumber)) return mismatch('Accepted ZK checkpoint publication differs from canonical chain history');
      }
    }
    const publications: { version: bigint; transactionHash: string; blockNumber: number }[] = [];
    for (let version = BigInt(checkpoint.stateVersion) + 1n; version <= latestVersion; version++) {
      const local = this.transition(version);
      if (!local || !sameSignals(local.publicSignals, await this.canonicalHeader(version, confirmed.number))) return mismatch(`Finalized ZK transition differs from the durable server journal (version ${version}, block ${confirmed.number})`);
      const publication = await this.transitionPublication(local, confirmed.number);
      publications.push({ version, ...publication });
    }
    await stable();
    for (const publication of publications) this.engine.markTransitionAccepted(publication.version, publication.transactionHash, publication.blockNumber);
    const accepted = this.engine.getAcceptedCheckpoint();
    if (BigInt(accepted.stateVersion) === latestVersion && BigInt(accepted.root) !== latestRoot) this.fail('Accepted ZK checkpoint root differs from the Vault');
  }

  override async publishPendingBatches(): Promise<void> { return this.serialObservation(() => this.observeTransitions()); }

  private async canonicalHeader(version: bigint, blockNumber: number): Promise<bigint[]> {
    const header = checkedSignals(await this.zkVault.transitions(version, { blockTag: blockNumber }));
    if (header[SIGNAL.stateVersion] === 0n) throw new InconsistentCanonicalRead(`RPC snapshot is inconsistent: counted ZK transition ${version} is absent at block ${blockNumber}; synchronize again`);
    return header;
  }

  override async withdrawalContext(token: Token) {
    if (await this.vault.withdrawalsPaused(this.address(token))) throw new Error('Withdrawals for this token are paused');
    // Compatibility fields for the durable legacy record only. Proven claims
    // have no operator epoch, expiry, or operator signature.
    return { signerEpoch: 0n, deadline: (1n << 64n) - 1n };
  }

  override async signWithdrawal(record: WithdrawalRecord): Promise<ZkWithdrawalTicket> {
    if (record.status !== 'pending' && record.status !== 'settled') throw new Error('Withdrawal is not a pending or settled proven reservation');
    const opening = this.engine.getProvenWithdrawal(record);
    return { kind: 'zk-withdrawal', chainId: this.config.chainId, vault: this.config.vaultAddress, ...opening };
  }

  override async expiryContext(_account: string, _nonce: bigint): Promise<never> {
    throw new Error('Proven withdrawal claims do not expire and cannot be refunded');
  }

  override async expireWithdrawal(_account: string, _nonce: bigint): Promise<never> {
    throw new Error('Proven withdrawal claims do not expire and cannot be refunded');
  }

  override async getPublicationRequest(): Promise<PublicationPreparation> {
    return this.serialObservation(() => this.preparePublication());
  }

  private async preparePublication(): Promise<PublicationPreparation> {
    this.assertHealthy();
    await this.observeTransitions();
    const progress = this.engine.getBatchProgress();
    const head = this.head();
    if (!head) return { status: 'idle', request: null, progress };
    const signals = checkedSignals(head.publicSignals);
    const tradeCount = this.tradeCount(signals);
    const tip = await this.provider.getBlock('latest');
    if (!tip?.hash) throw new Error('Cannot read the ZK publication block');
    const readAt = { blockTag: tip.number };
    const [version, root, cursor, nextTradeId] = await Promise.all([this.zkVault.stateVersion(readAt), this.vault.stateRoot(readAt), this.zkVault.inboxCursor(readAt), this.zkVault.nextTradeId(readAt)]);
    if ((await this.provider.getBlock(tip.number))?.hash !== tip.hash) throw new Error('Chain changed while preparing ZK publication');
    if (BigInt(version) >= signals[SIGNAL.stateVersion]) {
      if (!sameSignals(signals, await this.canonicalHeader(signals[SIGNAL.stateVersion], tip.number))) this.fail('Pending ZK transition differs from accepted contract state');
      return { status: 'waiting', request: null, progress };
    }
    if (BigInt(version) + 1n !== signals[SIGNAL.stateVersion] || BigInt(root) !== signals[SIGNAL.previousRoot]
      || BigInt(cursor) !== signals[SIGNAL.previousInboxCursor] || BigInt(nextTradeId) !== signals[SIGNAL.previousTradeId]) this.fail('ZK publication head does not continue the accepted on-chain state');
    const generated = await this.prover.prove(head);
    // Re-read the head after proving. Publication requires the proof and owner
    // authorizations; administrator rotation cannot censor a valid transition.
    const currentTip = await this.provider.getBlock('latest');
    if (!currentTip?.hash) throw new Error('Cannot refresh the ZK publication block');
    const currentReadAt = { blockTag: currentTip.number };
    const [currentVersion, currentRoot] = await Promise.all([
      this.zkVault.stateVersion(currentReadAt), this.vault.stateRoot(currentReadAt),
    ]);
    if ((await this.provider.getBlock(currentTip.number))?.hash !== currentTip.hash) throw new Error('Chain changed while proving ZK publication');
    if (BigInt(currentVersion) >= signals[SIGNAL.stateVersion]) {
      if (!sameSignals(signals, await this.canonicalHeader(signals[SIGNAL.stateVersion], currentTip.number))) this.fail('Proof head differs from a competing accepted transition');
      return { status: 'waiting', request: null, progress };
    }
    if (BigInt(currentVersion) + 1n !== signals[SIGNAL.stateVersion] || BigInt(currentRoot) !== signals[SIGNAL.previousRoot]) throw new Error('ZK state changed while proving; refresh publication');
    const deadline = 0n, signerEpoch = 0n, signature = '0x';
    const tradeMode = signals[SIGNAL.mode] === 1n;
    const request: ZkSignedPublication = {
      kind: 'zk', authorizationMode: 'proof-only', chainId: this.config.chainId, vault: this.config.vaultAddress,
      publicSignals: generated.publicSignals,
      operations: head.metadata.map((operation) => ({ ...operation, owner: getAddress(toBeHex(BigInt(operation.owner), 20)) })),
      accountDA: head.accountDA.map((record) => ({ ...record, owner: getAddress(toBeHex(BigInt(record.owner), 20)) })),
      poolDA: head.poolDA, proof: generated.proof,
      authorization: { deadline, signerEpoch, signature },
      // Legacy response aliases are display-only. The ZK call binds the header,
      // metadata and DA; never encode these aliases as a legacy publication.
      batch: { batchId: tradeMode ? BigInt(head.tradeBatchId!) : 0n, previousStateRoot: rootHex(signals[SIGNAL.previousRoot]), newStateRoot: rootHex(signals[SIGNAL.newRoot]), receiptsRoot: rootHex(signals[SIGNAL.receiptsRoot]), firstTradeId: signals[SIGNAL.previousTradeId], tradeCount },
      deadline, signerEpoch, signature,
    };
    return { status: 'ready', request, progress };
  }

  private async transitionPublication(local: LocalTransition, confirmedNumber: number): Promise<{ transactionHash: string; blockNumber: number }> {
    const version = BigInt(local.stateVersion), signals = checkedSignals(local.publicSignals);
    const logs = await this.findLogs([this.zkAbi.getEvent('ZkTransitionPublished')!.topicHash, zeroPadValue(toBeHex(version), 32)], confirmedNumber);
    if (logs.length !== 1) throw new Error('Confirmed ZK transition publication event was not found uniquely');
    const log = logs[0], event = this.zkAbi.parseLog(log);
    if (!event || log.removed || event.args.stateVersion !== version || !sameSignals(event.args.publicSignals, signals)
      || BigInt(event.args.tradeBatchId) !== this.tradeBatchIdAt(version)) this.fail('ZK transition publication event differs from the immutable journal');
    const receipt = await this.provider.getTransactionReceipt(log.transactionHash);
    if (!receipt || receipt.status !== 1 || receipt.blockNumber > confirmedNumber || receipt.blockNumber !== log.blockNumber
      || !receipt.logs.some((candidate) => candidate.index === log.index && candidate.address.toLowerCase() === this.config.vaultAddress.toLowerCase()
        && candidate.data === log.data && candidate.topics.join(',') === log.topics.join(','))) throw new Error('ZK publication transaction is not confirmed');
    if ((await this.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('ZK publication receipt is not canonical');
    return { transactionHash: log.transactionHash, blockNumber: receipt.blockNumber };
  }

  override async getDisclosureBatch(batchId: bigint): Promise<PublicReceiptBatch | undefined> {
    return this.serialObservation(() => this.readDisclosureBatch(batchId));
  }

  private async readDisclosureBatch(batchId: bigint): Promise<PublicReceiptBatch | undefined> {
    if (typeof batchId !== 'bigint' || batchId <= 0n || batchId >= (1n << 64n)) throw new Error('Invalid ZK batch ID');
    const local = this.engine.getTransitionForBatch(batchId) as unknown as LocalTransition | undefined;
    if (!local) return undefined;
    const signals = checkedSignals(local.publicSignals);
    if (signals[SIGNAL.mode] !== 1n || BigInt(local.tradeBatchId!) !== batchId) this.fail('Receipt batch is not a trade ZK transition');
    const tradeCount = this.tradeCount(signals);
    const batch = { batchId, previousStateRoot: rootHex(signals[SIGNAL.previousRoot]), newStateRoot: rootHex(signals[SIGNAL.newRoot]), receiptsRoot: rootHex(signals[SIGNAL.receiptsRoot]), firstTradeId: signals[SIGNAL.previousTradeId], tradeCount };
    const confirmed = await this.confirmedBlock();
    const version = BigInt(local.stateVersion);
    const common = { chainId: this.config.chainId, vault: this.config.vaultAddress, schemaVersion: 2, proofMode: 'zk', circuitProofMode: ZK_PROOF_MODE, stateVersion: version, publicSignals: signals };
    if (BigInt(await this.zkVault.stateVersion({ blockTag: confirmed.number })) < version) return { ...common, status: 'pending', source: 'server', batch };
    if (!sameSignals(signals, await this.canonicalHeader(version, confirmed.number))) this.fail('Published ZK disclosure header differs from the journal');
    const publication = await this.transitionPublication(local, confirmed.number);
    return { ...common, status: 'published', source: 'contract', batch: { ...batch, publishedTxHash: publication.transactionHash }, blockNumber: publication.blockNumber };
  }

  override close(): void { super.close(); void this.prover.close(); }
}
