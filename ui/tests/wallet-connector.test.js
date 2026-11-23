import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWalletConnector } from '../wallet-connector.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ loader, timeoutMs = 1_000 } = {}) {
  const sessions = [];
  const disconnected = [];
  const state = { wallets: [] };
  let loads = 0;
  let cancelled = 0;
  const sdk = {
    state: { get: () => state },
    connectWallet() { const session = deferred(); sessions.push(session); return session.promise; },
    async disconnectWallet({ label }) { disconnected.push(label); state.wallets = state.wallets.filter((wallet) => wallet.label !== label); },
    cancelConnect() { cancelled++; },
  };
  const connector = createWalletConnector({ chainId: '11155111' }, { timeoutMs, loadSdk: loader ?? (async () => {
    loads++;
    return { createOnboard(config) { assert.equal(config.chainId, '11155111'); return sdk; } };
  }) });
  return { connector, sessions, disconnected, state, loads: () => loads, cancelled: () => cancelled };
}

test('wallet SDK is lazy and returns the selected EIP1193 provider without application signatures', async () => {
  const f = fixture();
  assert.equal(f.loads(), 0);
  await f.connector.disconnect();
  assert.equal(f.loads(), 0);
  const pending = f.connector.connect();
  assert.equal(f.connector.connect(), pending, 'double clicking must reuse the existing request');
  await flush();
  const provider = { request() { throw new Error('connector must not issue application RPC'); } };
  f.sessions[0].resolve([{ label: 'Rabby Wallet', provider }]);
  assert.deepEqual(await pending, { label: 'Rabby Wallet', provider });
  assert.equal(f.loads(), 1);
});

test('closing the native selector returns null and another explicit connection can start', async () => {
  const f = fixture();
  const first = f.connector.connect(); await flush();
  f.sessions[0].resolve([]);
  assert.equal(await first, null);
  const second = f.connector.connect(); await flush();
  f.sessions[1].resolve([{ label: 'MetaMask', provider: { request() {} } }]);
  assert.equal((await second).label, 'MetaMask');
});

test('cancel releases a never-resolving wallet request immediately and late old selection cannot disconnect a newer wallet', async () => {
  const f = fixture();
  const first = f.connector.connect(); await flush();
  f.connector.cancel();
  assert.equal(await first, null);
  assert.equal(f.cancelled(), 1);
  const second = f.connector.connect(); await flush();
  const provider = { request() {} };
  f.sessions[1].resolve([{ label: 'New wallet', provider }]);
  assert.equal((await second).provider, provider);
  f.sessions[0].resolve([{ label: 'Old wallet', provider: { request() {} } }]);
  await flush();
  assert.deepEqual(f.disconnected, [], 'an old asynchronous result must never disconnect a newer SDK connection');
});

test('cancel during SDK loading never starts a wallet prompt and the cached module can be used later', async () => {
  const loading = deferred();
  let connects = 0;
  const sdk = { state: { get: () => ({ wallets: [] }) }, connectWallet: async () => { connects++; return []; } };
  const f = fixture({ loader: () => loading.promise });
  const first = f.connector.connect(); await flush(); f.connector.cancel();
  assert.equal(await first, null);
  loading.resolve({ createOnboard: () => sdk }); await flush();
  assert.equal(connects, 0);
  assert.equal(await f.connector.connect(), null);
  assert.equal(connects, 1);
});

test('disconnect clears every connected SDK wallet and permits a fresh selection', async () => {
  const f = fixture();
  const pending = f.connector.connect(); await flush();
  f.state.wallets = [{ label: 'MetaMask', provider: { request() {} } }, { label: 'Rabby Wallet', provider: { request() {} } }];
  f.sessions[0].resolve(f.state.wallets); await pending;
  await f.connector.disconnect();
  assert.deepEqual(f.disconnected, ['MetaMask', 'Rabby Wallet']);
  assert.deepEqual(f.state.wallets, []);
  const next = f.connector.connect(); await flush(); f.sessions[1].resolve([]);
  assert.equal(await next, null);
});

test('a new selection waits for an earlier asynchronous disconnect with the same wallet label', async () => {
  const cleanup = deferred();
  const events = [];
  const state = { wallets: [{ label: 'MetaMask' }] };
  const sdk = {
    state: { get: () => state },
    async disconnectWallet({ label }) { events.push(`disconnect:${label}`); await cleanup.promise; state.wallets = []; },
    async connectWallet() { events.push('connect'); return []; },
  };
  const connector = createWalletConnector({ chainId: '11155111' }, { loadSdk: async () => ({ createOnboard: () => sdk }) });
  const first = connector.connect(); await flush();
  connector.cancel(); assert.equal(await first, null);
  const disconnecting = connector.disconnect();
  const next = connector.connect(); await flush();
  assert.deepEqual(events, ['disconnect:MetaMask'], 'a fresh selection cannot race old SDK cleanup');
  cleanup.resolve(); await disconnecting;
  assert.equal(await next, null);
  assert.deepEqual(events, ['disconnect:MetaMask', 'connect']);
});

