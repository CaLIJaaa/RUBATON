import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Contract, ContractFactory, NonceManager, getAddress, keccak256, parseUnits, toUtf8Bytes } from 'ethers';
import type { HDNodeWallet, JsonRpcProvider, Signer } from 'ethers';
import { RubaApi } from '../server/api.ts';
import type { Operation, ZkOperation } from '../server/api.ts';
import { ACTION_TYPES, ZK_OPERATION_TYPES, actionDomain, operationHash, zkOperationDomain } from '../server/auth.ts';
import type { ServerConfig } from '../server/config.ts';
import { ZkRubaEngine } from '../server/zk/engine.ts';
import { ZkVaultChain, ZK_VAULT_ABI } from '../server/zk/chain.ts';
import type { ZkSignedPublication } from '../server/zk/types.ts';
import { FIELD, buildAccountTree, decryptAccount, emptyPool, hashAccount, hashDaDigest, hashPool, hashState, keyCommit, poseidon2, randomField, verifyAccountProof } from '../zk/crypto.js';
import { deployArtifact, startLocalChain } from './local-deploy.ts';

export type LocalChain = Awaited<ReturnType<typeof startLocalChain>>;

/** Must remain byte-for-byte compatible with ui/client.js recoveryKeyMessage. */
export function zkRecoveryKeyMessage(config: Pick<ServerConfig, 'chainId' | 'vaultAddress'>, owner: string): string {
  return `RUBA recovery key v2\nChain ID: ${config.chainId}\nVault: ${getAddress(config.vaultAddress)}\nOwner: ${getAddress(owner)}`;
}
export async function deriveOwnerRecoveryKey(config: Pick<ServerConfig, 'chainId' | 'vaultAddress'>, signer: Signer): Promise<bigint> {
  return BigInt(keccak256(await signer.signMessage(zkRecoveryKeyMessage(config, await signer.getAddress())))) % FIELD;
}

/** Deploy only into the disposable chain started by startLocalChain. Never use a public RPC. */
export async function deployZkLocalFixture(local: LocalChain, artifactsDir = resolve('zk/artifacts')) {
  if ((await local.provider.getNetwork()).chainId !== 31337n) throw new Error('ZK local fixture requires isolated Anvil chain 31337');
  const [admin, operator, lp, trader] = local.wallets;
  const adminTransactions = new NonceManager(admin);
  const derivedPoolKey = BigInt(keccak256(toUtf8Bytes(`RUBA ZK pool recovery v2:${operator.privateKey}`))) % FIELD;
  const poolRecoveryKey = derivedPoolKey === 0n ? 1n : derivedPoolKey;
  const poseidonArtifact = JSON.parse(await readFile(join(artifactsDir, 'poseidon2.json'), 'utf8'));
  const ruba = await deployArtifact('MockERC20', 'MockERC20', adminTransactions, ['Mock RUBA', 'RUBA', 18]) as Contract;
  const usdt = await deployArtifact('MockUSDT', 'MockUSDT', adminTransactions) as Contract;
  const verifier = await deployArtifact('Groth16Verifier', 'Groth16Verifier', adminTransactions) as Contract;
  const poseidon = await new ContractFactory(poseidonArtifact.abi, poseidonArtifact.bytecode, adminTransactions).deploy();
  await poseidon.waitForDeployment();
  const vault = await deployArtifact('ZkRubaVault', 'ZkRubaVault', adminTransactions, [
    await ruba.getAddress(), await usdt.getAddress(), admin.address, operator.address,
    await verifier.getAddress(), await poseidon.getAddress(), keyCommit(poolRecoveryKey),
  ]) as Contract;
  const deploymentBlock = (await vault.deploymentTransaction()!.wait())!.blockNumber;
  return { admin, operator, lp, trader, adminTransactions, ruba, usdt, vault, verifier, poseidon, deploymentBlock, poolRecoveryKey };
}
export type ZkLocalFixture = Awaited<ReturnType<typeof deployZkLocalFixture>>;

export function zkLocalConfig(local: LocalChain, fixture: ZkLocalFixture, dbPath: string, port = 3001): ServerConfig {
  return {
    rpcUrl: local.rpcUrl, chainId: 31337n,
    vaultAddress: fixture.vault.target as string, rubaAddress: fixture.ruba.target as string, usdtAddress: fixture.usdt.target as string,
    operatorPrivateKey: fixture.operator.privateKey, deploymentBlock: fixture.deploymentBlock, confirmations: 0,
    withdrawalTtl: 900n, dbPath, host: '127.0.0.1', port, syncIntervalMs: 2000,
    proofMode: 'zk', zkArtifactsDir: resolve('zk/artifacts'),
  };
}

