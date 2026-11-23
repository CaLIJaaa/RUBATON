import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Interface, Wallet, verifyTypedData } from 'ethers';
import { VaultChain, VAULT_ABI } from '../chain.ts';
import { BATCH_PUBLICATION_TYPES, batchPublicationDomain } from '../auth.ts';
import { RubaEngine } from '../engine.ts';
import type { ServerConfig } from '../config.ts';

const account = new Wallet('0x' + '11'.repeat(32)).address;
const vault = '0x0000000000000000000000000000000000000001';
const ruba = '0x0000000000000000000000000000000000000002';
const usdt = '0x0000000000000000000000000000000000000003';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function fixture(chainId = 31337n, chainMode?: ServerConfig['chainMode']) {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-indexer-'));
  const config: ServerConfig = {
    rpcUrl: chainMode === 'tenderly' ? 'https://virtual.mainnet.eu.rpc.tenderly.co/test' : 'http://127.0.0.1:8545',
    chainId, chainMode, vaultAddress: vault, rubaAddress: ruba, usdtAddress: usdt,
    operatorPrivateKey: '0x' + '33'.repeat(32), deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n,
    dbPath: join(directory, 'ledger.sqlite'), host: '127.0.0.1', port: 3001, syncIntervalMs: 2000,
  };
  const engine = new RubaEngine(config);
  engine.db.exec('CREATE TABLE indexer_checkpoint (id INTEGER PRIMARY KEY,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL)');
  const abi = new Interface(VAULT_ABI);
  const state = { changed: false, head: 20, finalized: 10, pendingTimestamp: 100_000, logs: [] as object[], reads: [] as unknown[], blockReads: [] as (string | number)[], rpcReads: [] as { method: string; params: unknown[] }[] };
  const provider = {
    async getBlock(tag: string | number) {
      state.blockReads.push(tag);
      if (tag === 'pending') throw new Error('ethers pending block formatter rejects null block numbers');
      const number = tag === 'latest' ? state.head : tag === 'finalized' ? state.finalized : Number(tag);
      return { number, timestamp: 1000 + number, hash: hash(number + (state.changed ? 1000 : 0)) };
    },
    async send(method: string, params: unknown[]) {
      state.rpcReads.push({ method, params });
      assert.equal(method, 'eth_getBlockByNumber');
      assert.deepEqual(params, ['pending', false]);
      return { number: null, hash: null, timestamp: `0x${state.pendingTimestamp.toString(16)}` };
    },
    async getLogs(filter: { fromBlock: number; toBlock: number }) {
      state.reads.push(filter);
      return state.logs.filter((log) => { const n = (log as {blockNumber: number}).blockNumber; return n >= filter.fromBlock && n <= filter.toBlock; });
    },
  };
  // No sockets or RPC requests: exercise the production indexer with deterministic provider responses.
  const wallet = new Wallet(config.operatorPrivateKey);
  const chain = Object.assign(Object.create(VaultChain.prototype), { config, engine, provider, abi, wallet, vault: {
    async lastBatchId() { return 0n; }, async lastTradeId() { return 0n; }, async stateRoot() { return hash(0); },
    async signerEpoch() { return 1n; }, async operator() { return wallet.address; },
  } }) as VaultChain;
  let activeEngine = engine;
  return { config, engine, chain, provider, state, abi,
    restartEngine() {
      activeEngine.close();
      activeEngine = new RubaEngine(config);
      Object.assign(chain, { engine: activeEngine });
      return activeEngine;
    },
    close() { activeEngine.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('registration whitelist admission denies an unknown owner and does not impose a market pause rule', async () => {
  const f = fixture();
  try {
    let allowed = false;
    Object.assign(f.chain, { vault: {
      async whitelist(owner: string) { assert.equal(owner, account); return allowed; },
      async marketPaused() { throw new Error('Registration admission must not read market pause'); },
    } });
    await assert.rejects(f.chain.assertWhitelisted(account), /not whitelisted/);
    allowed = true;
    await f.chain.assertWhitelisted(account);
  } finally { f.close(); }
});

test('indexer only credits canonical vault logs once and halts on checkpoint reorganization', async () => {
  const f = fixture();
  try {
    const encoded = f.abi.encodeEventLog(f.abi.getEvent('Deposited')!, [1n, account, usdt, 100n]);
    f.state.logs.push({ ...encoded, address: vault, blockNumber: 5, index: 0, transactionHash: hash(100), removed: false });
    await f.chain.sync();
    await f.chain.sync();
    assert.equal(f.engine.accountSnapshot(account).balances.USDT, 100n);
    assert.equal((f.engine.db.prepare('SELECT block_number FROM indexer_checkpoint').get() as {block_number: number}).block_number, 20);
    f.state.changed = true;
    await assert.rejects(f.chain.sync(), /reorganization/);
    assert.equal(f.engine.accountSnapshot(account).balances.USDT, 100n);
  } finally { f.close(); }
});

test('nonlocal ingestion respects consensus finality even with zero configured confirmations', async () => {
  const f = fixture(1n);
  try {
    const encoded = f.abi.encodeEventLog(f.abi.getEvent('Deposited')!, [1n, account, usdt, 100n]);
    f.state.logs.push({ ...encoded, address: vault, blockNumber: 15, index: 0, transactionHash: hash(100), removed: false });
    await f.chain.sync();
    assert.equal(f.engine.accountSnapshot(account).balances.USDT, 0n);
    assert.equal((f.engine.db.prepare('SELECT block_number FROM indexer_checkpoint').get() as {block_number: number}).block_number, 10);
    f.state.finalized = 20;
    await f.chain.sync();
    assert.equal(f.engine.accountSnapshot(account).balances.USDT, 100n);
  } finally { f.close(); }
});

test('Sepolia demo uses configured depth while the same flag cannot bypass mainnet finality', async () => {
  for (const chainId of [11155111n, 1n]) {
    const f = fixture(chainId, 'sepolia');
    try {
      f.config.confirmations = 2;
      const block = await f.chain.confirmedBlock();
      assert.equal(block.number, chainId === 11155111n ? 18 : 10);
      assert.equal(f.state.blockReads.includes('finalized'), chainId !== 11155111n);
    } finally { f.close(); }
  }
});

test('expiry witness reads nonce at the same finalized block, not at latest head', async () => {
  const f = fixture(1n);
  try {
    let blockTag: number | undefined;
    Object.assign(f.chain, { vault: { async usedWithdrawalNonces(_account: string, _nonce: bigint, options: {blockTag: number}) { blockTag = options.blockTag; return false; } } });
    const witness = await f.chain.expiryContext(account, 0n);
    assert.equal(blockTag, 10);
    assert.deepEqual(witness, { finalizedTimestamp: 1010n, nonceUsed: false });
  } finally { f.close(); }
});

test('explicit Tenderly mode indexes new fork blocks while respecting configured confirmation depth', async () => {
  const f = fixture(73571n, 'tenderly');
  try {
    f.config.confirmations = 2;
    const encoded = f.abi.encodeEventLog(f.abi.getEvent('Deposited')!, [1n, account, usdt, 100n]);
    f.state.logs.push({ ...encoded, address: vault, blockNumber: 19, index: 0, transactionHash: hash(100), removed: false });
    await f.chain.sync();
    assert.equal(f.engine.accountSnapshot(account).balances.USDT, 0n);
    assert.equal((f.engine.db.prepare('SELECT block_number FROM indexer_checkpoint').get() as {block_number: number}).block_number, 18);
    f.state.head = 21;
    await f.chain.sync();
    assert.equal(f.engine.accountSnapshot(account).balances.USDT, 100n);
    assert.equal(f.state.finalized, 10, 'fork consensus finality need not move for deposits to be indexed');
    assert.equal(f.state.blockReads.includes('finalized'), false);
  } finally { f.close(); }
});

test('Tenderly expiry checks the withdrawal nonce at the latest fork block', async () => {
  const f = fixture(73571n, 'tenderly');
  try {
    let blockTag: number | undefined;
    Object.assign(f.chain, { vault: { async usedWithdrawalNonces(_account: string, _nonce: bigint, options: {blockTag: number}) { blockTag = options.blockTag; return true; } } });
    const witness = await f.chain.expiryContext(account, 0n);
    assert.equal(blockTag, 20);
    assert.deepEqual(witness, { finalizedTimestamp: 1020n, nonceUsed: true });
    assert.deepEqual(f.state.blockReads, ['latest']);
  } finally { f.close(); }
});

test('Tenderly withdrawal deadlines use pending time after idle periods while ordinary chains retain mined time', async () => {
  for (const chainMode of ['tenderly', undefined] as const) {
    const f = fixture(chainMode ? 73571n : 1n, chainMode);
    try {
      const operator = new Wallet(f.config.operatorPrivateKey);
      Object.assign(f.chain, { wallet: operator, vault: {
        async withdrawalsPaused() { return false; },
        async signerEpoch() { return 1n; },
        async operator() { return operator.address; },
      } });
      const context = await f.chain.withdrawalContext('USDT');
      const currentTimestamp = chainMode ? BigInt(f.state.pendingTimestamp) : 1020n;
      assert.deepEqual(context, { signerEpoch: 1n, deadline: currentTimestamp + f.config.withdrawalTtl });
      assert.deepEqual(f.state.blockReads, chainMode ? [] : ['latest']);
      assert.deepEqual(f.state.rpcReads, chainMode ? [{ method: 'eth_getBlockByNumber', params: ['pending', false] }] : []);
      if (chainMode) assert.ok(context.deadline > BigInt(f.state.pendingTimestamp), 'a fresh ticket must remain executable in the next fork transaction');
    } finally { f.close(); }
  }
});

test('Tenderly refuses malformed pending timestamps instead of issuing stale-deadline tickets', async () => {
  const f = fixture(73571n, 'tenderly');
  try {
    for (const response of [null, {}, { timestamp: null }, { timestamp: 100_000 }, { timestamp: '100000' }, { timestamp: '0x' }, { timestamp: '0xno' }]) {
      Object.assign(f.chain, { provider: { async send() { return response; } } });
      await assert.rejects(f.chain.latestTimestamp(), /pending block timestamp/);
    }
  } finally { f.close(); }
});

test('indexer refuses an empty or stale database when a published batch has no local journal', async () => {
  const f = fixture();
  try {
    Object.assign(f.chain, { vault: { async lastBatchId() { return 1n; } } });
    await assert.rejects(f.chain.sync(), /restore the database/);
    assert.equal(f.engine.db.prepare('SELECT block_number FROM indexer_checkpoint').get(), undefined);
  } finally { f.close(); }
});

test('batch outbox observes an external publication after restart using its actual confirmed transaction hash', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    for (let index = 0; index < 4; index++) f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    const batch = f.engine.listPendingBatches()[0];
    let published = false;
    const txHash = hash(100);
    const publication = f.abi.encodeEventLog(f.abi.getEvent('BatchPublished')!, [batch.batchId, batch.previousStateRoot, batch.newStateRoot, batch.receiptsRoot, batch.firstTradeId, batch.tradeCount]);
    Object.assign(f.chain, {
      vault: {
        async lastBatchId() { return published ? 1n : 0n; }, async batches() { return batch; },
        async publishBatch() { throw new Error('The observer must never send an operator transaction'); },
      },
      provider: { ...f.provider, async getTransactionReceipt() { return { status: 1, blockNumber: 10, logs: [{ address: vault, ...publication }] }; } },
    });
    await f.chain.publishPendingBatches();
    assert.equal(f.engine.listPendingBatches().length, 1);
    assert.equal(f.engine.getMetadata('publication:1'), undefined);
    // The user broadcasts while the server is down; no operator-side transaction hash exists.
    published = true;
    f.state.logs.push({ address: vault, ...publication, blockNumber: 10, transactionHash: txHash });
    const restarted = f.restartEngine();
    await f.chain.publishPendingBatches();
    assert.equal(restarted.listPendingBatches().length, 0);
    assert.equal(restarted.getMetadata('publication:1'), txHash);
    assert.equal(restarted.getBatch(1n)?.publishedTxHash, txHash);
  } finally { f.close(); }
});

test('publication authorizes only the earliest four-trade batch and waits for user submissions in order', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    for (let index = 0; index < 12; index++) f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    let latest = 0n;
    const receipts = new Map<string, object>();
    Object.assign(f.chain, {
      vault: {
        async lastBatchId() { return latest; },
        async lastTradeId() { return latest * 4n; },
        async stateRoot() { return latest ? f.engine.getBatch(latest)!.newStateRoot : hash(0); },
        async signerEpoch() { return 7n; }, async operator() { return f.chain.wallet.address; },
        async batches(id: bigint) { return f.engine.getBatch(id); },
        async publishBatch() { throw new Error('Server must not send publications'); },
      },
      provider: { ...f.provider, async getTransactionReceipt(txHash: string) { return receipts.get(txHash); } },
    });
    for (let id = 1n; id <= 3n; id++) {
      const journalBefore = f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get();
      const prepared = await f.chain.getPublicationRequest();
      assert.equal(prepared.status, 'ready');
      const ticket = prepared.request!;
      assert.equal(ticket.batch.batchId, id);
      assert.equal(ticket.batch.firstTradeId, (id - 1n) * 4n + 1n);
      assert.equal(ticket.batch.tradeCount, 4n);
      assert.equal(ticket.deadline, 1620n);
      assert.equal(ticket.signerEpoch, 7n);
      assert.deepEqual(Object.keys(ticket.batch).sort(), ['batchId', 'firstTradeId', 'newStateRoot', 'previousStateRoot', 'receiptsRoot', 'tradeCount']);
      assert.equal(verifyTypedData(batchPublicationDomain(f.config.chainId, vault), BATCH_PUBLICATION_TYPES,
        { ...ticket.batch, deadline: ticket.deadline, signerEpoch: ticket.signerEpoch }, ticket.signature), f.chain.wallet.address);
      assert.deepEqual(await f.chain.getPublicationRequest(), prepared);
      assert.deepEqual(f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get(), journalBefore);
      const txHash = hash(100 + Number(id));
      const b = ticket.batch;
      const encoded = f.abi.encodeEventLog(f.abi.getEvent('BatchPublished')!, [b.batchId, b.previousStateRoot, b.newStateRoot, b.receiptsRoot, b.firstTradeId, b.tradeCount]);
      receipts.set(txHash, { status: 1, blockNumber: 10, logs: [{ address: vault, ...encoded }] });
      f.state.logs = [{ address: vault, ...encoded, blockNumber: 10, transactionHash: txHash }];
      latest = id; // User broadcasts the signed calldata; the server only observes it.
      await f.chain.publishPendingBatches();
    }
    assert.equal(f.engine.listPendingBatches().length, 0);
    assert.deepEqual(await f.chain.getPublicationRequest(), { status: 'idle', request: null, progress: { collected: 0, required: 4 } });
    for (let id = 1n; id <= 3n; id++) assert.equal(f.engine.getBatch(id)!.publishedTxHash, hash(100 + Number(id)));
  } finally { f.close(); }
});

