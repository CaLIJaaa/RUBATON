import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hashPair, hashReceipt } from '../../server/merkle.ts';
import { comparePublication, createDemoDisclosure, displayFee, displayTokenAmount, inspectDisclosure, inspectDisclosureText, parseDisclosure, selectDisclosureMarket } from '../disclosure-model.js';
import * as zk from '../../zk/crypto.js';
import { createDisclosurePage } from '../disclosure.js';

const html = readFileSync(new URL('../disclosure.html', import.meta.url), 'utf8');
const wire = (value) => JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
const bundle = () => { const data = createDemoDisclosure(); delete data.demo; return data; };
const singleTradeBundle = () => {
  const data = bundle();
  data.batch.tradeCount = '1';
  data.batch.receiptsRoot = data.receipt.leaf;
  data.receipt.proof = [];
  return data;
};
const parsed = (data = bundle()) => parseDisclosure(JSON.stringify(data));
function publication(data, options = {}) {
  return { chainId: data.receipt.chainId, vault: data.receipt.vault, tokens: data.tokens, status: 'published', source: 'contract', batch: data.batch, ...options };
}

function zkBundle(index = 0, count = 4) {
  const data = bundle();
  data.version = 2;
  const receipts = Array.from({ length: count }, (_, i) => ({ ...data.receipt, version: 2, schemaVersion: 2,
    tradeId: (i + 1).toString(), salt: zk.fieldHex(BigInt(11 + i)) }));
  const tree = zk.buildReceiptTreeV2(receipts);
  data.receipt = { ...receipts[index], leaf: zk.fieldHex(tree.leaves[index]), proof: tree.proofs[index].map(zk.fieldHex) };
  data.batch = { ...data.batch, tradeCount: String(count), version: 2, stateVersion: '7', previousStateRoot: zk.fieldHex(123n), newStateRoot: zk.fieldHex(456n), receiptsRoot: zk.fieldHex(tree.root) };
  return data;
}

test('v2 receipt proofs use Poseidon and ordered positions for all four trades while historical v1 stays separate', async () => {
  for (let i = 0; i < 4; i++) {
    const data = zkBundle(i);
    const result = await inspectDisclosureText(JSON.stringify(data));
    assert.equal(result.valid, true);
    assert.equal(result.bundle.version, 2);
    assert.equal(result.calculatedLeaf, zk.fieldHex(zk.hashReceiptV2(data.receipt)));
    assert.notEqual(result.calculatedLeaf, hashReceipt(data.receipt));
    const changed = structuredClone(data); changed.receipt.tradeId = String((i + 1) % 4 + 1);
    assert.equal((await inspectDisclosureText(JSON.stringify(changed))).valid, false);
  }
});

test('v2 rejects out-of-field roots, mixed schemas and invalid trade counts before verification', async () => {
  const data = zkBundle();
  data.batch.receiptsRoot = '0x' + zk.FIELD.toString(16).padStart(64, '0');
  await assert.rejects(inspectDisclosureText(JSON.stringify(data)), /вне поля/);
  const mixed = zkBundle(); mixed.version = 1;
  assert.throws(() => parseDisclosure(JSON.stringify(mixed)), /Версии/);
  const invalid = zkBundle(); invalid.batch.tradeCount = '5';
  assert.throws(() => parseDisclosure(JSON.stringify(invalid)), /от 1 до 4/);
});

test('a v2 uploaded root can only be confirmed against the actual ZK vault mode', async () => {
  const data = zkBundle(); const parsed = (await inspectDisclosureText(JSON.stringify(data))).bundle;
  assert.throws(() => comparePublication(parsed, publication(data)), /ZK Vault/);
  assert.equal(comparePublication(parsed, publication(data, { proofMode: 'zk' })).published, true);
  assert.equal(comparePublication(parsed, publication(data, { proofMode: 'zk', source: 'server' })).published, false);
});

