import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, Transaction, Wallet, getAddress, type Signer } from 'ethers';
import { ArbitrageWorker } from '../arbitrage.ts';
import { RubaApi, type ActionRequest, type InternalActionOptions } from '../api.ts';
import type { ServerConfig } from '../config.ts';
import { operationHash, ZK_OPERATION_TYPES, zkOperationDomain } from '../auth.ts';
import type { MarketRuntime, MarketSettings, TransactionQueue } from '../market-types.ts';
import { ZkRubaEngine } from '../zk/engine.ts';
import { ZK_VAULT_ABI } from '../zk/chain.ts';

class Queue implements TransactionQueue {
  private current: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.current.then(operation); this.current = result.catch(() => undefined); return result;
  }
}
const wallet = new Wallet(`0x${'a11ce'.padStart(64, '0')}`);
const baseConfig = (index: number): ServerConfig => ({
  rpcUrl: 'http://127.0.0.1:1', chainId: 31337n, proofMode: 'zk',
  vaultAddress: getAddress(`0x${(0x1000n + BigInt(index)).toString(16).padStart(40, '0')}`),
  rubaAddress: '0x2000000000000000000000000000000000000002',
  usdtAddress: '0x3000000000000000000000000000000000000003',
  operatorPrivateKey: `0x${'b0b'.padStart(64, '0')}`, deploymentBlock: 0,
  confirmations: 0, withdrawalTtl: 600n, dbPath: ':memory:', host: '127.0.0.1', port: 3001, syncIntervalMs: 1000,
});
const initialSettings = (ids: string[]): MarketSettings => ({ revision: 1n,
  prices: { RUBA: '1', USDT: '1', WETH: '3000', WBTC: '90000' },
  arbitrage: Object.fromEntries(ids.map((id) => [id, { enabled: true, delaySeconds: 5, maxTradeBps: 2000, minDeviationBps: 40 }])),
});

async function fixture(id = 'ruba-usdt', index = 1) {
  const config = baseConfig(index); const engine = new ZkRubaEngine(config, 123456n + BigInt(index));
  let salt = 1000n;
  const makeRequest = async (operation: ActionRequest['operation']): Promise<ActionRequest> => {
    const prepared = engine.prepareAuthorization(wallet.address, operation, ++salt);
    return { intent: { account: wallet.address, actionHash: operationHash(operation), nonce: engine.getActionNonce(wallet.address).toString(), deadline: '601' },
      operation, signature: await wallet.signTypedData(zkOperationDomain(config.chainId, config.vaultAddress), ZK_OPERATION_TYPES, { commitment: prepared.commitment }),
      zk: { commitment: prepared.commitment.toString(), nonce: prepared.nonce.toString(), salt: salt.toString() } };
  };
  let acceptedVersion = 0n, acceptedRoot = engine.getGenesisStateRoot();
  let ready = false;
  const chain = {
    latestTimestamp: async () => 1n,
    sync: async () => undefined,
    assertWhitelisted: async () => undefined,
    assertNewActivity: async () => undefined,
    publishPendingBatches: async () => undefined,
    getDisclosureBatch: async () => undefined,
    zkVault: { stateVersion: async () => acceptedVersion },
    vault: { stateRoot: async () => acceptedRoot },
    getPublicationRequest: async () => {
      if (!ready) return { status: 'idle', request: null, progress: engine.getBatchProgress() };
      const head = engine.getPendingTransition();
      if (!head) return { status: 'idle', request: null, progress: engine.getBatchProgress() };
      return { status: 'ready', progress: engine.getBatchProgress(), request: {
        kind: 'zk', authorizationMode: 'proof-only', chainId: config.chainId, vault: config.vaultAddress,
        publicSignals: head.publicSignals, operations: head.metadata.map((op) => ({ ...op, owner: getAddress(`0x${BigInt(op.owner).toString(16).padStart(40, '0')}`) })),
        accountDA: head.accountDA.map((op) => ({ ...op, owner: getAddress(`0x${BigInt(op.owner).toString(16).padStart(40, '0')}`) })), poolDA: head.poolDA,
        proof: { a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] },
      } };
    },
  };
  const api = new RubaApi(engine, chain as never, config);
  await api.execute(await makeRequest({ kind: 'zkRegister', slot: '0', recoveryKey: '555' }));
  for (const [eventId, token, amount] of [[1n, 'RUBA', 5000n * 10n ** 18n], [2n, 'USDT', 5000n * 10n ** 6n]] as const) {
    engine.applyInboxRecord({ eventId, kind: 2, owner: wallet.address, token, amount, reference: eventId, legacyEventId: `deposit-${eventId}` });
  }
  await api.execute(await makeRequest({ kind: 'addLiquidity', rubaDesired: String(1000n * 10n ** 18n), usdtDesired: String(1210n * 10n ** 6n), rubaMin: '0', usdtMin: '0' }));
  const market = { id, label: id, config, engine, chain, api } as unknown as MarketRuntime;
  return { market, makeRequest, engine, api, chain,
    setReady(value: boolean) { ready = value; },
    accept(version: bigint, root: bigint) { acceptedVersion = version; acceptedRoot = root; },
    close: () => engine.close(),
  };
}
const noTransactions = { getAddress: async () => wallet.address, provider: null } as unknown as Signer;
const receipts = (f: Awaited<ReturnType<typeof fixture>>) => f.engine.journal.operations().filter((op) => op.kind === 3);

