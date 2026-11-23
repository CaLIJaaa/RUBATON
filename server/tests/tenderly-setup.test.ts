import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTenderlySetupServer } from '../tenderly-setup.ts';
import type { SetupMarket, TenderlySetupOptions } from '../tenderly-setup.ts';

const rpcUrl = 'https://virtual.mainnet.eu.rpc.tenderly.co/account/project/private-admin-secret';
const publicRpcUrl = 'https://virtual.mainnet.eu.rpc.tenderly.co/account/project/public';
const testWalletAddress = '0x0000000000000000000000000000000000000011';
const privateKey = '0x' + 'ab'.repeat(32);
const input = { rpcUrl, publicRpcUrl, testWalletAddress };
const config = {
  chainId: 73571n,
  vaultAddress: '0x0000000000000000000000000000000000000001',
  rubaAddress: '0x0000000000000000000000000000000000000002',
  usdtAddress: '0x0000000000000000000000000000000000000003',
};

class Response extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  text = '';
  writeHead(statusCode: number, headers: Record<string, string>) { this.statusCode = statusCode; this.headers = headers; }
  end(body?: string | Buffer) { this.text = body?.toString() ?? ''; this.emit('finish'); }
  value() { return JSON.parse(this.text); }
}

function fixture(overrides: Partial<TenderlySetupOptions> = {}) {
  const calls: string[] = [];
  let prepared = 0;
  let saved: unknown;
  const options: TenderlySetupOptions = {
    port: 3001,
    readSaved: async () => saved,
    writeSaved: async (value) => { saved = value; calls.push('save'); },
    acquireLock: async () => { calls.push('lock'); return async () => { calls.push('release'); }; },
    prepare: async (_settings, log) => {
      const number = ++prepared;
      calls.push(`prepare:${number}`);
      log(`Provider ${rpcUrl}, key ${privateKey}`);
      const market: SetupMarket = {
        config,
        api: {
          publicConfig: () => ({ ...config, chainId: config.chainId.toString() }),
          createHttpServer: () => createServer((_request, response) => { response.writeHead(200); response.end('ACTIVE_API'); }),
          startWorker: () => { calls.push(`worker:${number}`); return () => { calls.push(`stop:${number}`); }; },
          drain: async () => { calls.push(`drain:${number}`); },
        },
        close: () => { calls.push(`close:${number}`); },
      };
      return market;
    },
    ...overrides,
  };
  const setup = createTenderlySetupServer(options);
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as IncomingMessage;
    request.url = path;
    request.method = method;
    request.headers = { host: '127.0.0.1:3001', 'content-type': 'application/json', ...headers };
    const response = new Response();
    await setup.handle(request, response as unknown as ServerResponse);
    return response;
  }
  const tokenHeaders = () => ({ origin: 'http://127.0.0.1:3001', 'x-ruba-setup-token': setup.status().csrfToken });
  async function flush() { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); }
  return { setup, calls, request, tokenHeaders, flush, get prepared() { return prepared; }, get saved() { return saved; } };
}

test('setup initially redirects to its form and never exposes an unconfigured API', async () => {
  const f = fixture();
  try {
    const root = await f.request('/');
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, '/setup');
    const status = await f.request('/setup/status');
    assert.equal(status.statusCode, 200);
    assert.equal(status.value().phase, 'idle');
    assert.equal(status.value().canResume, false);
    assert.match(status.value().csrfToken, /^[a-f0-9]{64}$/);
    assert.equal((await f.request('/config')).statusCode, 503);
  } finally { await f.setup.close(); }
});

test('loopback host, same-origin token and bounded JSON protect the local deployment action', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/setup/status', 'GET', undefined, { host: 'attacker.example:3001' })).statusCode, 403);
    assert.equal((await f.request('/setup/start', 'POST', input, { ...f.tokenHeaders(), origin: 'https://attacker.example' })).statusCode, 403);
    assert.equal((await f.request('/setup/start', 'POST', input, { origin: 'http://127.0.0.1:3001' })).statusCode, 403);
    assert.equal((await f.request('/setup/start', 'POST', input, { ...f.tokenHeaders(), 'x-ruba-setup-token': 'я'.repeat(64) })).statusCode, 403);
    assert.equal((await f.request('/setup/start', 'POST', input, { ...f.tokenHeaders(), 'content-type': 'text/plain' })).statusCode, 415);
    assert.equal((await f.request('/setup/start', 'POST', ' '.repeat(16_385), f.tokenHeaders())).statusCode, 413);
    assert.equal((await f.request('/setup/start', 'POST', '{', f.tokenHeaders())).statusCode, 400);
    assert.equal(f.prepared, 0);
  } finally { await f.setup.close(); }
});