test('disclosure reads a single-trade receipt exactly and matches the server receipt schema', () => {
  const data = parsed(singleTradeBundle());
  const inspection = inspectDisclosure(data);
  assert.equal(data.receipt.amountIn, 100n * 10n ** 18n);
  assert.ok(data.receipt.amountIn > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(inspection.calculatedLeaf, hashReceipt(data.receipt));
  assert.equal(inspection.valid, true);
  assert.deepEqual(data.receipt.proof, []);
  assert.equal(displayTokenAmount(data, data.receipt.tokenIn, data.receipt.amountIn), '100 RUBA');
  assert.equal(displayTokenAmount(data, data.receipt.tokenOut, data.receipt.amountOut), '90.661089 USDT');
  assert.equal(displayFee(data), '0.3 RUBA');
});

test('current demo discloses one trade from a four-leaf batch with a two-element proof', () => {
  const data = parseDisclosure(JSON.stringify(createDemoDisclosure()));
  assert.equal(data.demo, true);
  assert.equal(data.batch.tradeCount, 4n);
  assert.equal(data.receipt.proof.length, 2);
  assert.equal(inspectDisclosure(data).valid, true);
  assert.notEqual(data.batch.receiptsRoot, data.receipt.leaf);
});

test('disclosure verifies legacy four-trade roots and odd three-trade roots without changing sorted-pair encoding', () => {
  for (const size of [2, 3, 4]) {
    const data = bundle();
    const leaves = Array.from({ length: size }, (_unused, i) => {
      const item = { ...parsed(data).receipt, tradeId: BigInt(i + 1), salt: '0x' + (i + 1).toString(16).padStart(2, '0').repeat(32) };
      return { item, leaf: hashReceipt(item) };
    });
    const paired = size === 2 ? [] : [hashPair(leaves[0].leaf, leaves[1].leaf), hashPair(leaves[2].leaf, (leaves[3] ?? leaves[2]).leaf)];
    const root = size === 2 ? hashPair(leaves[0].leaf, leaves[1].leaf) : hashPair(paired[0], paired[1]);
    for (let index = 0; index < size; index++) {
      const sibling = leaves[index ^ 1] ?? leaves[index];
      data.receipt = wire({ ...leaves[index].item, leaf: leaves[index].leaf, proof: [sibling.leaf, ...(size > 2 ? [paired[(index >> 1) ^ 1]] : [])] });
      data.batch.tradeCount = String(size);
      data.batch.receiptsRoot = root;
      assert.equal(inspectDisclosure(parsed(data)).valid, true, `size ${size}, leaf ${index}`);
    }
  }
});

test('editing disclosed amounts cannot retain a valid receipt hash or proof', () => {
  const data = bundle();
  data.receipt.amountOut = (BigInt(data.receipt.amountOut) + 1n).toString();
  const result = inspectDisclosure(parsed(data));
  assert.equal(result.leafMatches, false);
  assert.equal(result.proofMatches, false);
  assert.equal(result.valid, false);
});

test('a self-consistent uploaded root is not treated as contract publication', () => {
  const data = parsed();
  assert.equal(inspectDisclosure(data).valid, true);
  assert.equal(comparePublication(data, publication(wire(data), { source: 'server' })).published, false);
  assert.equal(comparePublication(data, publication(wire(data), { source: undefined })).published, false);
  assert.equal(comparePublication(data, publication(wire(data), { status: 'pending' })).published, false);
  assert.equal(comparePublication(data, publication(wire(data))).published, true);
  const wrong = publication(wire(data));
  wrong.batch.receiptsRoot = '0x' + '11'.repeat(32);
  assert.throws(() => comparePublication(data, wrong), /Корни пакета/);
  assert.throws(() => comparePublication(data, publication(wire(data), { chainId: '1' })), /другой сети/);
});

test('disclosure rejects rounded JSON numbers, invalid proofs and mismatched batch/token metadata', () => {
  const number = bundle(); number.receipt.amountIn = 1e20;
  assert.throws(() => parsed(number), /десятичной строкой/);
  const exponent = bundle(); exponent.receipt.amountIn = '1e20';
  assert.throws(() => parsed(exponent), /десятичной строкой/);
  const invalidProof = bundle(); invalidProof.receipt.proof = ['0x' + '11'.repeat(32)];
  assert.throws(() => parsed(invalidProof), /длина proof 2/);
  const wrongBatch = bundle(); wrongBatch.receipt.tradeId = '5';
  assert.throws(() => parsed(wrongBatch), /Идентификаторы/);
  const wrongToken = bundle(); wrongToken.tokens.USDT.address = '0x0000000000000000000000000000000000000099';
  assert.throws(() => parsed(wrongToken), /метаданными пары/);
  const denominator = bundle(); denominator.receipt.feeDenominator = '0';
  assert.throws(() => parsed(denominator), /диапазона/);
});

test('uncommitted token labels cannot be confirmed against real publication metadata', () => {
  const original = bundle();
  const swapped = bundle();
  swapped.tokens.RUBA.address = original.tokens.USDT.address;
  swapped.tokens.USDT.address = original.tokens.RUBA.address;
  const data = parsed(swapped);
  assert.equal(inspectDisclosure(data).valid, true, 'token labels are not part of the committed receipt');
  assert.throws(() => comparePublication(data, publication(original)), /Названия или точность/);
  assert.equal(comparePublication(parsed(), publication(original, { tokens: undefined })).published, false);
});

test('unknown token labels fall back to exact atomic units and fractional fees are not rounded away', () => {
  const unknown = bundle(); delete unknown.tokens;
  const data = parsed(unknown);
  assert.match(displayTokenAmount(data, data.receipt.tokenIn, data.receipt.amountIn), /^100000000000000000000 мин\. единиц/);
  const tiny = bundle(); tiny.receipt.feeNumerator = '3'; tiny.receipt.feeDenominator = '1000';
  assert.equal(displayFee(parsed(tiny)), '0.000000000000000003 / 1000 RUBA');
});

function fixture(fetchOverride, catalog) {
  class Element {
    constructor(attributes = '') {
      this.hidden = /\bhidden\b/.test(attributes);
      this.disabled = /\bdisabled\b/.test(attributes);
      this.value = '';
      this.textContent = '';
      this.children = [];
      this.files = [];
      this.listeners = {};
    }
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    set innerHTML(_value) { throw new Error('Disclosure must use textContent, not HTML'); }
    async fire(name) {
      for (const callback of this.listeners[name] ?? []) await callback({ preventDefault() {} });
    }
  }
  const elements = new Map([...html.matchAll(/<[a-z0-9]+\b([^>]*\bid="([^"]+)"[^>]*)>/gi)].map((match) => [match[2], new Element(match[1])]));
  const element = (id) => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); };
  const requests = [];
  const controller = createDisclosurePage({ getElementById: element, createElement: () => new Element() }, async (url, options) => {
    requests.push({ url, options });
    if (url === '/markets') return catalog === undefined ? { ok: false, status: 404, json: async () => ({ error: 'Legacy single market' }) }
      : typeof catalog === 'function' ? catalog(url, options) : { ok: true, status: 200, json: async () => catalog };
    if (fetchOverride) return fetchOverride(url, options);
    return { ok: true, json: async () => publication(bundle()) };
  });
  function fill(data = bundle()) { element('disclosure-json').value = JSON.stringify(data); }
  function text(id) {
    const read = (item) => [item.textContent, ...item.children.map(read)].join(' ');
    return read(element(id));
  }
  return { element, controller, requests, fill, text };
}

test('standalone disclosure is usable without a wallet, entry consent or network requests', async () => {
  const f = fixture();
  assert.equal(f.element('disclosure-submit').disabled, false);
  assert.equal(f.element('disclosure-result').hidden, true);
  await f.element('disclosure-demo').fire('click');
  assert.equal(f.element('disclosure-result').hidden, false);
  assert.equal(f.element('disclosure-demo-notice').hidden, false);
  assert.equal(f.element('disclosure-publication').disabled, true);
  assert.match(f.text('disclosure-summary'), /100 RUBA/);
  assert.match(f.text('disclosure-summary'), /90\.661089 USDT/);
  assert.match(f.text('disclosure-summary'), /сделок в пакете: 4/);
  assert.match(f.element('disclosure-local').textContent, /Локальная проверка пройдена/);
  assert.match(f.element('disclosure-chain').textContent, /Демопример не опубликован/);
  assert.equal(f.requests.length, 0);
});

test('a real supplied disclosure displays locally and queries only its public batch on explicit request', async () => {
  const f = fixture();
  f.fill();
  await f.element('disclosure-form').fire('submit');
  assert.equal(f.element('disclosure-demo-notice').hidden, true);
  assert.equal(f.requests.length, 0);
  await f.element('disclosure-publication').fire('click');
  assert.deepEqual(f.requests.map((item) => item.url), ['/markets', '/disclosure/batches/1']);
  assert.equal(f.requests[0].options.body, undefined);
  assert.match(f.element('disclosure-chain').textContent, /Публикация подтверждена/);
});

test('invalid or changed input clears the previous successful result', async () => {
  const f = fixture();
  f.fill(); await f.element('disclosure-form').fire('submit');
  assert.equal(f.element('disclosure-result').hidden, false);
  f.element('disclosure-json').value = '{ invalid';
  await f.element('disclosure-form').fire('submit');
  assert.equal(f.element('disclosure-result').hidden, true);
  assert.equal(f.element('disclosure-summary').children.length, 0);
  assert.equal(f.element('disclosure-proof').children.length, 0);
  assert.equal(f.element('disclosure-publication').disabled, true);
  assert.equal(f.element('disclosure-error').hidden, false);
  f.fill(); await f.element('disclosure-form').fire('submit');
  await f.element('disclosure-json').fire('input');
  assert.equal(f.element('disclosure-result').hidden, true);
  assert.equal(f.element('disclosure-publication').disabled, true);
});

test('stale publication responses cannot restore a success after the user changes the JSON', async () => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { markStarted(); await pending; return { ok: true, json: async () => publication(bundle()) }; });
  f.fill(); await f.element('disclosure-form').fire('submit');
  const checking = f.element('disclosure-publication').fire('click');
  await started;
  await f.element('disclosure-json').fire('input');
  release(); await checking;
  assert.equal(f.element('disclosure-result').hidden, true);
  assert.equal(f.element('disclosure-publication').disabled, true);
  assert.doesNotMatch(f.element('disclosure-chain').textContent, /Публикация подтверждена/);
});