test('failed SDK loading or wallet rejection releases the connection for an explicit retry', async () => {
  let calls = 0;
  const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
  const connector = createWalletConnector({ chainId: 11155111 }, { loadSdk: async () => {
    if (++calls === 1) throw new Error('Network failure');
    return { createOnboard: () => ({ state: { get: () => ({ wallets: [] }) }, connectWallet: async () => { throw rejection; } }) };
  } });
  await assert.rejects(connector.connect(), /Network failure/);
  await assert.rejects(connector.connect(), (error) => error === rejection);
  assert.equal(calls, 2);
});

test('connection timeout closes the selector and does not accept a late wallet result', async () => {
  const f = fixture({ timeoutMs: 15 });
  const pending = f.connector.connect(); await flush();
  // Keep the event loop alive because browser timers have no unref equivalent.
  const waiting = new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(pending, /Время подключения истекло/);
  await waiting;
  assert.equal(f.cancelled(), 1);
  f.sessions[0].resolve([{ label: 'Late wallet', provider: { request() {} } }]); await flush();
  assert.deepEqual(f.disconnected, []);
});

function onboardEntryFixture() {
  const source = readFileSync(new URL('../wallet-onboard-entry.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export function createOnboard', 'function createOnboard');
  let options;
  let modal;
  let closeClicks = 0;
  const errors = [];
  const state = { wallets: [] };
  const choose = async (original, label) => {
    const pending = modal;
    const modules = options.wallets[0]({ device: {} });
    const selected = await modules[0].getInterface(original);
    try {
      const accounts = await selected.provider.request({ method: 'eth_requestAccounts' });
      await selected.provider.request({ method: 'eth_chainId' });
      const wallet = { label, provider: selected.provider, accounts };
      state.wallets.push(wallet);
      pending.resolve([wallet]);
    } catch (error) { errors.push(error); }
  };
  const context = vm.createContext({
    queueMicrotask,
    document: { querySelector(selector) {
      assert.equal(selector, 'onboard-v2');
      return { shadowRoot: { querySelector(selector) {
        assert.equal(selector, '.button-container .close-button');
        return { click() { closeClicks++; modal?.resolve([]); } };
      } } };
    } },
    injectedWallets(settings) {
      assert.equal(settings.disable6963Support, false);
      assert.equal(settings.displayUnavailable, false);
      return () => [{ label: 'Injected', getInterface: async (provider) => ({ provider }) }];
    },
    Onboard(settings) {
      options = settings;
      return {
        state: { get: () => state, actions: { setLocale(locale) { assert.equal(locale, 'ru'); } } },
        connectWallet() { modal = deferred(); return modal.promise; },
        async disconnectWallet({ label }) { state.wallets = state.wallets.filter((wallet) => wallet.label !== label); },
      };
    },
  });
  vm.runInContext(source, context);
  const sdk = vm.runInContext('createOnboard({chainId:"11155111"})', context);
  return { sdk, state, choose, errors, options: () => options, closeClicks: () => closeClicks };
}

test('production SDK entry disables automatic reconnect, notifications, account center and font downloads', () => {
  const f = onboardEntryFixture();
  const options = f.options();
  assert.equal(options.chains[0].id, '0xaa36a7');
  assert.equal(options.connect.autoConnectLastWallet, false);
  assert.equal(options.connect.autoConnectAllPreviousWallet, false);
  assert.equal(options.connect.disableClose, false);
  assert.equal(options.accountCenter.desktop.enabled, false);
  assert.equal(options.accountCenter.mobile.enabled, false);
  assert.equal(options.notify.enabled, false);
  assert.equal(options.disableFontDownload, true);
});

test('production injected guard blocks late approval after cancellation without closing or overwriting a newer SDK selection', async () => {
  const f = onboardEntryFixture();
  const oldAccounts = deferred();
  const oldProvider = { request: ({ method }) => method === 'eth_requestAccounts' ? oldAccounts.promise : Promise.resolve('0xaa36a7') };
  const first = f.sdk.connectWallet();
  const oldChoice = f.choose(oldProvider, 'Old wallet'); await flush();
  f.sdk.cancelConnect();
  const newProvider = { request: async ({ method }) => method === 'eth_requestAccounts' ? ['0x' + '22'.repeat(20)] : '0xaa36a7' };
  const second = f.sdk.connectWallet();
  assert.equal((await first).length, 0);
  await f.choose(newProvider, 'New wallet');
  const selected = await second;
  assert.equal(selected[0].provider, newProvider, 'the application receives the original selected provider');
  oldAccounts.resolve(['0x' + '11'.repeat(20)]); await oldChoice; await flush();
  assert.equal(f.state.wallets.length, 1);
  assert.equal(f.state.wallets[0].label, 'New wallet');
  assert.equal(f.closeClicks(), 1, 'old close microtasks must not close the new selector');
  assert.equal(f.errors[0]?.code, 4001, 'late approval is rejected before SDK addWallet');
});
