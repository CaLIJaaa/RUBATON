import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTenderlyVirtualRpcUrl, loadConfig, tokenMetadata } from '../config.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-config-'));
  const env: NodeJS.ProcessEnv = {
    RPC_URL: 'https://ethereum.example/rpc', CHAIN_ID: '1',
    VAULT_ADDRESS: '0x0000000000000000000000000000000000000001',
    RUBA_ADDRESS: '0x0000000000000000000000000000000000000002',
    USDT_ADDRESS: '0x0000000000000000000000000000000000000003',
    VAULT_DEPLOYMENT_BLOCK: '123', OPERATOR_PRIVATE_KEY: '0x' + '44'.repeat(32),
    DB_PATH: join(directory, 'ledger.sqlite'),
  };
  return { env, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('ordinary networks retain consensus-finality mode and production confirmation defaults', () => {
  const f = fixture();
  try {
    const config = loadConfig(f.env);
    assert.equal(config.chainMode, undefined);
    assert.equal(config.confirmations, 12);
    // A Tenderly URL alone is not permission to change settlement semantics.
    const unmarked = loadConfig({ ...f.env, RPC_URL: 'https://virtual.mainnet.eu.rpc.tenderly.co/test' });
    assert.equal(unmarked.chainMode, undefined);
    assert.equal(unmarked.confirmations, 12);
  } finally { f.close(); }
});

test('Tenderly mode accepts Virtual TestNet endpoints and defaults to immediate fork settlement', () => {
  const f = fixture();
  try {
    for (const rpcUrl of ['https://virtual.mainnet.eu.rpc.tenderly.co/account/project/test', 'https://virtual.mainnet.rpc.tenderly.co/test']) {
      assert.equal(isTenderlyVirtualRpcUrl(rpcUrl), true);
      const config = loadConfig({ ...f.env, CHAIN_ID: '73571', CHAIN_MODE: 'tenderly', RPC_URL: rpcUrl });
      assert.equal(config.chainMode, 'tenderly');
      assert.equal(config.confirmations, 0);
    }
    const config = loadConfig({ ...f.env, CHAIN_MODE: 'tenderly', RPC_URL: 'https://virtual.mainnet.eu.rpc.tenderly.co/test', CONFIRMATIONS: '3' });
    assert.equal(config.confirmations, 3);
  } finally { f.close(); }
});

test('test-chain settlement rejects unknown modes, live RPCs and misleading Tenderly hostnames', () => {
  const f = fixture();
  try {
    assert.throws(() => loadConfig({ ...f.env, CHAIN_MODE: 'fork' }), /CHAIN_MODE/);
    for (const rpcUrl of [
      f.env.RPC_URL!, 'http://virtual.mainnet.eu.rpc.tenderly.co/test',
      'https://virtual.mainnet.eu.rpc.tenderly.co.evil.example/test',
      'https://mainnet.gateway.tenderly.co/test',
      'https://user:password@virtual.mainnet.eu.rpc.tenderly.co/test',
      'not a URL',
    ]) {
      assert.equal(isTenderlyVirtualRpcUrl(rpcUrl), false);
      assert.throws(() => loadConfig({ ...f.env, CHAIN_MODE: 'tenderly', RPC_URL: rpcUrl }));
    }
  } finally { f.close(); }
});

test('explicit Sepolia demo confirmation policy cannot be enabled on mainnet', () => {
  const f = fixture();
  try {
    assert.throws(() => loadConfig({ ...f.env, CHAIN_MODE: 'sepolia' }), /11155111/);
    const sepolia = loadConfig({ ...f.env, CHAIN_ID: '11155111', CHAIN_MODE: 'sepolia' });
    assert.equal(sepolia.confirmations, 1);
    assert.equal(sepolia.chainMode, 'sepolia');
    assert.equal(loadConfig({ ...f.env, CHAIN_ID: '11155111' }).confirmations, 12);
  } finally { f.close(); }
});

test('market token units are explicit and bounded while legacy defaults remain 18/6', () => {
  const f = fixture();
  try {
    assert.deepEqual(tokenMetadata({}), { RUBA: { symbol: 'RUBA', decimals: 18 }, USDT: { symbol: 'USDT', decimals: 6 } });
    const configured = loadConfig({ ...f.env, TOKEN0_SYMBOL: 'WETH', TOKEN0_DECIMALS: '18', TOKEN1_SYMBOL: 'WBTC', TOKEN1_DECIMALS: '8' });
    assert.deepEqual(tokenMetadata(configured), { RUBA: { symbol: 'WETH', decimals: 18 }, USDT: { symbol: 'WBTC', decimals: 8 } });
    assert.throws(() => loadConfig({ ...f.env, TOKEN0_SYMBOL: 'WETH' }), /TOKEN0_DECIMALS|TOKEN1/);
    assert.throws(() => tokenMetadata({ tokenMetadata: { RUBA: { symbol: 'ETH<script>', decimals: 18 }, USDT: { symbol: 'WBTC', decimals: 8 } } }), /metadata/);
    assert.throws(() => tokenMetadata({ tokenMetadata: { RUBA: { symbol: 'WETH', decimals: 19 }, USDT: { symbol: 'WBTC', decimals: 8 } } }), /metadata/);
  } finally { f.close(); }
});