test('worker and sync do not publish or seal incomplete one-to-three-trade buffers', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    let published = 0;
    Object.assign(f.chain, { vault: { async lastBatchId() { return 0n; }, async publishBatch() { published++; throw new Error('must not publish a partial batch'); } } });
    for (let count = 1; count <= 3; count++) {
      f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
      await f.chain.sync();
      await f.chain.publishPendingBatches();
      await f.chain.publishPendingBatches();
      assert.deepEqual(await f.chain.getPublicationRequest(), { status: 'idle', request: null, progress: { collected: count, required: 4 } });
      assert.equal(published, 0);
      assert.equal(f.engine.listPendingBatches().length, 0);
      assert.equal(f.engine.getBatch(1n), undefined);
      assert.deepEqual(f.engine.getBatchProgress(), { collected: count, required: 4 });
    }
    f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    assert.equal(f.engine.listPendingBatches().length, 1);
    assert.equal(f.engine.getBatch(1n)!.tradeCount, 4n);
    assert.deepEqual(f.engine.getBatchProgress(), { collected: 0, required: 4 });
  } finally { f.close(); }
});

test('an accepted but unfinalized head returns waiting and never authorizes the following batch', async () => {
  const f = fixture(1n);
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    for (let index = 0; index < 8; index++) f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    const batch = f.engine.getBatch(1n)!;
    Object.assign(f.chain, { vault: {
      async lastBatchId(options?: { blockTag: number }) { return options && options.blockTag < 15 ? 0n : 1n; },
      async lastTradeId() { return 4n; }, async stateRoot() { return batch.newStateRoot; },
      async signerEpoch() { return 1n; }, async operator() { return f.chain.wallet.address; },
      async batches() { return batch; },
    } });
    assert.deepEqual(await f.chain.getPublicationRequest(), { status: 'waiting', request: null, progress: { collected: 0, required: 4 } });
    assert.equal(f.engine.listPendingBatches().length, 2);
    assert.equal(f.engine.getBatch(1n)?.publishedTxHash, undefined);
  } finally { f.close(); }
});