test('file import renders a disclosure and an oversized file removes the prior result', async () => {
  const f = fixture();
  f.element('disclosure-file').files = [{ size: 100, text: async () => JSON.stringify(bundle()) }];
  await f.element('disclosure-file').fire('change');
  assert.equal(f.element('disclosure-result').hidden, false);
  f.element('disclosure-file').files = [{ size: 300_000, text: async () => { throw new Error('should not read'); } }];
  await f.element('disclosure-file').fire('change');
  assert.equal(f.element('disclosure-result').hidden, true);
  assert.match(f.element('disclosure-error').textContent, /256 КиБ/);
});

test('publication errors remain plain text and never claim onchain verification', async () => {
  const message = '<img src=x onerror=alert(1)>';
  const f = fixture(async () => ({ ok: false, json: async () => ({ error: message }) }));
  f.fill(); await f.element('disclosure-form').fire('submit');
  await f.element('disclosure-publication').fire('click');
  assert.match(f.element('disclosure-chain').textContent, /Публикация не подтверждена/);
  assert.ok(f.element('disclosure-chain').textContent.includes(message));
  assert.equal(f.element('disclosure-publication').disabled, false);
});

test('generic token symbols and decimals 18, 6 and 8 drive amounts, fees and reserve display', async () => {
  for (const [symbol, decimals, expected] of [
    ['USDT', 6, '90.661089 USDT'], ['WETH', 18, '0.000000000090661089 WETH'], ['WBTC', 8, '0.90661089 WBTC'],
  ]) {
    const data = singleTradeBundle();
    data.tokens.RUBA.symbol = symbol === 'WBTC' ? 'WETH' : 'RUBA';
    data.tokens.USDT.symbol = symbol; data.tokens.USDT.decimals = decimals;
    const inspection = inspectDisclosure(parsed(data));
    assert.equal(inspection.valid, true);
    assert.equal(displayTokenAmount(inspection.bundle, inspection.bundle.receipt.tokenOut, inspection.bundle.receipt.amountOut), expected);
    assert.equal(displayFee(inspection.bundle), `0.3 ${data.tokens.RUBA.symbol}`);
    const f = fixture(); f.fill(data); await f.controller.show();
    assert.ok(f.text('disclosure-summary').includes(expected));
    assert.match(f.element('disclosure-pair').textContent, new RegExp(symbol));
    assert.ok(f.text('disclosure-summary').includes(symbol === 'WBTC' ? '10 WBTC' : symbol === 'WETH' ? '0.000000001 WETH' : '1000 USDT'));
  }
});