test('worker fills only remaining strict-four slots with its own real correcting swaps and never exposes private plan amounts', async () => {
  for (const collected of [0, 1, 2, 3]) {
    const f = await fixture(); const settings = initialSettings([f.market.id]);
    try {
      for (let i = 0; i < collected; ++i) await f.api.execute(await f.makeRequest({ kind: 'swap', tokenIn: 'USDT', amountIn: '1000000', minOut: '0' }));
      const worker = new ArbitrageWorker({ markets: [f.market], botSigner: wallet, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() });
      await worker.runOnce(0);
      assert.equal(worker.getStatus(f.market.id).status, 'scheduled'); assert.equal(receipts(f).length, collected);
      await worker.runOnce(4999); assert.equal(receipts(f).length, collected);
      await worker.runOnce(5000);
      assert.equal(receipts(f).length, 4);
      const botSwaps = receipts(f).slice(collected);
      assert.equal(botSwaps.length, 4 - collected);
      for (const op of botSwaps) { assert.equal(op.owner, BigInt(wallet.address)); assert.equal(op.params[0], 0n); assert(op.params[1] > 0n); assert(op.receipt!.amountOut > 0n); }
      assert.equal(f.engine.getBatchProgress().collected, 0);
      assert.equal(f.engine.listTransitions().filter((value) => value.mode === 1).length, 1);
      const status = worker.getStatus(f.market.id);
      assert.deepEqual(Object.keys(status).sort(), ['message', 'nextRunAt', 'status']);
      assert(!JSON.stringify(status).includes('amount'));
      await worker.runOnce(6000); assert.equal(receipts(f).length, 4);
    } finally { f.close(); }
  }
});

test('disable during signing rolls back HTTP nonce, economic action and durable step marker', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]);
  const nonce = f.engine.getActionNonce(wallet.address);
  const signer = { getAddress: async () => wallet.address,
    signTypedData: async (...args: Parameters<typeof wallet.signTypedData>) => {
      settings.arbitrage[f.market.id].enabled = false; settings.revision++;
      return wallet.signTypedData(...args);
    } } as unknown as Signer;
  try {
    const worker = new ArbitrageWorker({ markets: [f.market], botSigner: signer, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() });
    await worker.runOnce(0); await worker.runOnce(5000);
    assert.equal(receipts(f).length, 0); assert.equal(f.engine.getActionNonce(wallet.address), nonce);
    assert.equal(worker.getStatus(f.market.id).status, 'disabled');
    assert.equal(f.engine.db.prepare("SELECT key FROM engine_metadata WHERE key LIKE 'arb:0x%'").all().length, 0);
  } finally { f.close(); }
});

test('restart after committed action response loss resumes remaining signed steps without repeating any commitment', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]);
  const original = f.api.execute.bind(f.api); let loseOnce = true;
  f.api.execute = async (request, internal) => {
    const result = await original(request, internal);
    if (internal && loseOnce) { loseOnce = false; throw new Error('Lost response after durable commit'); }
    return result;
  };
  const deps = { markets: [f.market], botSigner: wallet, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() };
  try {
    const first = new ArbitrageWorker(deps); await first.runOnce(0); await first.runOnce(5000);
    assert.equal(receipts(f).length, 1);
    const restarted = new ArbitrageWorker(deps); await restarted.runOnce(5001);
    assert.equal(receipts(f).length, 4);
    assert.equal(new Set(receipts(f).map((op) => op.metadata.commitment.toString())).size, 4);
    const markers = f.engine.db.prepare("SELECT value FROM engine_metadata WHERE key LIKE 'arb:0x%'").all();
    assert.equal(markers.length, 4);
  } finally { f.close(); }
});

