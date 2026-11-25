import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSanctionsList, MonitorBot, type TokenRole } from '../monitor-bot.ts';

const vault = '0x1000000000000000000000000000000000000001';
const tokens = { RUBA: '0x2000000000000000000000000000000000000002', USDT: '0x3000000000000000000000000000000000000003' };

function world(dbPath?: string) {
  const state = {
    now: 1000,
    marketPaused: false,
    withdrawalsPaused: { RUBA: false, USDT: false } as Record<TokenRole, boolean>,
    balances: { RUBA: 110_000n * 10n ** 18n, USDT: 1_000n * 10n ** 6n } as Record<TokenRole, bigint>,
    blocked: { RUBA: false, USDT: false } as Record<TokenRole, boolean>,
    custody: { RUBA: 110_000n * 10n ** 18n, USDT: 1_000n * 10n ** 6n } as Record<TokenRole, bigint>,
    unapplied: { RUBA: 0n, USDT: 0n } as Record<TokenRole, bigint>,
    reserves: { RUBA: 100_000n * 10n ** 18n, USDT: 1_000n * 10n ** 6n } as Record<TokenRole, bigint>,
    chainRoot: 5n, roots: [5n], pending: [] as bigint[], nextTradeId: 1n,
    listed: new Set<string>(), rpcDown: false, txs: [] as string[],
  };
  const bot = new MonitorBot({
    market: 'ruba-usdt', vaultAddress: vault, tokenAddresses: tokens, now: () => state.now, stuckAfterSeconds: 900, dbPath,
    sanctions: { isListed: (address) => state.listed.has(address.toLowerCase()) },
    reads: {
      marketPaused: async () => state.marketPaused,
      withdrawalsPaused: async (token) => state.withdrawalsPaused[token],
      vaultBalance: async (token) => { if (state.rpcDown) throw Object.assign(new Error('rpc'), { code: 'SERVER_ERROR' }); return state.balances[token]; },
      probeTransfer: async (token) => !state.blocked[token],
      chainRoot: async () => state.chainRoot,
      unappliedPayouts: async () => ({ ...state.unapplied }),
    },
    actions: {
      pauseMarket: async () => { state.marketPaused = true; state.txs.push('market'); return '0xaa'; },
      pauseWithdrawals: async (token) => { state.withdrawalsPaused[token] = true; state.txs.push(`withdrawals:${token}`); return '0xbb'; },
    },
    ledger: {
      custody: () => ({ ...state.custody }), knownRoots: () => state.roots, pendingVersions: () => state.pending,
      reserves: () => ({ ...state.reserves }), nextTradeId: () => state.nextTradeId,
    },
  });
  return { state, bot };
}

test('quiet market produces no events and no transactions', async () => {
  const { state, bot } = world();
  assert.deepEqual(await bot.check(), []);
  assert.deepEqual(state.txs, []);
  bot.close();
});

test('blocked transfer pauses that token and the market once, then logs recovery', async () => {
  const { state, bot } = world();
  state.blocked.RUBA = true;
  const events = await bot.check();
  assert.deepEqual(state.txs, ['withdrawals:RUBA', 'market']);
  assert.equal(events.length, 1);
  assert.equal(events[0].criterion, 'transfer');
  assert.equal(events[0].severity, 'pause');
  assert.equal(events[0].token, 'RUBA');
  assert.equal(events[0].txHash, '0xbb,0xaa');
  assert.equal(state.withdrawalsPaused.USDT, false);

  state.now += 12;
  assert.deepEqual(await bot.check(), []);
  assert.deepEqual(state.txs, ['withdrawals:RUBA', 'market']);

  state.blocked.RUBA = false;
  state.now += 12;
  const cleared = await bot.check();
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].severity, 'clear');
  assert.equal(state.marketPaused, true, 'the bot never resumes by itself');
  assert.deepEqual(bot.events().map((event) => event.severity), ['pause', 'clear']);
  bot.close();
});

test('sanctions mark raises an alert without touching the vault', async () => {
  const { state, bot } = world();
  state.listed.add(vault.toLowerCase());
  const events = await bot.check();
  assert.equal(events.length, 1);
  assert.equal(events[0].criterion, 'sanctions');
  assert.equal(events[0].severity, 'alert');
  assert.deepEqual(state.txs, []);
  state.listed.clear();
  assert.equal((await bot.check())[0].severity, 'clear');
  bot.close();
});

test('deficit against obligations pauses the market', async () => {
  const { state, bot } = world();
  state.balances.USDT -= 100n * 10n ** 6n;
  const events = await bot.check();
  assert.equal(events[0].criterion, 'coverage');
  assert.equal(events[0].token, 'USDT');
  assert.match(events[0].detail, /Не хватает 100000000/);
  assert.deepEqual(state.txs, ['market']);
  bot.close();
});

test('payout already sent but not yet recorded by the server is not a deficit', async () => {
  const { state, bot } = world();
  state.balances.USDT -= 90_661_089n;
  state.unapplied.USDT = 90_661_089n;
  assert.deepEqual(await bot.check(), []);
  assert.deepEqual(state.txs, []);
  bot.close();
});

test('unknown root and a transition stuck past the limit raise alerts', async () => {
  const { state, bot } = world();
  state.chainRoot = 999n;
  state.pending = [3n];
  let events = await bot.check();
  assert.deepEqual(events.map((event) => event.criterion), ['root']);
  state.now += 901;
  events = await bot.check();
  assert.deepEqual(events.map((event) => event.criterion), ['stuck']);
  state.pending = [];
  state.chainRoot = 5n;
  events = await bot.check();
  assert.deepEqual(events.map((event) => `${event.criterion}:${event.severity}`).sort(), ['root:clear', 'stuck:clear']);
  assert.deepEqual(state.txs, []);
  bot.close();
});

test('price jump and trade burst inside the window raise alerts', async () => {
  const { state, bot } = world();
  await bot.check();
  state.now += 60;
  state.reserves = { RUBA: 70_000n * 10n ** 18n, USDT: 1_430n * 10n ** 6n };
  state.nextTradeId = 60n;
  const events = await bot.check();
  assert.deepEqual(events.map((event) => event.criterion).sort(), ['price', 'volume']);
  assert.deepEqual(state.txs, []);
  bot.close();
});

test('RPC failure is logged as a monitor error, not as a pause', async () => {
  const { state, bot } = world();
  state.rpcDown = true;
  const events = await bot.check();
  assert.ok(events.length >= 1);
  assert.ok(events.every((event) => event.severity === 'error'));
  assert.ok(events.some((event) => /ошибка RPC/.test(event.detail)));
  assert.deepEqual(state.txs, []);
  state.rpcDown = false;
  const back = await bot.check();
  assert.ok(back.every((event) => event.severity === 'clear'));
  bot.close();
});

test('journal survives a restart and the sanctions file is read by address', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monitor-'));
  const dbPath = join(directory, 'monitor.sqlite');
  const first = world(dbPath);
  first.state.blocked.USDT = true;
  await first.bot.check();
  first.bot.close();
  const second = world(dbPath);
  assert.deepEqual(second.bot.events().map((event) => `${event.criterion}:${event.severity}:${event.token}`), ['transfer:pause:USDT']);
  second.bot.close();

  const list = join(directory, 'list.json');
  writeFileSync(list, JSON.stringify({ addresses: [tokens.RUBA] }));
  const sanctions = new FileSanctionsList(list);
  assert.equal(sanctions.isListed(tokens.RUBA), true);
  assert.equal(sanctions.isListed(vault), false);
  assert.equal(new FileSanctionsList(join(directory, 'missing.json')).isListed(vault), false);
});