test('generic symbols remain uncommitted metadata and must match the public Vault metadata', () => {
  const data = bundle(); data.tokens.RUBA.symbol = 'WETH'; data.tokens.USDT.symbol = 'WBTC'; data.tokens.USDT.decimals = 8;
  const result = parsed(data);
  assert.equal(inspectDisclosure(result).valid, true);
  assert.equal(comparePublication(result, publication(data)).published, true);
  const wrongSymbol = structuredClone(data); wrongSymbol.tokens.USDT.symbol = 'USDT';
  assert.throws(() => comparePublication(result, publication(wrongSymbol)), /Названия или точность/);
  for (const value of ['<IMG>', 'wbtc', 'A'.repeat(13)]) {
    const invalid = structuredClone(data); invalid.tokens.USDT.symbol = value;
    assert.throws(() => parsed(invalid), /символ/);
  }
  for (const value of [-1, 19, 8.5]) {
    const invalid = structuredClone(data); invalid.tokens.USDT.decimals = value;
    assert.throws(() => parsed(invalid), /точность/);
  }
});

function marketCatalog(data, markets = []) {
  return { defaultMarketId: 'ruba-usdt', markets: [
    { id: 'ruba-usdt', label: 'RUBA / USDT', chainId: data.receipt.chainId, vault: '0x0000000000000000000000000000000000000099' },
    { id: 'weth-wbtc', label: 'WETH / WBTC', chainId: data.receipt.chainId, vault: data.receipt.vault }, ...markets,
  ] };
}