test('failed onCommit metadata and swap rollback together; retry makes one successful trade per step', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]);
  const original = f.api.execute.bind(f.api); let rejectOnce = true;
  f.api.execute = (request, internal) => {
    if (!internal || !rejectOnce) return original(request, internal);
    const hooks: InternalActionOptions = { ...internal, onCommit(result) { internal.onCommit?.(result); rejectOnce = false; throw new Error('Crash inside SQL transaction'); } };
    return original(request, hooks);
  };
  const deps = { markets: [f.market], botSigner: wallet, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() };
  try {
    const worker = new ArbitrageWorker(deps); await worker.runOnce(0); await worker.runOnce(5000);
    assert.equal(receipts(f).length, 0);
    assert.equal(f.engine.db.prepare("SELECT key FROM engine_metadata WHERE key LIKE 'arb:0x%'").all().length, 0);
    const restarted = new ArbitrageWorker(deps); await restarted.runOnce(5001);
    assert.equal(receipts(f).length, 4);
  } finally { f.close(); }
});

test('restart recovers a completed step from its immutable commitment when auxiliary cursor and marker are missing', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]);
  const original = f.api.execute.bind(f.api); let loseOnce = true;
  f.api.execute = async (request, internal) => {
    const result = await original(request, internal);
    if (internal && loseOnce) { loseOnce = false; throw new Error('Lost committed response'); }
    return result;
  };
  const deps = { markets: [f.market], botSigner: wallet, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() };
  try {
    const first = new ArbitrageWorker(deps); await first.runOnce(0); await first.runOnce(5000);
    assert.equal(receipts(f).length, 1);
    const state = JSON.parse(f.engine.getMetadata('arb:state:v1')!);
    const step = state.plan.steps[0]; state.plan.next = 0; state.plan.expectedRoot = step.beforeRoot;
    f.engine.setMetadata('arb:state:v1', JSON.stringify(state));
    f.engine.db.prepare('DELETE FROM engine_metadata WHERE key=?').run(`arb:${state.plan.id}:${step.id}`);
    const restarted = new ArbitrageWorker(deps); await restarted.runOnce(5001);
    assert.equal(receipts(f).length, 4);
    assert.equal(new Set(receipts(f).map((op) => op.metadata.commitment.toString())).size, 4);
    assert(f.engine.getMetadata(`arb:${state.plan.id}:${step.id}`));
  } finally { f.close(); }
});

test('intervening user activity and reference revision debounce unfinished plans without reusing stale math', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]);
  const original = f.api.execute.bind(f.api); let interfereOnce = true;
  f.api.execute = async (request, internal) => {
    const result = await original(request, internal);
    if (internal && interfereOnce) {
      interfereOnce = false;
      await original(await f.makeRequest({ kind: 'swap', tokenIn: 'USDT', amountIn: '1000000', minOut: '0' }));
    }
    return result;
  };
  try {
    const worker = new ArbitrageWorker({ markets: [f.market], botSigner: wallet, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() });
    await worker.runOnce(0); await worker.runOnce(5000);
    assert.equal(receipts(f).length, 2); assert.equal(worker.getStatus(f.market.id).status, 'scheduled');
    settings.prices.RUBA = '1.01'; settings.revision++;
    await worker.runOnce(9000); assert.equal(receipts(f).length, 2);
    assert.equal(worker.getStatus(f.market.id).nextRunAt, 14000);
    await worker.runOnce(13999); assert.equal(receipts(f).length, 2);
    await worker.runOnce(14000); assert.equal(receipts(f).length, 4);
  } finally { f.close(); }
});

test('insufficient correcting volume stays waiting and disabled worker never starts a swap', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]); settings.prices.RUBA = '1.21';
  try {
    const worker = new ArbitrageWorker({ markets: [f.market], botSigner: wallet, transactionSigner: noTransactions, settings: () => settings, transactionQueue: new Queue() });
    await worker.runOnce(0); await worker.runOnce(5000);
    assert.equal(receipts(f).length, 0); assert.equal(worker.getStatus(f.market.id).status, 'waiting');
    settings.arbitrage[f.market.id].enabled = false; settings.prices.RUBA = '1'; settings.revision++;
    await worker.runOnce(50000); assert.equal(receipts(f).length, 0); assert.equal(worker.getStatus(f.market.id).status, 'disabled');
  } finally { f.close(); }
});

