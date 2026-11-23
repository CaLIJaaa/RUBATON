import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getAddress, verifyTypedData, keccak256, toUtf8Bytes } from 'ethers';
import { loadMarkets, scopedMarketFetch, loadDashboard, sendControl, poolSpot, chartPoints, timeChartScale, formatChartTimestamp, compactChartPrice, canonicalControlJson } from '../markets.js';
import { canonicalJson, parseAmount, formatAmount } from '../model.js';

const admin = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
const address = (value) => getAddress('0x' + value.toString(16).padStart(40, '0'));
function catalog() {
  const assets = { RUBA: { symbol: 'RUBA', decimals: 18, address: address(11) }, USDT: { symbol: 'USDT', decimals: 6, address: address(12) },
    WETH: { symbol: 'WETH', decimals: 18, address: address(13) }, WBTC: { symbol: 'WBTC', decimals: 8, address: address(14) } };
  const markets = [['ruba-usdt', 'RUBA', 'USDT'], ['ruba-weth', 'RUBA', 'WETH'], ['weth-wbtc', 'WETH', 'WBTC']].map(([id, base, quote], i) => ({
    id, label: `${base} / ${quote}`, chainId: '31337', vault: address(i + 1), base: assets[base], quote: assets[quote],
  }));
  return { network: { name: 'Local Anvil', chainId: '31337', explorerUrl: null }, defaultMarketId: 'ruba-usdt', markets,
    control: { admin: admin.address, domain: { name: 'RubaMarketControl', version: '1', chainId: '31337', verifyingContract: markets[0].vault },
      types: { ControlAction: [{ name: 'actionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      nonce: '0', revision: '0', prices: { RUBA: '1', USDT: '1', WETH: '3000', WBTC: '90000' } } };
}
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return structuredClone(body); } });

test('catalog preserves actual 18/6/8 token metadata and rejects duplicate Vaults, unsafe IDs and malformed fallbacks', async () => {
  const data = await loadMarkets(async () => reply(catalog()));
  assert.deepEqual(data.markets.map((market) => [market.base.symbol, market.quote.symbol, market.quote.decimals]), [['RUBA', 'USDT', 6], ['RUBA', 'WETH', 18], ['WETH', 'WBTC', 8]]);
  assert.equal(await loadMarkets(async () => reply({ error: 'not found' }, 404)), null);
  for (const corrupt of [
    (c) => { c.markets[1].vault = c.markets[0].vault; },
    (c) => { c.markets[1].id = '../other'; },
    (c) => { c.markets[2].quote.decimals = 19; },
    (c) => { c.markets[2].quote.symbol = '<WBTC>'; },
    (c) => { c.defaultMarketId = 'missing'; },
  ]) { const data = catalog(); corrupt(data); await assert.rejects(loadMarkets(async () => reply(data))); }
  await assert.rejects(loadMarkets(async () => reply({ error: 'unavailable' }, 503)));
  await assert.rejects(loadMarkets(async () => reply({})), /каталог/);
});

test('scoped fetch binds every nonce/action/publication to its exact market and rejects escaping or double-prefixed paths', async () => {
  const paths = [];
  const fetch = scopedMarketFetch('weth-wbtc', async (path, init) => { paths.push([path, init?.method]); return reply({}); });
  await fetch('/config'); await fetch('/nonce?account=0x123'); await fetch('/actions', { method: 'POST' }); await fetch('/publication');
  await fetch('/disclosure/batches/1');
  assert.deepEqual(paths.map(([path]) => path), ['/markets/weth-wbtc/config', '/markets/weth-wbtc/nonce?account=0x123', '/markets/weth-wbtc/actions', '/markets/weth-wbtc/publication', '/markets/weth-wbtc/disclosure/batches/1']);
  for (const path of ['/admin/action', 'https://other/actions', '//other/actions', '/../actions', '/markets/ruba-usdt/actions', '/actions?target=other']) assert.throws(() => fetch(path));
  assert.throws(() => scopedMarketFetch('../other'));
});

test('spot and chart math respect atomic decimals without converting money to floating-point numbers', () => {
  assert.equal(poolSpot(3000n * 10n ** 18n, 3000n * 10n ** 6n, 18, 6), '1');
  assert.equal(poolSpot(3000n * 10n ** 18n, 10n ** 18n, 18, 18), '0.000333333333333333');
  assert.equal(poolSpot(3n * 10n ** 18n, 10n ** 7n, 18, 8), '0.033333333333333333');
  assert.equal(formatAmount(parseAmount('0.00000001', 8), 8), '0.00000001');
  assert.throws(() => parseAmount('0.000000001', 8));
  const points = chartPoints([{ spot: '1', target: '1' }, { spot: '1.2', target: '1' }], ['0.9', '1.3']);
  assert.ok(points.spot); assert.ok(points.target);
  assert.ok(points.y('0.9') >= 28 && points.y('1.3') <= 172);
  assert.doesNotMatch(points.spot, /NaN|Infinity/);
});

const exampleBlockTime = Date.parse('2026-11-23T10:04:05Z') / 1000;

test('confirmed price steps are spaced by elapsed block time and chart coordinates can be inverted', () => {
  const points = [
    { timestamp: String(exampleBlockTime), stateVersion: '1', spot: '1', target: '1' },
    { timestamp: String(exampleBlockTime + 60), stateVersion: '2', spot: '1.04', target: '1' },
    { timestamp: String(exampleBlockTime + 600), stateVersion: '3', spot: '1.02', target: '1' },
  ];
  const scale = timeChartScale(points, { left: 50, right: 450, top: 10, bottom: 200, extraValues: ['1.1'] });
  const [first, second, last] = scale.points;
  assert.ok(Math.abs((second.x - first.x) / (last.x - first.x) - 0.1) < 0.000001);
  assert.equal(Math.round(scale.timeFromX(second.x)), exampleBlockTime + 60);
  assert.ok(scale.timeFromX(0) < first.timestamp);
  assert.ok(scale.timeFromX(500) > last.timestamp);
  assert.ok(scale.y('1.1') >= 10);
  assert.match(scale.spotPath, /^M [-\d.]+ [-\d.]+ H [-\d.]+ V [-\d.]+ H [-\d.]+ V [-\d.]+$/);
  assert.ok(scale.timeTicks.length >= 3 && scale.timeTicks.every((tick) => /^13:\d\d$/.test(tick.label)));
  assert.equal(formatChartTimestamp(points[0].timestamp), '23.11.2026, 13:04:05 МСК');
  assert.equal(formatChartTimestamp('missing'), '—');
  assert.deepEqual(timeChartScale(points, { windowSeconds: 120 }).points.map((point) => point.stateVersion), ['3']);
});

test('chart keeps same-block publications in state order and keeps close price ticks exact and distinct', () => {
  const timestamp = String(exampleBlockTime);
  const scale = timeChartScale([
    { timestamp, stateVersion: '10', spot: '1.00000000001', target: '1' },
    { timestamp, stateVersion: '2', spot: '1.00000000002', target: '1' },
    { stateVersion: '11', spot: '1.00000000003', target: '1' },
  ]);
  assert.deepEqual(scale.points.map((point) => point.stateVersion), ['2', '10']);
  assert.equal(scale.points[0].x, scale.points[1].x);
  assert.ok(scale.points[0].spotY < scale.points[1].spotY);
  const labels = scale.priceTicks.map((tick) => tick.label);
  assert.ok(labels.length >= 3);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.some((label) => label === '1,00000000001'));
  assert.doesNotMatch(scale.spotPath, /NaN|Infinity/);
});

test('empty and singleton time series and tiny positive prices produce bounded chart geometry', () => {
  const empty = timeChartScale([{ spot: '1', target: '1' }, { timestamp: '9999999999999', spot: '1', target: '1' }]);
  assert.deepEqual(empty.points, []);
  assert.deepEqual(empty.timeTicks, []);
  assert.deepEqual(empty.priceTicks, []);
  assert.equal(empty.timeFromX(300), null);
  const single = timeChartScale([{ timestamp: '0', spot: '0.000000000000000001', target: '0.000000000000000001' }]);
  assert.match(single.spotPath, /^M [-\d.]+ [-\d.]+$/);
  assert.ok(single.timeTicks.every((tick) => tick.timestamp >= 0));
  assert.deepEqual(single.priceTicks.map((tick) => tick.value), ['0', '0.000000000000000001', '0.000000000000000002']);
  assert.ok(single.priceTicks[0].y > single.points[0].spotY, 'zero is the bottom tick, not the sample price');
});

test('headline chart prices round to significant digits without losing small nonzero amounts', () => {
  assert.equal(compactChartPrice('1.23456789'), '≈ 1,23457');
  assert.equal(compactChartPrice('0.033333333333333333'), '≈ 0,0333333');
  assert.equal(compactChartPrice('0.000000000000000001'), '0,000000000000000001');
  assert.equal(compactChartPrice('3000.000'), '3000');
  assert.equal(compactChartPrice('999999.9'), '≈ 1000000');
});

function controlFixture() {
  const c = catalog(); const posts = []; const contexts = []; let reads = 0;
  const ctx = { account: admin.address, chainId: '0x7a69', drop: false, current: true, nonce: 0n };
  const provider = { async send(method) { return method === 'eth_chainId' ? ctx.chainId : [ctx.account]; }, async getBlock() { return { timestamp: 1000 }; } };
  const signer = { async getAddress() { return admin.address; }, async signTypedData(domain, types, value) {
    contexts.push({ domain, types, value }); const signature = await admin.signTypedData(domain, types, value); ctx.afterSign?.(); return signature;
  } };
  const fetchImpl = async (path, init) => {
    if (path === '/markets') { reads++; c.control.nonce = ctx.nonce.toString(); return reply(c); }
    assert.equal(path, '/admin/action'); const body = JSON.parse(init.body); posts.push(body);
    assert.equal(BigInt(body.nonce), ctx.nonce);
    assert.equal(verifyTypedData(c.control.domain, c.control.types, { actionHash: keccak256(toUtf8Bytes(canonicalControlJson(body.command))), nonce: body.nonce, deadline: body.deadline }, body.signature), admin.address);
    ctx.nonce++;
    if (ctx.drop) { ctx.drop = false; throw new TypeError('Failed to fetch after commit'); }
    return reply({ result: { ok: true }, nonce: ctx.nonce.toString(), revision: ctx.nonce.toString() });
  };
  return { c, ctx, posts, contexts, provider, signer, fetchImpl, reads: () => reads };
}

test('admin controls refresh and serialize the global nonce and sign the exact normalized command locally', async () => {
  const f = controlFixture();
  const steps = [];
  await Promise.all([
    sendControl({ ...f, command: { kind: 'prices', prices: { RUBA: '1.00', USDT: '1', WETH: '3000', WBTC: '90000' } } }),
    sendControl({ ...f, command: { kind: 'arbitrage', marketId: 'weth-wbtc', enabled: true, delaySeconds: 30 },
      onWalletStep: (step) => { steps.push({ ...step, signedCalls: f.contexts.length }); } }),
    sendControl({ ...f, command: { kind: 'monitor', marketId: 'ruba-weth' } }),
    sendControl({ ...f, command: { kind: 'closeBatch', marketId: 'ruba-usdt' } }),
  ]);
  assert.deepEqual(f.posts.map((post) => post.nonce), ['0', '1', '2', '3']);
  assert.equal(f.posts[0].command.prices.RUBA, '1');
  assert.equal(f.reads(), 4);
  assert.equal(f.contexts[0].domain.verifyingContract, f.c.markets[0].vault);
  assert.deepEqual(Object.keys(f.contexts[0].types), ['ControlAction']);
  assert.equal(f.posts[2].deadline, '1600');
  assert.deepEqual(f.posts[3].command, { kind: 'closeBatch', marketId: 'ruba-usdt' });
  assert.deepEqual(steps.map(({ kind, phase, signedCalls }) => [kind, phase, signedCalls]),
    [['signature', 'start', 1], ['signature', 'done', 2]]);
  assert.equal(steps[0].id, steps[1].id);
  assert.match(steps[0].title, /включить.*30 с/);
});

test('admin commands reject wrong wallet/domain/settings or a changed selection before any POST', async () => {
  for (const mutation of [
    (f) => { f.c.control.admin = other.address; },
    (f) => { f.c.control.domain.verifyingContract = f.c.markets[1].vault; },
    (f) => { f.ctx.afterSign = () => { f.ctx.account = other.address; }; },
    (f) => { f.ctx.afterSign = () => { f.ctx.current = false; }; },
  ]) {
    const f = controlFixture(); mutation(f);
    await assert.rejects(sendControl({ ...f, isCurrent: () => f.ctx.current, command: { kind: 'monitor', marketId: 'ruba-usdt' } }));
    assert.equal(f.posts.length, 0);
  }
  const f = controlFixture();
  await assert.rejects(sendControl({ ...f, command: { kind: 'arbitrage', marketId: 'ruba-usdt', enabled: true, delaySeconds: 4 } }));
  await assert.rejects(sendControl({ ...f, command: { kind: 'prices', prices: { RUBA: '1', USDT: '2', WETH: '3000', WBTC: '90000' } } }));
  assert.equal(f.posts.length, 0);
});

test('a lost admin response never resends and the next explicit command uses the advanced nonce', async () => {
  const f = controlFixture(); f.ctx.drop = true;
  await assert.rejects(sendControl({ ...f, command: { kind: 'monitor', marketId: 'ruba-usdt' } }), (error) => error.uncertain === true);
  assert.equal(f.posts.length, 1);
  await sendControl({ ...f, command: { kind: 'monitor', marketId: 'ruba-usdt' } });
  assert.deepEqual(f.posts.map((post) => post.nonce), ['0', '1']);
});

test('dashboard is market-scoped and rejects another market even when its stateVersion collides', async () => {
  const body = { marketId: 'weth-wbtc', progress: { collected: 1, required: 4 }, accepted: { stateVersion: '1', history: [], spot: '0.03', target: '0.033', deviationBps: '-909' } };
  let path;
  const response = await loadDashboard('weth-wbtc', async (value) => { path = value; return reply(body); });
  assert.equal(path, '/markets/weth-wbtc/dashboard'); assert.equal(response.accepted.spot, '0.03');
  await assert.rejects(loadDashboard('ruba-usdt', async () => reply(body)), /другого рынка/);
});