test('setup validates wallet and fork-only URLs before touching deployment state', async () => {
  const f = fixture();
  try {
    for (const value of [
      { ...input, rpcUrl: 'https://ethereum.publicnode.com' },
      { ...input, testWalletAddress: privateKey },
      { ...input, walletUsdt: '0.0000001' },
      { ...input, privateKey },
    ]) {
      const response = await f.request('/setup/start', 'POST', value, f.tokenHeaders());
      assert.equal(response.statusCode, 400);
      assert.ok(!response.text.includes(privateKey));
      assert.ok(!response.text.includes('ethereum.publicnode.com'));
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.setup.close(); }
});

test('one setup job runs at a time, including two bodies accepted concurrently', async () => {
  let complete!: (market: SetupMarket) => void;
  const pending = new Promise<SetupMarket>((resolve) => { complete = resolve; });
  let prepared = 0;
  const f = fixture({ prepare: async () => { prepared++; return pending; } });
  try {
    const responses = await Promise.all([
      f.request('/setup/start', 'POST', input, f.tokenHeaders()),
      f.request('/setup/start', 'POST', input, f.tokenHeaders()),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 409]);
    await f.flush();
    assert.equal(prepared, 1);
    assert.equal(f.setup.status().phase, 'running');
    complete({ config, api: { createHttpServer: () => createServer(), publicConfig: () => ({}), startWorker: () => () => {}, drain: async () => {} }, close() {} });
    await f.flush();
    assert.equal(f.setup.status().phase, 'ready');
  } finally { await f.setup.close(); }
});

test('successful setup routes to the active API and status hides Admin RPC and signing material', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/setup/start', 'POST', input, f.tokenHeaders())).statusCode, 202);
    await f.flush();
    const status = await f.request('/setup/status');
    assert.equal(status.value().phase, 'ready');
    assert.equal(status.value().active.chainId, '73571');
    assert.equal(status.value().active.publicRpcUrl, publicRpcUrl);
    assert.equal(status.value().active.testWalletAddress, testWalletAddress);
    assert.equal(status.value().canResume, true);
    assert.ok(!status.text.includes(rpcUrl));
    assert.ok(!status.text.includes(privateKey));
    assert.match(status.text, /RPC скрыт/);
    assert.equal((await f.request('/config')).value().setupAvailable, true);
    assert.equal((await f.request('/nonce')).text, 'ACTIVE_API');
    assert.deepEqual(f.saved, input);
  } finally { await f.setup.close(); }
});

test('switching forks drains and closes the previous market before acquiring the next one', async () => {
  const f = fixture();
  try {
    await f.request('/setup/start', 'POST', input, f.tokenHeaders());
    await f.flush();
    await f.request('/setup/start', 'POST', { ...input, rpcUrl: rpcUrl + '-second' }, f.tokenHeaders());
    await f.flush();
    assert.deepEqual(f.calls, ['lock', 'prepare:1', 'save', 'worker:1', 'stop:1', 'drain:1', 'close:1', 'release', 'lock', 'prepare:2', 'save', 'worker:2']);
    assert.equal(f.setup.status().phase, 'ready');
  } finally { await f.setup.close(); }
  assert.deepEqual(f.calls.slice(-4), ['stop:2', 'drain:2', 'close:2', 'release']);
});

test('failed bootstrap returns a safe recoverable error and releases the market lock', async () => {
  const f = fixture({ prepare: async () => { throw new Error(`RPC failed ${rpcUrl} signing ${privateKey}`); } });
  try {
    await f.request('/setup/start', 'POST', input, f.tokenHeaders());
    await f.flush();
    const response = await f.request('/setup/status');
    assert.equal(response.value().phase, 'error');
    assert.ok(!response.text.includes(rpcUrl));
    assert.ok(!response.text.includes(privateKey));
    assert.deepEqual(f.calls, ['lock', 'release']);
    assert.equal((await f.request('/config')).statusCode, 503);
  } finally { await f.setup.close(); }
});

test('saved settings remain private on disk and resume explicitly after a process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ruba-setup-page-'));
  const first = fixture({ root: directory, readSaved: undefined, writeSaved: undefined });
  try {
    await first.request('/setup/start', 'POST', input, first.tokenHeaders());
    await first.flush();
    // Real filesystem writes may outlast microtasks.
    for (let i = 0; i < 20 && first.setup.status().phase === 'running'; i++) await first.flush();
    assert.equal(first.setup.status().phase, 'ready');
    const path = join(directory, 'data', 'tenderly-ui.json');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), input);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await first.setup.close();
    const second = fixture({ root: directory, readSaved: undefined, writeSaved: undefined });
    try {
      const status = await second.request('/setup/status');
      assert.equal(status.value().canResume, true);
      assert.equal(status.value().phase, 'idle');
      assert.ok(!status.text.includes(rpcUrl));
      assert.equal(second.prepared, 0, 'reading saved settings must not deploy or fund automatically');
      assert.equal((await second.request('/setup/resume', 'POST', {}, second.tokenHeaders())).statusCode, 202);
      for (let i = 0; i < 20 && second.setup.status().phase === 'running'; i++) await second.flush();
      assert.equal(second.setup.status().phase, 'ready');
    } finally { await second.setup.close(); }
  } finally { await first.setup.close(); await rm(directory, { recursive: true, force: true }); }
});