test('disabled market maker performs no synchronization, proof preparation or broadcast and enabling starts the delay', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]); settings.arbitrage[f.market.id].enabled = false;
  let syncs = 0, preparations = 0, broadcasts = 0;
  const originalSync = f.chain.sync; const originalPrepare = f.api.preparePublication.bind(f.api);
  f.chain.sync = async () => { syncs++; return originalSync(); };
  f.api.preparePublication = async () => { preparations++; return originalPrepare(); };
  const signer = { getAddress: async () => wallet.address, provider: {
    broadcastTransaction: async () => { broadcasts++; throw new Error('Disabled worker must not broadcast'); },
  } } as unknown as Signer;
  try {
    const worker = new ArbitrageWorker({ markets: [f.market], botSigner: wallet, transactionSigner: signer, settings: () => settings, transactionQueue: new Queue() });
    await worker.runOnce(0); await worker.runOnce(1000);
    assert.deepEqual([syncs, preparations, broadcasts], [0, 0, 0]);
    assert.equal(receipts(f).length, 0); assert.equal(worker.getStatus(f.market.id).status, 'disabled');
    settings.arbitrage[f.market.id].enabled = true; settings.revision++;
    await worker.runOnce(2000);
    assert.equal(syncs, 1); assert.equal(preparations, 1); assert.equal(broadcasts, 0);
    assert.equal(worker.getStatus(f.market.id).status, 'scheduled');
    assert.equal(worker.getStatus(f.market.id).nextRunAt, 7000);
    settings.arbitrage[f.market.id].enabled = false; settings.revision++;
    await worker.runOnce(8000);
    assert.deepEqual([syncs, preparations, broadcasts], [1, 1, 0]); assert.equal(receipts(f).length, 0);
  } finally { f.close(); }
});