test('publication tickets refresh expired deadlines and signer epochs without changing the sealed commitment', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    for (let index = 0; index < 4; index++) f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    let epoch = 1n;
    let operator = f.chain.wallet.address;
    const previousVault = f.chain.vault;
    Object.assign(f.chain, { vault: { ...previousVault,
      async signerEpoch() { return epoch; }, async operator() { return operator; },
    } });
    const before = f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get();
    const first = (await f.chain.getPublicationRequest()).request!;
    f.state.head += 601;
    assert.ok(first.deadline < await f.chain.latestTimestamp());
    const refreshed = (await f.chain.getPublicationRequest()).request!;
    assert.equal(refreshed.deadline, first.deadline + 601n);
    assert.deepEqual(refreshed.batch, first.batch);
    assert.notEqual(refreshed.signature, first.signature);
    operator = account;
    epoch++;
    await assert.rejects(f.chain.getPublicationRequest(), /Operator changed/);
    operator = f.chain.wallet.address;
    epoch++;
    const rotated = (await f.chain.getPublicationRequest()).request!;
    assert.equal(rotated.signerEpoch, epoch);
    assert.notEqual(rotated.signature, refreshed.signature);
    assert.deepEqual(rotated.batch, first.batch);
    assert.deepEqual(f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get(), before);
  } finally { f.close(); }
});