export async function signedZkLocalRequest(engine: ZkRubaEngine, chain: ZkVaultChain, signer: Signer, operation: Operation | ZkOperation) {
  const account = getAddress(await signer.getAddress());
  const intent = { account, actionHash: operationHash(operation), nonce: engine.getActionNonce(account).toString(), deadline: (await chain.latestTimestamp() + 600n).toString() };
  if (['zkRegister', 'swap', 'addLiquidity', 'removeLiquidity', 'withdraw'].includes(operation.kind)) {
    const salt = randomField();
    const authorization = engine.prepareAuthorization(account, operation, salt);
    const zk = { commitment: authorization.commitment.toString(), nonce: authorization.nonce.toString(), salt: salt.toString() };
    const signature = await signer.signTypedData(zkOperationDomain(chain.config.chainId, chain.config.vaultAddress), ZK_OPERATION_TYPES, { commitment: zk.commitment });
    return { intent, operation, signature, zk };
  }
  return { intent, operation, signature: await signer.signTypedData(actionDomain(chain.config.chainId, chain.config.vaultAddress), ACTION_TYPES, intent) };
}

export async function actZkLocal(api: RubaApi, engine: ZkRubaEngine, chain: ZkVaultChain, signer: Signer, operation: Operation | ZkOperation): Promise<any> {
  return api.execute(await signedZkLocalRequest(engine, chain, signer, operation));
}

export async function registerZkLocal(api: RubaApi, engine: ZkRubaEngine, chain: ZkVaultChain, signer: Signer): Promise<bigint> {
  const owner = getAddress(await signer.getAddress());
  const key = await deriveOwnerRecoveryKey(chain.config, signer);
  const state = engine.getZkAccount(owner);
  if (!state.registered) await actZkLocal(api, engine, chain, signer, { kind: 'zkRegister', recoveryKey: key.toString(), slot: state.slot.toString() });
  else assert.equal(state.account[7], keyCommit(key));
  return key;
}

/** Artifact ABI names referenceId in Solidity; the server's semantic schema uses reference. */
export function zkPublicationArguments(ticket: ZkSignedPublication) {
  return [ticket.publicSignals, ticket.operations.map((operation) => ({ ...operation, referenceId: operation.reference })), ticket.accountDA, ticket.poolDA, ticket.proof] as const;
}

export async function publishAllZkLocal(api: RubaApi, chain: ZkVaultChain, vault: Contract, payer: Signer, log: (message: string) => void = () => {}) {
  const published = [] as { ticket: ZkSignedPublication; transactionHash: string; gasUsed: bigint; from: string }[];
  for (let count = 0; count < 32; count++) {
    await api.sync();
    const prepared = await chain.getPublicationRequest();
    if (prepared.status === 'idle') return published;
    if (prepared.status !== 'ready' || prepared.request?.kind !== 'zk') throw new Error(`Local ZK publication is not ready: ${prepared.status}`);
    const ticket = prepared.request;
    log(`Доказательство перехода №${ticket.publicSignals[1]} готово; пользователь отправляет транзакцию.`);
    const transaction = await (vault.connect(payer) as Contract).publishProvenTransition(...zkPublicationArguments(ticket), { gasLimit: 25_000_000n });
    const receipt = await transaction.wait();
    assert.ok(receipt && receipt.status === 1);
    assert.equal(getAddress(receipt.from), getAddress(await payer.getAddress()));
    published.push({ ticket, transactionHash: transaction.hash, gasUsed: receipt.gasUsed, from: receipt.from });
    await api.sync();
  }
  throw new Error('Too many queued local ZK transitions');
}

export async function seedZkLocalMarket(local: LocalChain, fixture: ZkLocalFixture, engine: ZkRubaEngine, chain: ZkVaultChain, api: RubaApi, log: (message: string) => void = () => {}) {
  const { lp, trader, ruba, usdt, vault, adminTransactions, operator } = fixture;
  const adminVault = vault.connect(adminTransactions) as Contract;
  for (const owner of [lp.address, trader.address]) {
    await (await adminVault.setWhitelist(owner, true)).wait();
    await (await ruba.mint(owner, parseUnits('10000', 18))).wait();
    await (await usdt.mint(owner, parseUnits('10000', 6))).wait();
  }
  await local.provider.send('anvil_setBalance', [operator.address, '0x0']);
  await registerZkLocal(api, engine, chain, lp);
  await registerZkLocal(api, engine, chain, trader);
  const lpTransactions = new NonceManager(lp);
  log('Подтверждаю ZK-регистрации до первого ввода токенов…');
  const registrationPublications = await publishAllZkLocal(api, chain, vault, lpTransactions, log);
  const rubaSeed = parseUnits('1000', 18), usdtSeed = parseUnits('1000', 6);
  for (const [token, amount] of [[ruba, rubaSeed], [usdt, usdtSeed]] as const) {
    await (await (token.connect(lpTransactions) as Contract).approve(vault.target, amount)).wait();
    await (await (vault.connect(lpTransactions) as Contract).deposit(token.target, amount)).wait();
  }
  await api.sync();
  await actZkLocal(api, engine, chain, lp, { kind: 'addLiquidity', rubaDesired: rubaSeed.toString(), usdtDesired: usdtSeed.toString(), rubaMin: rubaSeed.toString(), usdtMin: usdtSeed.toString() });
  log('Создаю настоящее ZK-доказательство вводов и начальной ликвидности…');
  const publications = await publishAllZkLocal(api, chain, vault, lpTransactions, log);
  assert.equal(engine.getAcceptedCheckpoint().root, BigInt(await vault.stateRoot()));
  assert.equal(await local.provider.getBalance(operator.address), 0n);
  return { lpTransactions, publications: [...registrationPublications, ...publications] };
}