test('disclosure resolves the exact receipt chain and Vault rather than an untrusted market label', async () => {
  const data = bundle(); data.marketId = 'ruba-usdt';
  data.tokens.RUBA.symbol = 'WETH'; data.tokens.USDT.symbol = 'WBTC'; data.tokens.USDT.decimals = 8;
  const f = fixture(async (url) => {
    assert.equal(url, '/markets/weth-wbtc/disclosure/batches/1');
    return { ok: true, json: async () => publication(data) };
  }, marketCatalog(data));
  f.fill(data); await f.controller.show();
  assert.equal(f.requests.length, 0, 'local disclosure never lists markets or queries batch data');
  await f.element('disclosure-publication').fire('click');
  assert.deepEqual(f.requests.map((request) => request.url), ['/markets', '/markets/weth-wbtc/disclosure/batches/1']);
  assert.match(f.element('disclosure-chain').textContent, /Публикация подтверждена/);
  assert.equal(f.element('disclosure-pair').textContent, 'WETH / WBTC · WETH / WBTC');
  assert.equal(f.element('disclosure-exchange').href, '/?market=weth-wbtc');
  await f.element('disclosure-json').fire('input');
  assert.equal(f.element('disclosure-exchange').href, '/');
});

test('colliding trade and batch IDs cannot confirm a receipt from another pool', async () => {
  const data = singleTradeBundle();
  data.receipt.vault = '0x0000000000000000000000000000000000000088';
  data.receipt.leaf = hashReceipt(parsed(data).receipt); data.batch.receiptsRoot = data.receipt.leaf;
  const f = fixture(async () => ({ ok: true, json: async () => publication(singleTradeBundle()) }), marketCatalog(data));
  f.fill(data); await f.controller.show();
  assert.match(f.element('disclosure-local').textContent, /проверка пройдена/);
  await f.element('disclosure-publication').fire('click');
  assert.deepEqual(f.requests.map((request) => request.url), ['/markets', '/markets/weth-wbtc/disclosure/batches/1']);
  assert.match(f.element('disclosure-chain').textContent, /другой сети или другому Vault/);
  assert.doesNotMatch(f.element('disclosure-chain').textContent, /Публикация подтверждена/);
});

test('unknown, malformed or ambiguous market catalogs never fall back to another pool', async () => {
  const data = bundle();
  const wrongChain = marketCatalog(data); wrongChain.markets[1].chainId = '1';
  const malformedId = marketCatalog(data); malformedId.markets[1].id = '../ruba-usdt';
  const ambiguous = marketCatalog(data, [{ id: 'duplicate', chainId: data.receipt.chainId, vault: data.receipt.vault }]);
  for (const catalog of [wrongChain, malformedId, ambiguous, { markets: undefined }]) {
    const f = fixture(async () => { throw new Error('No batch request is allowed'); }, catalog);
    f.fill(data); await f.controller.show(); await f.element('disclosure-publication').fire('click');
    assert.deepEqual(f.requests.map((request) => request.url), ['/markets']);
    assert.match(f.element('disclosure-chain').textContent, /Публикация не подтверждена/);
  }
  assert.throws(() => selectDisclosureMarket(parsed(data), ambiguous), /неоднозначно/);
});

test('changing a disclosure during catalog lookup prevents any stale batch request or confirmation', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { throw new Error('No stale batch request is allowed'); }, async () => {
    await pending;
    return { ok: true, status: 200, json: async () => marketCatalog(bundle()) };
  });
  f.fill(); await f.element('disclosure-form').fire('submit');
  const checking = f.element('disclosure-publication').fire('click');
  await f.element('disclosure-json').fire('input');
  release(); await checking;
  assert.deepEqual(f.requests.map((request) => request.url), ['/markets']);
  assert.equal(f.element('disclosure-result').hidden, true);
  assert.doesNotMatch(f.element('disclosure-chain').textContent, /Публикация подтверждена/);
});

for (const count of [1, 2, 3]) test(`v2 discloses each actual trade in a ${count}-swap padded four-leaf batch`, async () => {
  for (let i = 0; i < count; i++) {
    const data = zkBundle(i, count);
    const result = await inspectDisclosureText(JSON.stringify(data));
    assert.equal(result.valid, true);
    assert.equal(result.bundle.batch.tradeCount, BigInt(count));
    assert.equal(result.bundle.receipt.proof.length, 2);
  }
  const padding = zkBundle(count - 1, count); padding.receipt.tradeId = String(count + 1);
  assert.throws(() => parseDisclosure(JSON.stringify(padding)), /диапазон|пакет/);
});
