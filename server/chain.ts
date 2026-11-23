import { Contract, Interface, JsonRpcProvider, Wallet, getAddress, toBeHex, zeroPadValue } from 'ethers';
import type { ServerConfig } from './config.ts';
import { tokenMetadata } from './config.ts';
import type { RubaEngine } from './engine.ts';
import type { BatchCommitment, PublicReceiptBatch, PublicationPreparation, WithdrawalTicket } from './types.ts';
import { BATCH_PUBLICATION_TYPEHASH, BATCH_PUBLICATION_TYPES, WITHDRAWAL_TYPES, batchPublicationDomain, withdrawalDomain } from './auth.ts';

export const VAULT_ABI = [
  'function ruba() view returns (address)',
  'function usdt() view returns (address)',
  'function operator() view returns (address)',
  'function whitelist(address) view returns (bool)',
  'function marketPaused() view returns (bool)',
  'function withdrawalsPaused(address) view returns (bool)',
  'function signerEpoch() view returns (uint256)',
  'function usedWithdrawalNonces(address,uint256) view returns (bool)',
  'function lastBatchId() view returns (uint256)',
  'function lastTradeId() view returns (uint256)',
  'function stateRoot() view returns (bytes32)',
  'function MIN_TRADES_PER_BATCH() view returns (uint256)',
  'function MAX_TRADES_PER_BATCH() view returns (uint256)',
  'function PUBLISH_BATCH_TYPEHASH() view returns (bytes32)',
  'function batches(uint256) view returns (uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount)',
  'function publishBatch((uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount) batch)',
  'function publishSignedBatch((uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount) batch,uint256 deadline,uint256 signerEpoch,bytes signature)',
  'function batchPublicationDigest((uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount) batch,uint256 deadline,uint256 signerEpoch) view returns (bytes32)',
  'event Deposited(uint256 indexed depositId,address indexed account,address indexed token,uint256 amount)',
  'event Withdrawn(address indexed account,address indexed token,uint256 amount,uint256 indexed nonce,uint256 signerEpoch)',
  'event BatchPublished(uint256 indexed batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount)',
];

type Token = 'RUBA' | 'USDT';

export class VaultChain {
  readonly config: ServerConfig;
  readonly engine: RubaEngine;
  readonly provider: JsonRpcProvider;
  readonly wallet: Wallet;
  readonly vault: Contract;
  readonly abi = new Interface(VAULT_ABI);
  private fatal: string | undefined;

  constructor(config: ServerConfig, engine: RubaEngine) {
    this.config = config;
    this.engine = engine;
    this.provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
    this.wallet = new Wallet(config.operatorPrivateKey, this.provider);
    this.vault = new Contract(config.vaultAddress, VAULT_ABI, this.wallet);
    this.engine.db.exec(`CREATE TABLE IF NOT EXISTS indexer_checkpoint (
      id INTEGER PRIMARY KEY CHECK (id = 1), block_number INTEGER NOT NULL, block_hash TEXT NOT NULL
    )`);
  }

  async initialize(): Promise<void> {
    const network = await this.provider.getNetwork();
    if (network.chainId !== this.config.chainId) throw new Error('RPC chain ID differs from CHAIN_ID');
    if (await this.provider.getCode(this.config.vaultAddress) === '0x') throw new Error('VAULT_ADDRESS has no contract');
    try {
      const [minimum, maximum] = await Promise.all([this.vault.MIN_TRADES_PER_BATCH(), this.vault.MAX_TRADES_PER_BATCH()]);
      if (BigInt(minimum) !== 4n || BigInt(maximum) !== 4n) throw new Error('Unsupported batch limits');
    } catch {
      throw new Error('This Vault does not enforce four-trade batches. Deploy a new RubaVault with MIN_TRADES_PER_BATCH=4 and MAX_TRADES_PER_BATCH=4 before starting this server; the existing immutable Vault cannot be upgraded.');
    }
    try {
      if (await this.vault.PUBLISH_BATCH_TYPEHASH() !== BATCH_PUBLICATION_TYPEHASH) throw new Error('Unsupported publication signature');
    } catch {
      throw new Error('This Vault does not support user-submitted signed batch publications. Deploy a new RubaVault with the current PUBLISH_BATCH_TYPEHASH before starting this server; the existing immutable Vault cannot be upgraded.');
    }
    const [ruba, usdt, operator] = await Promise.all([this.vault.ruba(), this.vault.usdt(), this.vault.operator()]);
    if (getAddress(ruba) !== this.config.rubaAddress || getAddress(usdt) !== this.config.usdtAddress) {
      throw new Error('Configured token addresses differ from vault tokens');
    }
    if (getAddress(operator) !== this.wallet.address) throw new Error('Configured signer is not the vault operator');
    const erc20Abi = ['function decimals() view returns (uint8)'];
    const [rubaDecimals, usdtDecimals] = await Promise.all([
      new Contract(this.config.rubaAddress, erc20Abi, this.provider).decimals(),
      new Contract(this.config.usdtAddress, erc20Abi, this.provider).decimals(),
    ]);
    const expectedMetadata = tokenMetadata(this.config);
    if (BigInt(rubaDecimals) !== BigInt(expectedMetadata.RUBA.decimals) || BigInt(usdtDecimals) !== BigInt(expectedMetadata.USDT.decimals)) throw new Error('Token decimals differ from configured market metadata');
    await this.reconcilePublishedState();
    await this.sync();
  }

