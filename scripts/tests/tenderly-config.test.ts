import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { getAddress, parseUnits } from 'ethers';
import { loadTenderlySettings, parseTenderlySettings } from '../tenderly-config.ts';

const rpc = 'https://virtual.mainnet.eu.rpc.tenderly.co/example-admin';
const address = '0x00000000000000000000000000000000000000a1';
const env = { TEST_WALLET_ADDRESS: address };

test('Tenderly defaults preserve token decimals, use loopback and isolate state by RPC', () => {
  const config = parseTenderlySettings(rpc, env, '/tmp/ruba-settings');
  assert.equal(config.testWalletAddress, getAddress(address));
  assert.equal(config.chainMode, 'tenderly');
  assert.equal(config.seedRuba, parseUnits('1000', 18));
  assert.equal(config.seedUsdt, parseUnits('1000', 6));
  assert.equal(config.walletRuba, parseUnits('10000', 18));
  assert.equal(config.walletUsdt, parseUnits('10000', 6));
  assert.equal(config.walletEth, parseUnits('10', 18));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.equal(config.publicRpcUrl, undefined);
  assert.match(config.stateDirectory, /^\/tmp\/ruba-settings\/data\/tenderly\/[a-f0-9]{16}$/);
  assert.equal(config.stateDirectory, parseTenderlySettings(rpc, env, '/tmp/ruba-settings').stateDirectory);
  assert.notEqual(config.stateDirectory, parseTenderlySettings(rpc + '-other', env, '/tmp/ruba-settings').stateDirectory);
  assert.equal(config.stateDirectory.startsWith(resolve('/tmp/ruba-settings/data/tenderly') + '/'), true);
});

test('explicit Admin RPC bypasses Foundry and accepts independently configured Public RPC', async () => {
  const publicRpc = 'https://virtual.mainnet.rpc.tenderly.co/example-public';
  const settings = await loadTenderlySettings({ ...env, TENDERLY_RPC_URL: ` ${rpc} `, TENDERLY_PUBLIC_RPC_URL: publicRpc }, '/tmp/ruba', () => {
    throw new Error('Foundry must not be consulted for an explicit endpoint');
  });
  assert.equal(settings.rpcUrl, rpc);
  assert.equal(settings.publicRpcUrl, publicRpc);
  assert.throws(() => parseTenderlySettings(rpc, { ...env, TENDERLY_PUBLIC_RPC_URL: rpc }), /Admin RPC.*Public RPC.*разными/);
});

test('RPC alias defaults to mainnet and substitutes environment placeholders', async () => {
  const settings = await loadTenderlySettings({ ...env, FORK_ADMIN: rpc }, '/tmp/ruba', () => ({
    rpc_endpoints: { mainnet: '${FORK_ADMIN}', another: 'https://invalid.example' },
  }));
  assert.equal(settings.rpcUrl, rpc);
});

test('RPC alias supports a selected endpoint and literal URL in foundry.toml', async () => {
  const settings = await loadTenderlySettings({ ...env, TENDERLY_RPC_ENDPOINT: 'ruba' }, '/tmp/ruba', (root, passedEnv) => {
    assert.equal(root, '/tmp/ruba');
    assert.equal(passedEnv.TENDERLY_RPC_ENDPOINT, 'ruba');
    return { rpc_endpoints: { mainnet: 'https://invalid.example', ruba: rpc } };
  });
  assert.equal(settings.rpcUrl, rpc);
});

test('missing alias and missing RPC environment variables produce useful setting errors', async () => {
  await assert.rejects(loadTenderlySettings(env, '/tmp/ruba', () => ({})), /TENDERLY_RPC_URL.*rpc_endpoints/);
  await assert.rejects(loadTenderlySettings(env, '/tmp/ruba', () => ({ rpc_endpoints: { mainnet: '${FORK_ADMIN}' } })), /FORK_ADMIN/);
  await assert.rejects(loadTenderlySettings({ ...env, TENDERLY_RPC_ENDPOINT: '__proto__' }, '/tmp/ruba', () => ({ rpc_endpoints: {} })), /RPC-алиас/);
});

test('Tenderly settings reject public networks, lookalike hosts, HTTP and embedded credentials without echoing RPC', () => {
  for (const invalid of [
    'https://ethereum.example/secret',
    'https://virtual.mainnet.eu.rpc.tenderly.co.attacker.example/secret',
    'http://virtual.mainnet.eu.rpc.tenderly.co/secret',
    'https://admin:secret@virtual.mainnet.eu.rpc.tenderly.co/fork',
    'not a URL',
  ]) {
    assert.throws(() => parseTenderlySettings(invalid, env), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /TENDERLY_RPC_URL/);
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes(invalid), false);
      return true;
    });
  }
  assert.throws(() => parseTenderlySettings(rpc, { ...env, TENDERLY_PUBLIC_RPC_URL: 'https://ethereum.example' }), /TENDERLY_PUBLIC_RPC_URL/);
});

test('test-wallet address must be a valid nonzero public Ethereum address', () => {
  for (const invalid of [undefined, '', 'hello', '0x0000000000000000000000000000000000000000']) {
    assert.throws(() => parseTenderlySettings(rpc, { TEST_WALLET_ADDRESS: invalid }), /TEST_WALLET_ADDRESS/);
  }
});

test('configured amounts are parsed in base units and accept supported precision', () => {
  const config = parseTenderlySettings(rpc, {
    ...env, TENDERLY_SEED_RUBA: '1.000000000000000001', TENDERLY_SEED_USDT: '2.000001',
    TENDERLY_WALLET_RUBA: '5.5', TENDERLY_WALLET_USDT: '10.25', TENDERLY_WALLET_ETH: '0.01', PORT: '3002',
  });
  assert.equal(config.seedRuba, 1_000_000_000_000_000_001n);
  assert.equal(config.seedUsdt, 2_000_001n);
  assert.equal(config.walletRuba, parseUnits('5.5', 18));
  assert.equal(config.walletUsdt, 10_250_000n);
  assert.equal(config.walletEth, 10n ** 16n);
  assert.equal(config.port, 3002);
});

test('invalid amounts, precision, uint256 overflow and ports are rejected by setting name', () => {
  for (const [key, value] of [
    ['TENDERLY_SEED_RUBA', '0'], ['TENDERLY_WALLET_RUBA', '-1'],
    ['TENDERLY_SEED_USDT', '1.0000001'], ['TENDERLY_WALLET_USDT', '1e6'],
    ['TENDERLY_WALLET_ETH', ''], ['TENDERLY_SEED_RUBA', '9'.repeat(80)],
    ['PORT', '0'], ['PORT', '65536'], ['PORT', '3001.5'], ['PORT', 'abc'],
  ]) assert.throws(() => parseTenderlySettings(rpc, { ...env, [key]: value }), new RegExp(key));
});
