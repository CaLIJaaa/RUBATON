import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Wallet, Transaction, keccak256, getCreateAddress } from 'ethers';
import { loadPrivateMarketKeys, loadSepoliaSettings, readJson, writePrivateJson, POOLS } from '../sepolia-config.ts';
import type { DeploymentManifest } from '../sepolia-config.ts';
import { DeploymentTransactions, InsufficientDeploymentFunds } from '../sepolia-transactions.ts';
import { prepareDeployment, deploymentRequests, deployPreparedMarkets } from '../sepolia-deploy.ts';
import { fundBootstrapRoles } from '../sepolia-runtime.ts';

const blockHash = '0x' + '12'.repeat(32);
test('fresh-role ETH funding keeps its prepared values and requests network gas estimation', async () => {
  const lp = Wallet.createRandom(), bot = Wallet.createRandom(), deployer = Wallet.createRandom();
  const calls: any[][] = [];
  const manifest = { budget: { roleFundingByRoleWei: { lp: '6000000000000000', bot: '4000000000000000' } } } as DeploymentManifest;
  await fundBootstrapRoles(manifest, lp as any, bot as any, { async run(...args: any[]) { calls.push(args); } } as any, deployer as any);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].value, 6000000000000000n);
  assert.equal(calls[1][2].value, 4000000000000000n);
  assert.ok(calls.every((call) => call.length === 3), 'No fixed execution-only gas limit may override RPC estimation for a new recipient');
});
test('Sepolia private roles/pool keys persist separately without replacing a dedicated deployer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-sepolia-keys-'));
  try {
    const deployer = Wallet.createRandom();
    const path = join(directory, 'deployer.json');
    writePrivateJson(path, { address: deployer.address, privateKey: deployer.privateKey });
    const before = readFileSync(path, 'utf8');
    const first = loadPrivateMarketKeys(directory, 11155111n, true);
    assert.equal(new Set(Object.values(first.poolKeys)).size, 3);
    assert.deepEqual(loadPrivateMarketKeys(directory, 11155111n, true), first);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(statSync(join(directory, 'privatekeys.json')).mode & 0o777, 0o600);
    assert.throws(() => loadPrivateMarketKeys(directory, 31337n), /another chain/);
    assert.throws(() => loadSepoliaSettings({ SEPOLIA_RPC_URL: 'http://example.com' }), /HTTPS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Sepolia prepare builds nine exact CREATE intents and a funded budget without broadcasting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-sepolia-plan-'));
  try {
    const deployer = Wallet.createRandom();
    const keys = loadPrivateMarketKeys(directory, 11155111n, true);
    const settings = { directory, rpcUrl: 'https://example.invalid', port: 3001, confirmations: 1, artifactsDir: resolve('zk/artifacts') };
    const provider = {
      async getNetwork() { return { chainId: 11155111n }; }, async send() { return '0xaa36a7'; },
      async getBlock() { return { hash: blockHash }; },
      async getTransactionCount() { return 7; }, async getFeeData() { return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; },
      async estimateGas() { throw new Error('Dependencies not deployed'); }, async getBalance() { return 0n; },
      async broadcastTransaction() { throw new Error('Prepare cannot broadcast'); },
    };
    const env = await prepareDeployment(settings, provider as any, { address: deployer.address, privateKey: deployer.privateKey }, keys);
    const requests = await deploymentRequests(env);
    assert.equal(requests.length, 9);
    requests.forEach((request, index) => assert.equal(request.address, getCreateAddress({ from: deployer.address, nonce: 7 + index })));
    assert.equal(env.manifest.budget!.sufficient, false);
    assert.ok(BigInt(env.manifest.budget!.totalRequiredWei) > 0n);
    assert.equal(env.manifest.tokens.WBTC.decimals, 8);
    assert.equal(env.manifest.tokens.WETH.decimals, 18);
    assert.equal(Object.keys(env.manifest.pools).length, 3);
    assert.equal(JSON.stringify(env.manifest).includes('privateKey'), false);
    assert.equal(JSON.stringify(env.manifest).includes('rpcUrl'), false);
    assert.ok(POOLS.every((pool) => !existsSync(keys.databasePaths[pool.id])));
    await assert.rejects(deployPreparedMarkets(env, () => {}), InsufficientDeploymentFunds);
    assert.equal(existsSync(join(directory, 'transactions.json')), false);
    const testWallet = Wallet.createRandom().address;
    const updated = await prepareDeployment({ ...settings, testWallet }, provider as any, { address: deployer.address, privateKey: deployer.privateKey }, keys);
    assert.equal(updated.manifest.roles.testWallet, testWallet, 'A wallet supplied after initial prepare cannot be silently ignored');
    updated.manifest.steps.saved = { status: 'signed' } as any; updated.save();
    const previousCap = process.env.SEPOLIA_MAX_TOTAL_FEE_WEI;
    try {
      process.env.SEPOLIA_MAX_TOTAL_FEE_WEI = '1';
      await assert.rejects(prepareDeployment(settings, provider as any, { address: deployer.address, privateKey: deployer.privateKey }, keys), /current total funding cap/);
    } finally { if (previousCap === undefined) delete process.env.SEPOLIA_MAX_TOTAL_FEE_WEI; else process.env.SEPOLIA_MAX_TOTAL_FEE_WEI = previousCap; }

  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Sepolia signed transaction journal survives an unknown broadcast result without sending a second intent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-sepolia-tx-'));
  try {
    const wallet = Wallet.createRandom(); const target = Wallet.createRandom().address;
    const manifest = { network: { chainId: '11155111', confirmations: 1 }, steps: {}, budget: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' } } as unknown as DeploymentManifest;
    const path = join(directory, 'manifest.json');
    const save = () => writePrivateJson(path, manifest);
    const receipts = new Map(); let broadcasts = 0;
    const provider = {
      async getNetwork() { return { chainId: 11155111n }; }, async getTransactionCount() { return broadcasts; },
      async getFeeData() { return {}; }, async getBalance() { return 10n ** 20n; }, async getBlockNumber() { return 1; },
      async estimateGas() { return 21000n; }, async getBlock(tag: unknown) { return { hash: blockHash, number: tag === 'latest' ? 2 : 1 }; },
      async getTransactionReceipt(hash: string) { return receipts.get(hash) ?? null; }, async getTransaction(hash: string) { return receipts.has(hash) ? { hash } : null; },
      async waitForTransaction(hash: string) { return receipts.get(hash); },
      async broadcastTransaction(raw: string) {
        const signed = readJson<any>(join(directory, 'transactions.json'));
        assert.equal(signed.steps.payment.raw, raw, 'Signed payload must be durable before broadcast');
        broadcasts++;
        const transaction = Transaction.from(raw);
        receipts.set(keccak256(raw), { status: 1, hash: keccak256(raw), blockNumber: 1, blockHash, gasUsed: 21000n, contractAddress: null });
        assert.equal(transaction.nonce, 0);
        throw new Error('Provider lost the response after accepting the transaction');
      },
    };
    const first = new DeploymentTransactions(provider as any, directory, manifest, save);
    await first.run('payment', wallet as any, { to: target, value: 1n });
    delete manifest.steps.payment; save(); // crash after private write but before public step persistence
    const restoredManifest = readJson<DeploymentManifest>(path);
    const restarted = new DeploymentTransactions(provider as any, directory, restoredManifest, () => writePrivateJson(path, restoredManifest));
    await restarted.run('payment', wallet as any, { to: target, value: 1n });
    assert.equal(broadcasts, 1);
    await assert.rejects(restarted.run('unexpected-create', wallet as any, { data: '0x6000' }, undefined, getCreateAddress({ from: wallet.address, nonce: 0 })), /CREATE nonce conflict/);
    assert.equal(broadcasts, 1, 'Occupied CREATE nonce must be rejected before any broadcast');
    await assert.rejects(restarted.run('payment', wallet as any, { to: target, value: 2n }), /immutable intent/);
    assert.equal(statSync(join(directory, 'transactions.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8').includes(wallet.privateKey), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('pruned Sepolia pins a finalized identity checkpoint while Anvil still requires genesis', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-sepolia-pruned-'));
  try {
    const deployer = Wallet.createRandom(), keys = loadPrivateMarketKeys(directory, 11155111n, true);
    const settings = { directory, rpcUrl: 'https://example.invalid', port: 3001, confirmations: 1, artifactsDir: resolve('zk/artifacts') };
    let changed = false;
    const provider = {
      async getNetwork() { return { chainId: 11155111n }; }, async send() { return '0xaa36a7'; },
      async getBlock(tag: unknown) { if (tag === 0) throw new Error('Pruned history'); return { number: 1000001, hash: changed ? '0x' + '34'.repeat(32) : blockHash }; },
      async getTransactionCount() { return 0; }, async getFeeData() { return { maxFeePerGas: 30n, maxPriorityFeePerGas: 1n }; },
      async estimateGas() { return 1000000n; }, async getBalance() { return 0n; },
    };
    const first = await prepareDeployment(settings, provider as any, { address: deployer.address, privateKey: deployer.privateKey }, keys);
    assert.equal(first.manifest.network.genesisAvailability, 'pruned');
    assert.equal(first.manifest.network.genesisHash, undefined);
    assert.deepEqual(first.manifest.network.identityCheckpoint, { kind: 'finalized', blockNumber: 1000001, blockHash });
    await prepareDeployment(settings, provider as any, { address: deployer.address, privateKey: deployer.privateKey }, keys);
    changed = true;
    await assert.rejects(prepareDeployment(settings, provider as any, { address: deployer.address, privateKey: deployer.privateKey }, keys), /checkpoint unavailable or changed/);
    const localDirectory = join(directory, 'local');
    const localKeys = loadPrivateMarketKeys(localDirectory, 31337n, true);
    await assert.rejects(prepareDeployment({ ...settings, directory: localDirectory }, { ...provider,
      async getNetwork() { return { chainId: 31337n }; }, async send() { return '0x7a69'; },
    } as any, { address: deployer.address, privateKey: deployer.privateKey }, localKeys, 31337n), /Anvil genesis must/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