  address(token: Token): string {
    return token === 'RUBA' ? this.config.rubaAddress : this.config.usdtAddress;
  }

  token(address: string): Token {
    const normalized = getAddress(address);
    if (normalized === this.config.rubaAddress) return 'RUBA';
    if (normalized === this.config.usdtAddress) return 'USDT';
    throw new Error('Unexpected token in vault event');
  }

  async latestTimestamp(): Promise<bigint> {
    // Tenderly mines on demand. After an idle period the latest mined block can
    // be old, while the next transaction executes at the pending timestamp.
    if (this.config.chainMode === 'tenderly') {
      // A pending block may have null number/hash. Read only its raw timestamp
      // instead of passing it through ethers' mined-block formatter.
      const block = await this.provider.send('eth_getBlockByNumber', ['pending', false]) as { timestamp?: unknown } | null;
      if (typeof block?.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(block.timestamp)) {
        throw new Error('Cannot read pending block timestamp');
      }
      return BigInt(block.timestamp);
    }
    const block = await this.provider.getBlock('latest');
    if (!block) throw new Error('Cannot read latest block');
    return BigInt(block.timestamp);
  }

  /** Production uses consensus finality; explicit Sepolia demo mode uses its configured depth. */
  async confirmedBlock() {
    const head = await this.provider.getBlock('latest');
    if (!head) throw new Error('Cannot read latest block');
    let number = Math.max(0, head.number - this.config.confirmations);
    if (this.config.chainId !== 31337n && this.config.chainMode !== 'tenderly' && !(this.config.chainMode === 'sepolia' && this.config.chainId === 11155111n)) {
      const finalized = await this.provider.getBlock('finalized');
      if (!finalized) throw new Error('RPC must support finalized blocks outside local Anvil');
      number = Math.min(number, finalized.number);
    }
    const block = number === head.number ? head : await this.provider.getBlock(number);
    if (!block?.hash) throw new Error('Cannot read confirmed block');
    return block;
  }

  async sync(): Promise<void> {
    if (this.fatal) throw new Error(this.fatal);
    const checkpoint = this.engine.db.prepare('SELECT block_number,block_hash FROM indexer_checkpoint WHERE id=1').get() as
      { block_number: number; block_hash: string } | undefined;
    if (checkpoint) {
      const canonical = await this.provider.getBlock(checkpoint.block_number);
      if (!canonical || canonical.hash !== checkpoint.block_hash) {
        this.fatal = 'Indexer checkpoint changed: chain reorganization; restore/reconcile the ledger before resuming';
        throw new Error(this.fatal);
      }
    }
    const target = await this.confirmedBlock();
    await this.reconcilePublishedState();
    this.engine.flushUnbatchedReceipts();
    let from = checkpoint ? checkpoint.block_number + 1 : this.config.deploymentBlock;
    const depositTopic = this.abi.getEvent('Deposited')!.topicHash;
    const withdrawalTopic = this.abi.getEvent('Withdrawn')!.topicHash;
    while (from <= target.number) {
      const to = Math.min(from + 999, target.number);
      const before = await this.provider.getBlock(to);
      if (!before?.hash) throw new Error('Cannot read indexer boundary');
      const logs = await this.provider.getLogs({
        address: this.config.vaultAddress, fromBlock: from, toBlock: to,
        topics: [[depositTopic, withdrawalTopic]],
      });
      const after = await this.provider.getBlock(to);
      if (after?.hash !== before.hash) throw new Error('Chain changed while reading vault events');
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      for (const log of logs) {
        if (log.removed) throw new Error('Removed log in confirmed vault event range');
        const parsed = this.abi.parseLog(log);
        if (!parsed) throw new Error('Unexpected vault event');
        const event = parsed.args;
        if (parsed.name === 'Deposited') {
          this.engine.recordDeposit(event.depositId, event.account, this.token(event.token), event.amount);
        } else {
          const eventId = `${this.config.chainId}:${this.config.vaultAddress}:${log.transactionHash}:${log.index}`;
          this.engine.settleWithdrawal(event.account, event.nonce, this.token(event.token), event.amount, eventId);
        }
      }
      // Each engine event is idempotent. A crash before this cursor write safely replays the range.
      this.engine.db.prepare('INSERT INTO indexer_checkpoint VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash')
        .run(to, before.hash);
      from = to + 1;
    }
  }