test('shared publication queue persists exact signed transactions before broadcast and never duplicates an unknown-response nonce across pools', async () => {
  const fixtures = [await fixture('ruba-usdt', 11), await fixture('ruba-weth', 12)];
  const settings = initialSettings(fixtures.map((f) => f.market.id));
  const calls: string[] = []; const known = new Map<string, ReturnType<typeof Transaction.from>>(); const mined = new Set<string>(); const failed = new Set<string>();
  const iface = new Interface(ZK_VAULT_ABI); let throwResponse = true;
  const provider = {
    getNetwork: async () => ({ chainId: 31337n }),
    getTransactionCount: async (_sender: string, tag: string) => tag === 'latest' ? mined.size : known.size,
    getTransactionReceipt: async (hash: string) => mined.has(hash) ? { status: failed.has(hash) ? 0 : 1, blockNumber: 1, blockHash: '0xabc' } : null,
    getTransaction: async (hash: string) => known.get(hash) ?? null,
    getBlock: async () => ({ hash: '0xabc' }),
    broadcastTransaction: async (raw: string) => {
      const tx = Transaction.from(raw); calls.push(tx.hash!); known.set(tx.hash!, tx);
      const match = fixtures.find((f) => getAddress(f.market.config.vaultAddress) === tx.to)!;
      assert(match.engine.getMetadata('arb:publication:v1'), 'raw intent must be durable before broadcast');
      const decoded = iface.parseTransaction({ data: tx.data }); assert.equal(decoded?.name, 'publishProvenTransition');
      if (throwResponse) { throwResponse = false; throw new Error('Lost RPC response containing https://secret-rpc.invalid'); }
      return { hash: tx.hash };
    },
  };
  const signer = { provider, getAddress: async () => wallet.address,
    populateTransaction: async (tx: object) => ({ ...tx, type: 2, gasLimit: 25_000_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    signTransaction: (tx: Parameters<typeof wallet.signTransaction>[0]) => wallet.signTransaction(tx),
  } as unknown as Signer;
  for (const f of fixtures) {
    f.setReady(true);
    f.chain.publishPendingBatches = async () => {
      for (const [hash, tx] of known) if (mined.has(hash) && !failed.has(hash) && tx.to === getAddress(f.market.config.vaultAddress)) {
        const decoded = iface.parseTransaction({ data: tx.data })!; const signals = decoded.args.publicSignals;
        f.accept(BigInt(signals[1]), BigInt(signals[4]));
        if (f.engine.getAcceptedCheckpoint().stateVersion < BigInt(signals[1])) f.engine.markTransitionAccepted(BigInt(signals[1]), hash, 1);
      }
    };
  }
  const deps = { markets: fixtures.map((f) => f.market), botSigner: wallet, transactionSigner: signer, settings: () => settings, transactionQueue: new Queue() };
  try {
    const worker = new ArbitrageWorker(deps); await worker.runOnce(0);
    assert.equal(calls.length, 1); assert.equal(known.values().next().value!.nonce, 0);
    assert(!JSON.stringify(worker.getStatus(fixtures[0].market.id)).includes('secret-rpc'));
    const restarted = new ArbitrageWorker(deps); await restarted.runOnce(1);
    assert.equal(calls.length, 1, 'known pending transaction must not be signed/broadcast again');
    mined.add(calls[0]); await restarted.runOnce(2);
    assert.equal(calls.length, 2); assert.equal(new Set(calls).size, 2);
    assert.deepEqual([...known.values()].map((tx) => tx.nonce), [0, 1]);
    mined.add(calls[1]); await restarted.runOnce(3);
    assert.equal(calls.length, 2); assert.equal(fixtures[0].engine.getAcceptedCheckpoint().stateVersion, 1n);
    assert.equal(fixtures[1].engine.getAcceptedCheckpoint().stateVersion, 1n);
    const f = fixtures[1];
    await f.api.execute(await f.makeRequest({ kind: 'addLiquidity', rubaDesired: String(10n ** 18n), usdtDesired: '1210000', rubaMin: '0', usdtMin: '0' }));
    await restarted.runOnce(4); assert.equal(calls.length, 3);
    failed.add(calls[2]); mined.add(calls[2]);
    await restarted.runOnce(5);
    await restarted.runOnce(6); await restarted.runOnce(7);
    assert.equal(calls.length, 3, 'a reverted head must not spend another nonce on every poll');
    assert.equal(restarted.getStatus(f.market.id).status, 'waiting');
    settings.revision++;
    await restarted.runOnce(8);
    assert.equal(calls.length, 4, 'an explicit settings revision may retry the blocked publication');
    assert.equal(known.get(calls[3])!.nonce, 3);
  } finally { for (const f of fixtures) f.close(); }
});

test('unknown prepared transaction with an occupied pending nonce blocks replacement and all new publication attempts', async () => {
  const f = await fixture(); const settings = initialSettings([f.market.id]); f.setReady(true);
  try {
    const preparation = await f.api.preparePublication(); assert.equal(preparation.status, 'ready');
    const request = preparation.request!; assert.equal(request.kind, 'zk');
    const zk = request as import('../zk/types.ts').ZkSignedPublication;
    const data = new Interface(ZK_VAULT_ABI).encodeFunctionData('publishProvenTransition', [zk.publicSignals,
      zk.operations.map((op) => [op.kind, op.slot, op.owner, op.commitment, op.eventId, op.token, op.amount, op.reference, op.signature]), zk.accountDA, zk.poolDA, zk.proof]);
    const raw = await wallet.signTransaction({ to: f.market.config.vaultAddress, data, value: 0n, nonce: 0,
      chainId: 31337n, type: 2, gasLimit: 25_000_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    const tx = Transaction.from(raw);
    const encoded = JSON.stringify({ version: 1, marketId: f.market.id, vault: f.market.config.vaultAddress,
      sender: wallet.address, chainId: '31337', stateVersion: zk.publicSignals[1].toString(),
      previousRoot: zk.publicSignals[3].toString(), newRoot: zk.publicSignals[4].toString(), nonce: 0, hash: tx.hash, raw, preparedAt: 0 });
    f.engine.setMetadata('arb:publication:v1', encoded);
    let broadcasts = 0;
    const signer = { getAddress: async () => wallet.address, provider: {
      getTransactionReceipt: async () => null, getTransaction: async () => null,
      getTransactionCount: async (_account: string, tag: string) => tag === 'pending' ? 1 : 0,
      broadcastTransaction: async () => { broadcasts++; throw new Error('Must not replace an unrelated pending nonce'); },
    } } as unknown as Signer;
    const worker = new ArbitrageWorker({ markets: [f.market], botSigner: wallet, transactionSigner: signer, settings: () => settings, transactionQueue: new Queue() });
    await worker.runOnce(0); await worker.runOnce(10000);
    assert.equal(broadcasts, 0); assert.equal(receipts(f).length, 0);
    assert.equal(f.engine.getMetadata('arb:publication:v1'), encoded);
    assert.equal(worker.getStatus(f.market.id).status, 'error');
  } finally { f.close(); }
});