/** Rebuild a leaf/path solely from public transaction calldata and an owner-held key. */
export async function reconstructZkOwnerFromChain(provider: JsonRpcProvider, vaultAddress: string, owner: string, recoveryKey: bigint, deploymentBlock: number) {
  const vault = new Contract(vaultAddress, ZK_VAULT_ABI, provider);
  const latest = BigInt(await vault.stateVersion());
  const leaves = [...buildAccountTree().leaves];
  let account: bigint[] | undefined, slot: number | undefined;
  let poolHash = hashPool(emptyPool());
  let inboxCursor = 0n, nextTradeId = 1n;
  const domain = BigInt(await vault.domain()), poolKey = BigInt(await vault.poolKeyCommit());
  const end = await provider.getBlockNumber();
  const logs = await vault.queryFilter(vault.filters.ZkTransitionPublished(), deploymentBlock, end);
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  let version = 0n;
  for (const log of logs) {
    const transaction = await provider.getTransaction(log.transactionHash);
    if (!transaction || getAddress(transaction.to!) !== getAddress(vaultAddress)) throw new Error('Missing ZK publication calldata');
    const decoded = vault.interface.parseTransaction({ data: transaction.data });
    if (decoded?.name !== 'publishProvenTransition' && decoded?.name !== 'publishProvenTransitionAndWithdraw') throw new Error('Unexpected ZK publication transaction');
    const signals = [...decoded.args[0]].map(BigInt);
    if (signals[1] !== ++version) throw new Error('ZK data availability history is incomplete');
    const data = [...decoded.args[2]].map((item) => ({ kind: BigInt(item.kind), slot: BigInt(item.slot), owner: BigInt(item.owner), newLeaf: BigInt(item.newLeaf), ciphertext: [...item.ciphertext].map(BigInt) }));
    const poolData = decoded.args[3];
    if (hashDaDigest(domain, version, data, BigInt(poolData.poolHash), [...poolData.poolCiphertext].map(BigInt)) !== signals[11]) throw new Error('ZK data availability digest differs from accepted calldata');
    for (const record of data) {
      if (record.kind === 0n) continue;
      leaves[Number(record.slot)] = record.newLeaf;
      if (record.owner === BigInt(owner)) {
        slot = Number(record.slot);
        const plain = decryptAccount(recoveryKey, record.newLeaf, record.ciphertext);
        account = [BigInt(owner), ...plain.slice(0, 6), keyCommit(recoveryKey), plain[6]];
        if (hashAccount(slot, account) !== record.newLeaf) throw new Error('Recovery key does not match the published account leaf');
      }
    }
    poolHash = BigInt(poolData.poolHash); inboxCursor = signals[6]; nextTradeId = signals[8];
  }
  if (version !== latest || slot === undefined || !account) throw new Error('Published owner account was not found');
  const path: bigint[] = [];
  let index = slot, level = leaves;
  while (level.length > 1) {
    path.push(level[index ^ 1]);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon2(level[i], level[i + 1]));
    level = next; index >>= 1;
  }
  const stateRoot = hashState(domain, level[0], poolHash, inboxCursor, nextTradeId, poolKey);
  assert.equal(stateRoot, BigInt(await vault.stateRoot()));
  assert.equal(verifyAccountProof(slot, hashAccount(slot, account), path, level[0]), true);
  return { owner: getAddress(owner), slot, account, path, leaf: hashAccount(slot, account), accountsRoot: level[0], poolHash, stateRoot, stateVersion: latest, inboxCursor, nextTradeId, poolKeyCommit: poolKey };
}

export async function createZkLocalRuntime(directory: string, port = 3001) {
  const local = await startLocalChain();
  let engine: ZkRubaEngine | undefined, chain: ZkVaultChain | undefined;
  try {
    const fixture = await deployZkLocalFixture(local);
    const config = zkLocalConfig(local, fixture, join(directory, 'ledger.sqlite'), port);
    engine = new ZkRubaEngine(config, fixture.poolRecoveryKey);
    chain = new ZkVaultChain(config, engine);
    await chain.initialize();
    const api = new RubaApi(engine, chain, config);
    return { local, fixture, config, engine, chain, api };
  } catch (error) {
    await chain?.prover.close(); chain?.provider.destroy(); engine?.close(); await local.close();
    throw error;
  }
}