test('publication signing fails closed when the trade sequence or previous state root differs', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    for (let index = 0; index < 4; index++) f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    let lastTradeId = 99n;
    let stateRoot = hash(0);
    const previousVault = f.chain.vault;
    Object.assign(f.chain, { vault: { ...previousVault,
      async lastTradeId() { return lastTradeId; }, async stateRoot() { return stateRoot; },
    } });
    await assert.rejects(f.chain.getPublicationRequest(), /Batch sequence differs/);
    lastTradeId = 0n; stateRoot = hash(123);
    await assert.rejects(f.chain.getPublicationRequest(), /previous state root differs/);
    assert.equal(f.engine.getBatch(1n)?.publishedTxHash, undefined);
  } finally { f.close(); }
});

test('disclosure publication lookup is public but only reports verified contract commitments as published', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, account, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, account, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(account, 500n * 10n ** 18n, 500n * 10n ** 6n);
    for (let index = 0; index < 4; index++) f.engine.swap(account, 'RUBA', 10n ** 18n, 0n);
    const batch = f.engine.getBatch(1n)!;
    const pending = await f.chain.getDisclosureBatch(1n);
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.source, 'server');
    assert.equal(pending?.batch.receiptsRoot, batch.receiptsRoot);
    assert.equal('stateSalt' in pending!.batch, false);
    assert.equal('stateSnapshot' in pending!.batch, false);
    assert.equal('tradeIds' in pending!.batch, false);
    assert.equal(await f.chain.getDisclosureBatch(2n), undefined);
    await assert.rejects(f.chain.getDisclosureBatch(0n), /Invalid batch/);
    const txHash = hash(91);
    f.engine.setMetadata('publication:1', txHash);
    const event = f.abi.encodeEventLog(f.abi.getEvent('BatchPublished')!, [batch.batchId, batch.previousStateRoot, batch.newStateRoot, batch.receiptsRoot, batch.firstTradeId, batch.tradeCount]);
    let successful = true;
    let wrongRoot = false;
    Object.assign(f.chain, {
      vault: { async lastBatchId() { return 1n; }, async batches() { return wrongRoot ? { ...batch, receiptsRoot: hash(999) } : batch; } },
      provider: { ...f.provider, async getTransactionReceipt() { return { status: successful ? 1 : 0, blockNumber: 10, logs: [{ address: vault, ...event }] }; } },
    });
    const published = await f.chain.getDisclosureBatch(1n);
    assert.equal(published?.status, 'published');
    assert.equal(published?.source, 'contract');
    assert.equal(published?.batch.publishedTxHash, txHash);
    assert.equal(published?.blockNumber, 10);
    assert.equal('stateSalt' in published!.batch, false);
    assert.equal('stateSnapshot' in published!.batch, false);
    wrongRoot = true;
    await assert.rejects(f.chain.getDisclosureBatch(1n), /differs from the Vault/);
    wrongRoot = false; successful = false;
    await assert.rejects(f.chain.getDisclosureBatch(1n), /not found|not confirmed/);
  } finally { f.close(); }
});

