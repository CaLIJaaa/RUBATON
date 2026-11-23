import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RubaEngine, MINIMUM_LIQUIDITY } from '../../server/engine.ts';
import type { EngineConfig, Token } from '../../server/types.ts';
import { ensureForkBalance, explainTenderlyFailure, seedTenderlyPool } from '../tenderly.ts';

const SEEDER = '0x0000000000000000000000000000000000000011';
const TRADER = '0x0000000000000000000000000000000000000022';
const RUBA_SEED = 1_000n * 10n ** 18n;
const USDT_SEED = 1_000n * 10n ** 6n;
const MARKER = 'tenderly:initial-liquidity';

test('Tenderly HTTP quota errors explain the blocker without exposing RPC credentials', () => {
  const providerError = Object.assign(new Error('server response 403 Forbidden'), {
    code: 'SERVER_ERROR',
    info: {
      requestUrl: 'https://virtual.mainnet.eu.rpc.tenderly.co/private-admin-token',
      responseBody: JSON.stringify({ jsonrpc: '2.0', error: { code: -32004, message: "You've reached the quota limit for your current plan. Upgrade your plan in the dashboard or contact support." } }),
    },
  });
  const message = explainTenderlyFailure(providerError, 'пополнить ETH').message;
  assert.match(message, /Tenderly исчерпан лимит/);
  assert.equal(message.includes('private-admin-token'), false);
  assert.equal(message.includes('https:'), false);
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-tenderly-bootstrap-'));
  const config: EngineConfig = {
    chainId: 73571n, dbPath: join(directory, 'ledger.sqlite'),
    vaultAddress: '0x0000000000000000000000000000000000000001',
    rubaAddress: '0x0000000000000000000000000000000000000002',
    usdtAddress: '0x0000000000000000000000000000000000000003',
  };
  let engine = new RubaEngine(config);
  let nextDepositId = 1n;
  const events: { id: bigint; token: Token; amount: bigint }[] = [];
  const deposits: { token: Token; amount: bigint }[] = [];
  const sync = async () => {
    for (const event of events) engine.recordDeposit(event.id, SEEDER, event.token, event.amount);
  };
  const deposit = async (token: Token, amount: bigint) => {
    deposits.push({ token, amount });
    events.push({ id: nextDepositId++, token, amount });
  };
  const options = () => ({ engine, account: SEEDER, ruba: RUBA_SEED, usdt: USDT_SEED, sync, deposit });
  return {
    get engine() { return engine; }, events, deposits, sync, deposit, options,
    restart() { engine.close(); engine = new RubaEngine(config); },
    close() { engine.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('fork faucet tops up to a minimum without lowering or repeatedly overwriting existing balances', async () => {
  let balance = 4n * 10n ** 6n;
  const writes: bigint[] = [];
  const topUp = (target: bigint) => ensureForkBalance(async () => balance, target, async (value) => {
    writes.push(value);
    balance = value;
  });
  await topUp(10n * 10n ** 6n);
  await topUp(10n * 10n ** 6n);
  await topUp(3n * 10n ** 6n);
  assert.deepEqual(writes, [10n * 10n ** 6n]);
  assert.equal(balance, 10n * 10n ** 6n);
});

test('fork faucet rejects a successful RPC response that did not update the requested balance', async () => {
  let writes = 0;
  await assert.rejects(ensureForkBalance(async () => 0n, 10n, async () => { writes += 1; return true; }), /не зачислил/);
  assert.equal(writes, 1);
});

test('initial pool uses indexed deposits and preserves the different RUBA and USDT precisions', async () => {
  const f = fixture();
  try {
    await seedTenderlyPool(f.options());
    assert.deepEqual(f.deposits, [
      { token: 'RUBA', amount: RUBA_SEED }, { token: 'USDT', amount: USDT_SEED },
    ]);
    const snapshot = f.engine.snapshot();
    assert.deepEqual(snapshot.custody, { RUBA: RUBA_SEED, USDT: USDT_SEED });
    assert.deepEqual(snapshot.reserves, snapshot.custody);
    assert.equal(snapshot.totalSupply, 10n ** 15n);
    assert.equal(snapshot.lockedLiquidity, MINIMUM_LIQUIDITY);
    assert.equal(f.engine.accountSnapshot(SEEDER).lpShares, snapshot.totalSupply - MINIMUM_LIQUIDITY);
    assert.deepEqual(f.engine.accountSnapshot(SEEDER).balances, { RUBA: 0n, USDT: 0n });
    assert.equal(f.engine.getMetadata(MARKER), 'complete');
  } finally { f.close(); }
});

test('restart after one confirmed seed deposit submits only the missing token', async () => {
  const f = fixture();
  try {
    await assert.rejects(seedTenderlyPool({
      ...f.options(),
      deposit: async (token, amount) => {
        if (token === 'USDT') throw new Error('wallet rejected the second deposit');
        await f.deposit(token, amount);
      },
    }), /second deposit/);
    assert.equal(f.engine.accountSnapshot(SEEDER).balances.RUBA, RUBA_SEED);
    assert.equal(f.engine.snapshot().totalSupply, 0n);
    assert.equal(f.engine.getMetadata(MARKER), undefined);
    f.restart();
    await seedTenderlyPool(f.options());
    assert.deepEqual(f.deposits, [
      { token: 'RUBA', amount: RUBA_SEED }, { token: 'USDT', amount: USDT_SEED },
    ]);
    assert.deepEqual(f.engine.snapshot().reserves, { RUBA: RUBA_SEED, USDT: USDT_SEED });
  } finally { f.close(); }
});

test('a lost response after a committed seed deposit is reconciled before retrying', async () => {
  const f = fixture();
  try {
    await assert.rejects(seedTenderlyPool({
      ...f.options(),
      deposit: async (token, amount) => {
        await f.deposit(token, amount);
        if (token === 'USDT') throw new Error('RPC response lost after the transaction committed');
      },
    }), /response lost/);
    assert.equal(f.events.length, 2);
    assert.equal(f.engine.accountSnapshot(SEEDER).balances.USDT, 0n, 'the last event has not been indexed yet');
    f.restart();
    await seedTenderlyPool(f.options());
    assert.equal(f.deposits.length, 2, 'reconciliation must not send an extra transaction');
    assert.deepEqual(f.engine.snapshot().custody, { RUBA: RUBA_SEED, USDT: USDT_SEED });
    assert.deepEqual(f.engine.snapshot().reserves, f.engine.snapshot().custody);
  } finally { f.close(); }
});

test('funding a wallet without an indexed vault deposit cannot fabricate liquidity', async () => {
  const f = fixture();
  try {
    let fundedWalletBalance = 0n;
    await ensureForkBalance(async () => fundedWalletBalance, RUBA_SEED, async (value) => { fundedWalletBalance = value; });
    await assert.rejects(seedTenderlyPool({
      ...f.options(),
      deposit: async () => {}, // An RPC success without a canonical Deposited event.
    }), /Индексатор не подтвердил/);
    assert.equal(fundedWalletBalance, RUBA_SEED);
    assert.deepEqual(f.engine.snapshot().custody, { RUBA: 0n, USDT: 0n });
    assert.deepEqual(f.engine.snapshot().reserves, { RUBA: 0n, USDT: 0n });
    assert.equal(f.engine.snapshot().totalSupply, 0n);
    assert.equal(f.engine.getMetadata(MARKER), undefined);
  } finally { f.close(); }
});

test('restarting an initialized market preserves trades and does not reset or re-seed the pool', async () => {
  const f = fixture();
  try {
    await seedTenderlyPool(f.options());
    f.engine.recordDeposit(100n, TRADER, 'RUBA', 10n * 10n ** 18n);
    const receipt = f.engine.swap(TRADER, 'RUBA', 10n * 10n ** 18n, 0n);
    const snapshot = f.engine.snapshot();
    const trader = f.engine.accountSnapshot(TRADER);
    assert.equal(snapshot.nextTradeId, 2n);
    assert.ok(receipt.amountOut > 0n);
    f.restart();
    await seedTenderlyPool({
      ...f.options(),
      sync: async () => { throw new Error('initialized seed must be left alone'); },
      deposit: async () => { throw new Error('must not deposit twice'); },
    });
    assert.deepEqual(f.engine.snapshot(), snapshot);
    assert.deepEqual(f.engine.accountSnapshot(TRADER), trader);
    assert.equal(f.deposits.length, 2);
  } finally { f.close(); }
});

test('recovering a crash between pool creation and its marker never adds liquidity twice', async () => {
  const f = fixture();
  try {
    await f.deposit('RUBA', RUBA_SEED);
    await f.deposit('USDT', USDT_SEED);
    await f.sync();
    f.engine.addLiquidity(SEEDER, RUBA_SEED, USDT_SEED, RUBA_SEED, USDT_SEED);
    assert.equal(f.engine.getMetadata(MARKER), undefined);
    const snapshot = f.engine.snapshot();
    f.restart();
    await seedTenderlyPool({
      ...f.options(),
      deposit: async () => { throw new Error('must not deposit twice'); },
    });
    assert.deepEqual(f.engine.snapshot(), snapshot);
    assert.equal(f.engine.getMetadata(MARKER), 'complete');
  } finally { f.close(); }
});
