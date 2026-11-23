const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { selectRuntime, probeNode, childEnvironment } = require('./runtime.cjs');

test('startup skips an older shell Node and a runtime with unavailable SQLite', () => {
  const calls = [];
  const runtime = selectRuntime({
    env: {}, currentExecutable: '/shell/node', candidates: ['/shell/node', '/flagged/node', process.execPath],
    probe(executable) {
      calls.push(executable);
      if (executable === '/shell/node') return { version: '20.19.0', executable, sqlite: false, register: true };
      if (executable === '/flagged/node') return { version: '23.0.0', executable, sqlite: false, register: true };
      return probeNode(executable);
    },
  });
  assert.equal(runtime.executable, process.execPath);
  assert.equal(runtime.sqlite, true);
  assert.deepEqual(calls, ['/shell/node', '/flagged/node', process.execPath]);
  const original = { PATH: '/custom/bin', KEEP: 'value' };
  const env = childEnvironment(runtime, original);
  assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(runtime.executable));
  assert.equal(env.KEEP, 'value');
  assert.equal(original.PATH, '/custom/bin', 'the parent shell environment must remain unchanged');
});

test('an invalid explicit Node override fails clearly instead of silently choosing another runtime', () => {
  const calls = [];
  assert.throws(() => selectRuntime({
    env: { RUBA_NODE_BINARY: '/explicit/old-node' },
    probe(executable) { calls.push(executable); return { version: '18.20.0', executable, sqlite: false, register: true }; },
  }), /RUBA_NODE_BINARY=.*не указывает/);
  assert.deepEqual(calls, ['/explicit/old-node']);
});

test('TypeScript entrypoints, SQLite and UI assets load without the strip-types flag', () => {
  const root = path.resolve(__dirname, '..');
  const loader = pathToFileURL(path.join(__dirname, 'register-typescript.mjs')).href;
  const code = `
    import assert from 'node:assert/strict';
    import { RubaEngine } from './server/engine.ts';
    import { getStaticResponse } from './server/static.ts';
    import { runDevelopment } from './scripts/dev.ts';
    const engine = new RubaEngine({dbPath: ':memory:', chainId: 31337n,
      vaultAddress:'0x0000000000000000000000000000000000000001',
      rubaAddress:'0x0000000000000000000000000000000000000002',
      usdtAddress:'0x0000000000000000000000000000000000000003'});
    assert.equal(engine.snapshot().custody.RUBA, 0n);
    engine.close();
    assert.equal((await getStaticResponse('/', 'GET')).status, 200);
    assert.equal(typeof runDevelopment, 'function');
    assert.ok(!process.execArgv.includes('--experimental-strip-types'));
    console.log('RUBA_RUNTIME_OK');
  `;
  const runtime = selectRuntime();
  const result = spawnSync(runtime.executable, ['--import', loader, '--input-type=module', '-e', code], {
    cwd: root, env: childEnvironment(runtime), encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RUBA_RUNTIME_OK/);
});