test('initialize rejects old variable-batch Vaults before changing the journal', async () => {
  const f = fixture();
  try {
    const before = f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get();
    Object.assign(f.chain, { vault: { async MIN_TRADES_PER_BATCH() { return 1n; }, async MAX_TRADES_PER_BATCH() { return 4n; } }, provider: { ...f.provider,
      async getNetwork() { return { chainId: f.config.chainId }; }, async getCode() { return '0x1234'; },
    } });
    await assert.rejects(f.chain.initialize(), /Deploy a new RubaVault/);
    assert.deepEqual(f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get(), before);
  } finally { f.close(); }
});

test('initialize rejects legacy strict-four Vaults without the signed-publication capability before journal changes', async () => {
  for (const typeHash of [undefined, hash(999)]) {
    const f = fixture();
    try {
      const before = f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get();
      Object.assign(f.chain, { vault: {
        async MIN_TRADES_PER_BATCH() { return 4n; }, async MAX_TRADES_PER_BATCH() { return 4n; },
        async PUBLISH_BATCH_TYPEHASH() { if (!typeHash) throw new Error('Getter does not exist'); return typeHash; },
      }, provider: { ...f.provider,
        async getNetwork() { return { chainId: f.config.chainId }; }, async getCode() { return '0x1234'; },
      } });
      await assert.rejects(f.chain.initialize(), /Deploy a new RubaVault.*PUBLISH_BATCH_TYPEHASH/);
      assert.deepEqual(f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get(), before);
      assert.equal(f.engine.db.prepare('SELECT * FROM indexer_checkpoint').get(), undefined);
    } finally { f.close(); }
  }
});
