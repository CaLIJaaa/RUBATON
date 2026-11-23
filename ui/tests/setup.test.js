import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../setup.html', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../setup.js', import.meta.url), 'utf8');
const ADMIN = 'https://virtual.mainnet.eu.rpc.tenderly.co/test/project/private-endpoint';
const PUBLIC = 'https://virtual.mainnet.eu.rpc.tenderly.co/test/project/public-endpoint';
const WALLET = '0x0000000000000000000000000000000000000011';
const active = {
  chainId: '9991', testWalletAddress: WALLET,
  vaultAddress: '0x0000000000000000000000000000000000000022',
  rubaAddress: '0x0000000000000000000000000000000000000033',
  usdtAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', publicRpcUrl: PUBLIC,
};

async function fixture(initialStatus = {}) {
  class Element {
    constructor(attributes = '') {
      this.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
      this.hidden = /\bhidden\b/.test(attributes);
      this.disabled = /\bdisabled\b/.test(attributes);
      this.textContent = '';
      this.children = [];
      this.listeners = {};
    }
    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
    replaceChildren() { this.children = []; }
    append(item) { this.children.push(item); }
    async fire(type) {
      const event = { preventDefault() {} };
      for (const callback of this.listeners[type] ?? []) await callback(event);
      await flush();
    }
  }
  const elements = new Map([...html.matchAll(/<[a-z0-9]+\b([^>]*\bid="([^"]+)"[^>]*)>/gi)]
    .map((match) => [match[2], new Element(match[1])]));
  const element = (id) => {
    assert.ok(elements.has(id), `Missing setup HTML element #${id}`);
    return elements.get(id);
  };
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  const state = {
    status: { phase: 'idle', csrfToken: 'csrf-token', logs: [], ...initialStatus },
    failStatus: false, failStart: '', startPhase: 'running',
  };
  const context = vm.createContext({
    URL, Error, console,
    document: { getElementById: element, createElement: () => new Element() },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === '/setup/status') {
        if (state.failStatus) throw new Error('network unavailable');
        return { ok: true, json: async () => structuredClone(state.status) };
      }
      if (state.failStart) return { ok: false, json: async () => ({ error: state.failStart }) };
      state.status = { ...state.status, phase: state.startPhase, logs: ['Проверяю RPC', '<script>untrusted log</script>'], ...(state.startPhase === 'ready' ? { active } : {}) };
      return { ok: true, json: async () => ({ accepted: true }) };
    },
  });
  async function flush() {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  vm.runInContext(controller, context, { filename: 'ui/setup.js' });
  await flush();
  function fill() {
    element('setup-admin-rpc').value = ADMIN;
    element('setup-public-rpc').value = PUBLIC;
    element('setup-wallet').value = WALLET;
  }
  async function poll() {
    const entry = timers.entries().next().value;
    assert.ok(entry, 'A running job must schedule a status poll');
    timers.delete(entry[0]);
    await entry[1]();
    await flush();
  }
  return { element, requests, timers, state, fill, poll };
}

test('Tenderly form starts without wallet connection, reports progress and opens the prepared market', async () => {
  const f = await fixture();
  assert.equal(f.element('setup-fields').disabled, false);
  assert.equal(f.element('setup-submit').disabled, false);
  f.fill();
  await f.element('setup-form').fire('submit');
  const post = f.requests.find((request) => request.path === '/setup/start');
  assert.equal(post.options.headers['x-ruba-setup-token'], 'csrf-token');
  assert.deepEqual(JSON.parse(post.options.body), {
    rpcUrl: ADMIN, publicRpcUrl: PUBLIC, testWalletAddress: WALLET,
    walletEth: '10', walletRuba: '10000', walletUsdt: '10000', seedRuba: '1000', seedUsdt: '1000',
  });
  assert.equal(f.element('setup-fields').disabled, true);
  assert.equal(f.element('setup-submit').disabled, true);
  assert.equal(f.element('setup-result').hidden, true);
  assert.equal(f.element('setup-log').children[1].textContent, '<script>untrusted log</script>');
  f.state.status = { ...f.state.status, phase: 'ready', active, canResume: true };
  await f.poll();
  assert.equal(f.element('setup-fields').disabled, false);
  assert.equal(f.element('setup-submit').disabled, false);
  assert.equal(f.element('setup-result').hidden, false);
  assert.equal(f.element('setup-chain-id').textContent, '9991');
  assert.equal(f.element('setup-result-rpc').textContent, PUBLIC);
  assert.equal(f.element('setup-admin-rpc').value, '', 'the Admin URL must be cleared after successful preparation');
  assert.equal(f.element('setup-resume').hidden, false);
  assert.equal(f.timers.size, 0);
});

test('failed setup keeps entered data and enables correction and retry', async () => {
  const f = await fixture();
  f.fill();
  f.state.failStart = 'Admin RPC недоступен';
  await f.element('setup-form').fire('submit');
  assert.equal(f.element('setup-submit').disabled, false);
  assert.equal(f.element('setup-fields').disabled, false);
  assert.equal(f.element('setup-admin-rpc').value, ADMIN);
  assert.match(f.element('setup-error').textContent, /Admin RPC/);
  f.state.failStart = '';
  f.state.startPhase = 'ready';
  await f.element('setup-form').fire('submit');
  assert.equal(f.element('setup-result').hidden, false);
  assert.equal(f.element('setup-error').hidden, true);
  assert.equal(f.element('setup-admin-rpc').value, '');
});

test('a failed status request never traps controls and refresh restores a running or ready job', async () => {
  const f = await fixture();
  f.fill();
  await f.element('setup-form').fire('submit');
  f.state.failStatus = true;
  await f.poll();
  assert.equal(f.element('setup-fields').disabled, false);
  assert.equal(f.element('setup-refresh').disabled, false);
  assert.equal(f.element('setup-error').hidden, false);
  assert.match(f.element('setup-status').textContent, /Обновить статус/);
  f.state.failStatus = false;
  f.state.status = { ...f.state.status, phase: 'ready', active };
  await f.element('setup-refresh').fire('click');
  assert.equal(f.element('setup-result').hidden, false);
  assert.equal(f.element('setup-error').hidden, true);
});

test('saved fork resumes without requiring blank new-fork fields', async () => {
  const f = await fixture({ canResume: true });
  assert.equal(f.element('setup-resume').hidden, false);
  await f.element('setup-resume').fire('click');
  const post = f.requests.find((request) => request.path === '/setup/resume');
  assert.deepEqual(JSON.parse(post.options.body), {});
  assert.equal(post.options.headers['x-ruba-setup-token'], 'csrf-token');
  assert.equal(f.element('setup-fields').disabled, true);
});

test('invalid Admin RPC and wallet fail locally without submitting private settings', async () => {
  const f = await fixture();
  f.fill();
  f.element('setup-admin-rpc').value = 'https://ethereum.publicnode.com';
  await f.element('setup-form').fire('submit');
  assert.equal(f.requests.some((request) => request.path === '/setup/start'), false);
  assert.match(f.element('setup-error').textContent, /HTTPS Admin RPC Tenderly/);
  f.fill();
  f.element('setup-wallet').value = '0x' + '0'.repeat(40);
  await f.element('setup-form').fire('submit');
  assert.equal(f.requests.some((request) => request.path === '/setup/start'), false);
  assert.equal(f.element('setup-submit').disabled, false);
});