  private async reconcilePublishedState(): Promise<void> {
    const lastBatchId = BigInt(await this.vault.lastBatchId());
    if (lastBatchId === 0n) return;
    const local = this.engine.getBatch(lastBatchId);
    if (!local) {
      this.fatal = 'Published on-chain state has no matching server journal; restore the database before resuming';
      throw new Error(this.fatal);
    }
    this.assertSameBatch(local, await this.vault.batches(lastBatchId));
  }

  /** Registration admission is independent of market pause and never gates exit. */
  async assertWhitelisted(account: string): Promise<void> {
    if (!await this.vault.whitelist(account)) throw new Error('Account is not whitelisted');
  }

  async assertNewActivity(account: string): Promise<void> {
    const [allowed, paused] = await Promise.all([this.vault.whitelist(account), this.vault.marketPaused()]);
    if (!allowed) throw new Error('Account is not whitelisted');
    if (paused) throw new Error('Market is paused');
  }

  async withdrawalContext(token: Token) {
    const [paused, signerEpoch, operator, timestamp] = await Promise.all([
      this.vault.withdrawalsPaused(this.address(token)), this.vault.signerEpoch(), this.vault.operator(), this.latestTimestamp(),
    ]);
    if (paused) throw new Error('Withdrawals for this token are paused');
    if (getAddress(operator) !== this.wallet.address) throw new Error('Operator changed; update server signing key');
    return { signerEpoch: BigInt(signerEpoch), deadline: timestamp + this.config.withdrawalTtl };
  }

  async signWithdrawal(record: {
    account: string; token: Token; amount: bigint; nonce: bigint; deadline: bigint; signerEpoch: bigint; status: string;
  }): Promise<WithdrawalTicket> {
    if (record.status !== 'pending') throw new Error('Withdrawal is no longer pending');
    const [epoch, operator, timestamp] = await Promise.all([
      this.vault.signerEpoch(), this.vault.operator(), this.latestTimestamp(),
    ]);
    if (BigInt(epoch) !== record.signerEpoch || getAddress(operator) !== this.wallet.address) throw new Error('Withdrawal signer epoch is obsolete');
    if (record.deadline < timestamp) throw new Error('Withdrawal expired; request finalized expiry reconciliation');
    const withdrawal = {
      account: getAddress(record.account), token: this.address(record.token), amount: record.amount,
      nonce: record.nonce, deadline: record.deadline, signerEpoch: record.signerEpoch,
    };
    const signature = await this.wallet.signTypedData(withdrawalDomain(this.config.chainId, this.config.vaultAddress), WITHDRAWAL_TYPES, withdrawal);
    return { withdrawal, signature };
  }

  async expiryContext(account: string, nonce: bigint) {
    // Test environments do not advance Ethereum consensus finality. Live chains
    // must still use a finalized on-chain witness, never the server wall clock.
    const finalized = await this.provider.getBlock(this.config.chainId === 31337n || this.config.chainMode === 'tenderly' ? 'latest' : 'finalized');
    if (!finalized) throw new Error('Finalized block is unavailable');
    const nonceUsed = await this.vault.usedWithdrawalNonces(account, nonce, { blockTag: finalized.number });
    return { finalizedTimestamp: BigInt(finalized.timestamp), nonceUsed: Boolean(nonceUsed) };
  }

