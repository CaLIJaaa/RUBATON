import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketSettingsStore, validateControlCommand, validateReferencePrice } from '../market-settings.ts';

const binding = { chainId: 31337n, defaultVault: '0x0000000000000000000000000000000000000001', admin: '0x0000000000000000000000000000000000000002' };
const markets = ['ruba-usdt', 'ruba-weth', 'weth-wbtc'];
const prices = { RUBA: '2', USDT: '1', WETH: '3000', WBTC: '90000' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-market-settings-'));
  const options = { path: join(directory, 'control.sqlite'), markets, binding };
  let store = new MarketSettingsStore(options);
  return { get store() { return store; }, options,
    restart() { store.close(); store = new MarketSettingsStore(options); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('control settings persist global prices/revision/nonce and isolate each market policy across restart', () => {
  const f = fixture();
  try {
    assert.equal(f.store.getNonce(), 0n); assert.equal(f.store.getSettings().revision, 0n);
    assert.ok(Object.values(f.store.getSettings().arbitrage).every((policy) => !policy.enabled && policy.delaySeconds === 30));
    const saved = f.store.apply({ kind: 'prices', prices }, 0n);
    assert.equal(saved.nonce, 1n); assert.equal(saved.revision, 1n);
    f.store.apply({ kind: 'arbitrage', marketId: 'weth-wbtc', enabled: true, delaySeconds: 5 }, 1n);
    f.restart();
    const settings = f.store.getSettings();
    assert.equal(f.store.getNonce(), 2n); assert.equal(settings.revision, 2n); assert.deepEqual(settings.prices, prices);
    assert.equal(settings.arbitrage['weth-wbtc'].enabled, true); assert.equal(settings.arbitrage['ruba-usdt'].enabled, false);
    settings.prices.RUBA = '999'; settings.arbitrage['weth-wbtc'].enabled = false;
    assert.equal(f.store.getSettings().prices.RUBA, '2'); assert.equal(f.store.getSettings().arbitrage['weth-wbtc'].enabled, true);
    assert.throws(() => f.store.apply({ kind: 'prices', prices }, 0n), /nonce/);
    assert.equal(f.store.getNonce(), 2n);
  } finally { f.close(); }
});

test('monitor consumes a global nonce without changing revision, and failures roll everything back', () => {
  const f = fixture();
  try {
    const response = f.store.apply({ kind: 'monitor', marketId: 'ruba-usdt' }, 0n, () => ({ reserve0: 123n }));
    assert.deepEqual(response, { result: { reserve0: 123n }, nonce: 1n, revision: 0n });
    assert.throws(() => f.store.apply({ kind: 'monitor', marketId: 'ruba-usdt' }, 1n, () => { throw new Error('unavailable'); }), /unavailable/);
    assert.equal(f.store.getNonce(), 1n);
    assert.throws(() => f.store.apply({ kind: 'monitor', marketId: 'ruba-usdt' }, 1n, () => Promise.resolve('bad')), /synchronous/);
    assert.equal(f.store.getNonce(), 1n); assert.equal(f.store.getSettings().revision, 0n);
    f.store.apply({ kind: 'prices', prices }, 1n);
    assert.equal(f.store.getNonce(), 2n); assert.equal(f.store.getSettings().revision, 1n);
  } finally { f.close(); }
});

test('closeBatch persists a one-shot audited control nonce without changing settings or awaiting a callback', () => {
  const f = fixture();
  try {
    const before = f.store.getSettings();
    const result = f.store.apply({ kind: 'closeBatch', marketId: 'ruba-weth' }, 0n);
    assert.deepEqual(result, { result: { marketId: 'ruba-weth' }, nonce: 1n, revision: 0n });
    assert.deepEqual(f.store.getSettings(), before);
    f.restart();
    assert.equal(f.store.getNonce(), 1n);
    assert.throws(() => f.store.apply({ kind: 'closeBatch', marketId: 'ruba-weth' }, 0n), /nonce/);
    assert.deepEqual((f.store.db.prepare('SELECT nonce FROM market_control_audit').all() as { nonce: string }[]).map((row) => row.nonce), ['0']);
  } finally { f.close(); }
});

test('control commands reject extra fields, ambiguous decimals, changed USDT, unknown markets and unsafe delays', () => {
  const f = fixture();
  try {
    for (const value of ['0', '00', '01', '1.0', '0.10', '.1', '1.', '1e2', '-1', '0.0000000000000000001', 1, null]) assert.throws(() => validateReferencePrice(value));
    for (const value of ['1', '0.1', '123.456', '0.000000000000000001']) assert.equal(validateReferencePrice(value), value);
    for (const command of [
      { kind: 'prices', prices: { ...prices, USDT: '2' } },
      { kind: 'prices', prices: { ...prices, DAI: '1' } },
      { kind: 'prices', prices, extra: true },
      { kind: 'arbitrage', marketId: 'unknown', enabled: true, delaySeconds: 30 },
      ...[4, 3601, 5.5, '30', NaN].map((delaySeconds) => ({ kind: 'arbitrage', marketId: 'ruba-usdt', enabled: true, delaySeconds })),
      { kind: 'arbitrage', marketId: 'ruba-usdt', enabled: 1, delaySeconds: 30 },
      { kind: 'monitor', marketId: 'ruba-usdt', balances: true },
      { kind: 'closeBatch', marketId: 'unknown' },
      { kind: 'closeBatch', marketId: 'ruba-usdt', reveal: true },
    ]) assert.throws(() => f.store.apply(command, 0n));
    assert.equal(f.store.getNonce(), 0n); assert.equal(f.store.getSettings().revision, 0n);
    assert.deepEqual(validateControlCommand({ kind: 'arbitrage', marketId: 'ruba-usdt', enabled: true, delaySeconds: 3600 }, markets),
      { kind: 'arbitrage', marketId: 'ruba-usdt', enabled: true, delaySeconds: 3600 });
  } finally { f.close(); }
});

test('a second settings connection cannot reuse an already committed nonce', () => {
  const f = fixture(); const second = new MarketSettingsStore(f.options);
  try {
    f.store.apply({ kind: 'prices', prices }, 0n);
    assert.throws(() => second.apply({ kind: 'prices', prices }, 0n), /nonce/);
    assert.equal(second.getNonce(), 1n);
  } finally { second.close(); f.close(); }
});

test('settings storage is pinned to chain, default Vault, admin and catalog', () => {
  const f = fixture();
  try {
    for (const changed of [
      { ...f.options, binding: { ...binding, chainId: 1n } },
      { ...f.options, binding: { ...binding, defaultVault: '0x0000000000000000000000000000000000000003' } },
      { ...f.options, binding: { ...binding, admin: '0x0000000000000000000000000000000000000004' } },
      { ...f.options, markets: ['ruba-usdt'] },
    ]) assert.throws(() => new MarketSettingsStore(changed), /another deployment/);
    assert.equal(f.store.getNonce(), 0n);
  } finally { f.close(); }
});

test('accepted history is isolated, immutable per root/block and bounded to 120 checkpoints', () => {
  const f = fixture();
  try {
    for (let version = 1; version <= 130; version++) f.store.recordHistory('pool-a', { stateVersion: BigInt(version), root: BigInt(version),
      blockNumber: version, blockHash: `hash-${version}`, timestamp: BigInt(version), spot: '1', target: '1', deviationBps: 0n });
    const history = f.store.getHistory('pool-a');
    assert.equal(history.length, 120); assert.equal(history[0].stateVersion, 11n); assert.equal(history.at(-1)!.stateVersion, 130n);
    assert.deepEqual(f.store.getHistory('pool-b'), []);
    f.store.recordHistory('pool-a', { ...history.at(-1)!, target: '2' });
    assert.equal(f.store.getHistory('pool-a').at(-1)!.target, '1', 'first observed target remains historical');
    assert.throws(() => f.store.recordHistory('pool-a', { ...history.at(-1)!, root: 999n }), /changed/);
    assert.throws(() => f.store.recordHistory('pool-a', { ...history.at(-1)!, blockHash: 'another-block' }), /changed/);
    f.restart(); assert.equal(f.store.getHistory('pool-a').length, 120);
  } finally { f.close(); }
});