  async expireWithdrawal(account: string, nonce: bigint) {
    const context = await this.expiryContext(account, nonce);
    this.engine.expireWithdrawal(account, nonce, context);
    return this.engine.getWithdrawal(account, nonce);
  }

  /** Legacy method name: observes user-submitted publications and never sends a transaction. */
  async publishPendingBatches(): Promise<void> {
    if (this.fatal) throw new Error(this.fatal);
    await this.reconcilePublishedState();
    this.engine.flushUnbatchedReceipts();
    for (const pending of this.engine.listPendingBatches()) {
      const batch = pending;
      const confirmed = await this.confirmedBlock();
      const confirmedLast = BigInt(await this.vault.lastBatchId({ blockTag: confirmed.number }));
      if (confirmedLast >= batch.batchId) {
        const stored = await this.vault.batches(batch.batchId, { blockTag: confirmed.number });
        this.assertSameBatch(batch, stored);
        const publication = await this.getDisclosureBatch(batch.batchId);
        if (publication?.status !== 'published' || !publication.batch.publishedTxHash) throw new Error('Confirmed publication is unavailable');
        this.engine.markBatchPublished(batch.batchId, publication.batch.publishedTxHash);
        this.engine.setMetadata(`publication:${batch.batchId}`, publication.batch.publishedTxHash);
        continue;
      }
      const latestLast = BigInt(await this.vault.lastBatchId());
      if (latestLast >= batch.batchId) {
        this.assertSameBatch(batch, await this.vault.batches(batch.batchId));
        return; // Accepted but not finalized. Next worker pass will confirm it.
      }
      return;
    }
  }

  /** Signs only the unaccepted outbox head. The caller supplies this ticket to their wallet. */
  async getPublicationRequest(): Promise<PublicationPreparation> {
    await this.publishPendingBatches();
    const progress = this.engine.getBatchProgress();
    const pending = this.engine.listPendingBatches()[0];
    if (!pending) return { status: 'idle', request: null, progress };
    const [lastBatchId, lastTradeId, stateRoot, epoch, operator, timestamp] = await Promise.all([
      this.vault.lastBatchId(), this.vault.lastTradeId(), this.vault.stateRoot(),
      this.vault.signerEpoch(), this.vault.operator(), this.latestTimestamp(),
    ]);
    if (BigInt(lastBatchId) >= pending.batchId) {
      this.assertSameBatch(pending, await this.vault.batches(pending.batchId));
      return { status: 'waiting', request: null, progress };
    }
    if (BigInt(lastBatchId) + 1n !== pending.batchId || BigInt(lastTradeId) + 1n !== pending.firstTradeId) {
      throw new Error('Batch sequence differs from on-chain history');
    }
    if (stateRoot !== pending.previousStateRoot) throw new Error('Batch previous state root differs from on-chain history');
    if (pending.tradeCount !== 4n) throw new Error('A previously formed short batch cannot be published to the four-trade-only Vault; restore/reconcile it without rewriting historical commitments');
    if (getAddress(operator) !== this.wallet.address) throw new Error('Operator changed; update server signing key');
    const batch: BatchCommitment = {
      batchId: pending.batchId, previousStateRoot: pending.previousStateRoot, newStateRoot: pending.newStateRoot,
      receiptsRoot: pending.receiptsRoot, firstTradeId: pending.firstTradeId, tradeCount: pending.tradeCount,
    };
    const deadline = timestamp + 600n;
    const signerEpoch = BigInt(epoch);
    const signature = await this.wallet.signTypedData(batchPublicationDomain(this.config.chainId, this.config.vaultAddress), BATCH_PUBLICATION_TYPES,
      { ...batch, deadline, signerEpoch });
    return { status: 'ready', request: { chainId: this.config.chainId, vault: this.config.vaultAddress, batch, deadline, signerEpoch, signature }, progress };
  }

  /** Anonymous read-only publication lookup. No receipt preimages or signing keys leave the server. */
  async getDisclosureBatch(batchId: bigint): Promise<PublicReceiptBatch | undefined> {
    if (typeof batchId !== 'bigint' || batchId <= 0n || batchId >= (1n << 256n)) throw new Error('Invalid batch ID');
    const confirmed = await this.confirmedBlock();
    const confirmedLast = BigInt(await this.vault.lastBatchId({ blockTag: confirmed.number }));
    if (confirmedLast < batchId) {
      const local = this.engine.getBatch(batchId);
      if (!local) return undefined;
      const submittedTxHash = this.engine.getMetadata(`publication:${batchId}`);
      return {
        chainId: this.config.chainId, vault: this.config.vaultAddress, status: 'pending', source: 'server',
        batch: { batchId: local.batchId, previousStateRoot: local.previousStateRoot, newStateRoot: local.newStateRoot,
          receiptsRoot: local.receiptsRoot, firstTradeId: local.firstTradeId, tradeCount: local.tradeCount },
        ...(submittedTxHash ? { submittedTxHash } : {}),
      };
    }
    const stored = await this.vault.batches(batchId, { blockTag: confirmed.number });
    const batch = {
      batchId: BigInt(stored.batchId), previousStateRoot: String(stored.previousStateRoot), newStateRoot: String(stored.newStateRoot),
      receiptsRoot: String(stored.receiptsRoot), firstTradeId: BigInt(stored.firstTradeId), tradeCount: BigInt(stored.tradeCount),
    };
    if (batch.batchId !== batchId || batch.firstTradeId <= 0n || batch.tradeCount < 1n || batch.tradeCount > 4n
      || [batch.previousStateRoot, batch.newStateRoot, batch.receiptsRoot].some((root) => !/^0x[0-9a-fA-F]{64}$/.test(root))) {
      throw new Error('Invalid batch returned by the Vault');
    }
    const publishedTxHash = await this.batchTransactionHash(batchId, confirmed.number);
    const receipt = await this.provider.getTransactionReceipt(publishedTxHash);
    if (!receipt || receipt.status !== 1 || receipt.blockNumber > confirmed.number || !receipt.logs.some((log) => {
      if (getAddress(log.address) !== this.config.vaultAddress) return false;
      const parsed = this.abi.parseLog(log);
      if (parsed?.name !== 'BatchPublished') return false;
      return (['batchId', 'previousStateRoot', 'newStateRoot', 'receiptsRoot', 'firstTradeId', 'tradeCount'] as const)
        .every((key) => parsed.args[key] === batch[key]);
    })) throw new Error('Batch publication transaction is not confirmed or differs from the Vault');
    return {
      chainId: this.config.chainId, vault: this.config.vaultAddress, status: 'published', source: 'contract',
      batch: { ...batch, publishedTxHash }, blockNumber: receipt.blockNumber,
    };
  }

  private async batchTransactionHash(batchId: bigint, confirmedBlock: number): Promise<string> {
    const cached = this.engine.getMetadata(`publication:${batchId}`);
    if (cached) {
      const receipt = await this.provider.getTransactionReceipt(cached);
      if (receipt && receipt.status === 1 && receipt.blockNumber <= confirmedBlock) {
        const publication = receipt.logs.some((log) => {
          if (getAddress(log.address) !== this.config.vaultAddress) return false;
          const event = this.abi.parseLog(log);
          return event?.name === 'BatchPublished' && event.args.batchId === batchId;
        });
        if (publication) return cached;
      }
    }
    const topics = [this.abi.getEvent('BatchPublished')!.topicHash, zeroPadValue(toBeHex(batchId), 32)];
    // Discover the real user-submitted transaction, including publications accepted while this server was offline.
    for (let from = this.config.deploymentBlock; from <= confirmedBlock; from += 1_000) {
      const logs = await this.provider.getLogs({ address: this.config.vaultAddress, topics, fromBlock: from, toBlock: Math.min(from + 999, confirmedBlock) });
      if (logs.length > 0) return logs[0].transactionHash;
    }
    throw new Error('Confirmed batch publication event was not found');
  }

  private assertSameBatch(expected: {
    batchId: bigint; previousStateRoot: string; newStateRoot: string; receiptsRoot: string; firstTradeId: bigint; tradeCount: bigint;
  }, actual: { batchId: bigint; previousStateRoot: string; newStateRoot: string; receiptsRoot: string; firstTradeId: bigint; tradeCount: bigint }) {
    for (const key of ['batchId', 'previousStateRoot', 'newStateRoot', 'receiptsRoot', 'firstTradeId', 'tradeCount'] as const) {
      if (actual[key] !== expected[key]) {
        this.fatal = 'Published batch differs from durable server journal; reconciliation required';
        throw new Error(this.fatal);
      }
    }
  }

  close() { this.provider.destroy(); }
}
