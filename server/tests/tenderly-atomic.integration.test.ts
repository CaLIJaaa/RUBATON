import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, keccak256, parseEther, parseUnits, toBeHex } from 'ethers';
import { startLocalChain } from '../../scripts/local-deploy.ts';
import { prepareAtomicTenderly, VNET_PRECOMPILE } from '../../scripts/tenderly-atomic.ts';
import type { AtomicDeployment } from '../../scripts/tenderly-atomic.ts';
import { MAINNET_USDT } from '../../scripts/tenderly-common.ts';
import type { TenderlySettings } from '../../scripts/tenderly-config.ts';

const integration = {
  skip: process.env.RUBA_INTEGRATION !== '1' ? 'Run npm run test:integration; requires local ports and Anvil' : false,
  timeout: 120_000,
};

async function runtimeCode(artifact: string, name: string): Promise<string> {
  const result = JSON.parse(await readFile(new URL(`../../out/${artifact}/${name}.json`, import.meta.url), 'utf8'));
  const code = result.deployedBytecode.object as string;
  return code.startsWith('0x') ? code : `0x${code}`;
}

/** Only Tenderly's HTTP boundary is substituted; contract execution, logs and ledger remain real. */
async function fixture(precompile: boolean) {
  const local = await startLocalChain();
  const directory = await mkdtemp(join(tmpdir(), 'ruba-atomic-live-'));
  const writes: string[] = [];
  const signedTransactions: string[] = [];
  let loseNextSend = false;
  let hiddenReceiptHash: string | undefined;
  let hiddenReceiptReads = 0;
  let prepared: Awaited<ReturnType<typeof prepareAtomicTenderly>> | undefined;
  try {
    await local.provider.send('anvil_setCode', [MAINNET_USDT, await runtimeCode('MockUSDT.sol', 'MockUSDT')]);
    if (precompile) {
      await local.provider.send('anvil_setCode', [VNET_PRECOMPILE, await runtimeCode('TenderlyBootstrap.t.sol', 'MockTenderlyVnet')]);
      await local.provider.send('anvil_setBalance', [VNET_PRECOMPILE, toBeHex(parseEther('100'))]);
    }

    class LocalTenderlyProvider extends JsonRpcProvider {
      override async send(method: string, params: any): Promise<any> {
        if (method === 'eth_getTransactionReceipt' && params[0] === hiddenReceiptHash && hiddenReceiptReads > 0) {
          hiddenReceiptReads -= 1;
          return null;
        }
        if (method === 'evm_getLatest') return super.send('eth_getBlockByNumber', ['latest', false]);
        if (method === 'tenderly_setBalance') {
          writes.push(method);
          const addresses: string[] = Array.isArray(params[0]) ? params[0] : [params[0]];
          for (const account of addresses) await super.send('anvil_setBalance', [account, params[1]]);
          return true;
        }
        if (method === 'tenderly_setErc20Balance') {
          writes.push(method);
          const [token, account, amount] = params as [string, string, string];
          const slot = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [account, 1]));
          await super.send('anvil_setStorageAt', [token, slot, toBeHex(BigInt(amount), 32)]);
          return true;
        }
        if (method === 'eth_sendRawTransaction') {
          writes.push(method);
          signedTransactions.push(params[0]);
          if (loseNextSend) {
            loseNextSend = false;
            hiddenReceiptHash = await super.send(method, params);
            hiddenReceiptReads = 1; // The first reconciliation read is also temporarily unavailable.
            throw Object.assign(new Error('RPC response lost after a mined refill'), { code: 'NETWORK_ERROR' });
          }
        }
        return super.send(method, params);
      }
    }

    const wallet = Wallet.createRandom();
    const settings: TenderlySettings = {
      rpcUrl: local.rpcUrl, testWalletAddress: wallet.address, chainMode: 'tenderly',
      seedRuba: parseUnits('1000', 18), seedUsdt: parseUnits('1000', 6),
      walletRuba: parseUnits('10000', 18), walletUsdt: parseUnits('10000', 6), walletEth: parseEther('10'),
      port: 3001, host: '127.0.0.1', stateDirectory: directory,
    };
    const dependencies = {
      providerFactory(url: string) {
        const provider = new LocalTenderlyProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
        provider.pollingInterval = 50;
        return provider;
      },
    };
    const prepare = async (fundOnly = false) => {
      prepared = await prepareAtomicTenderly(settings, () => {}, fundOnly, dependencies);
      return prepared;
    };
    return {
      local, settings, wallet, writes, signedTransactions, prepare,
      loseNextSendResponse() { loseNextSend = true; },
      closePrepared() { prepared?.close(); prepared = undefined; },
      async close() { prepared?.close(); await local.close(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    prepared?.close(); await local.close(); await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function assertReady(f: Awaited<ReturnType<typeof fixture>>, market: Awaited<ReturnType<typeof prepareAtomicTenderly>>) {
  const saved = JSON.parse(await readFile(join(f.settings.stateDirectory, 'deployment.json'), 'utf8')) as AtomicDeployment;
  const deployer = new Wallet(saved.deployerKey);
  const seeder = new Wallet(saved.seederKey);
  const operator = new Wallet(saved.operatorKey);
  const tokenAbi = ['function balanceOf(address) view returns(uint256)'];
  const ruba = new Contract(market.config.rubaAddress, tokenAbi, f.local.provider);
  const usdt = new Contract(MAINNET_USDT, tokenAbi, f.local.provider);
  const vault = new Contract(market.config.vaultAddress, [
    'function owner() view returns(address)', 'function operator() view returns(address)',
    'function whitelist(address) view returns(bool)', 'function nextDepositId() view returns(uint256)',
  ], f.local.provider);

  assert.equal(await f.local.provider.getTransactionCount(deployer.address), 1, 'one signed CREATE must complete preparation');
  assert.equal(await f.local.provider.getTransactionCount(seeder.address), 0, 'seed deposits must be nested calls, not seeder transactions');
  assert.equal(await f.local.provider.getTransactionCount(f.wallet.address), 0);
  assert.equal(await vault.owner(), deployer.address);
  assert.equal(await vault.operator(), operator.address);
  assert.equal(await vault.whitelist(f.wallet.address), true);
  assert.equal(await vault.whitelist(seeder.address), true);
  assert.equal(await vault.nextDepositId(), 3n);
  assert.equal(await ruba.balanceOf(f.wallet.address), f.settings.walletRuba);
  assert.equal(await usdt.balanceOf(f.wallet.address), f.settings.walletUsdt);
  assert.equal(await f.local.provider.getBalance(f.wallet.address), f.settings.walletEth);
  assert.equal(await ruba.balanceOf(market.config.vaultAddress), f.settings.seedRuba);
  assert.equal(await usdt.balanceOf(market.config.vaultAddress), f.settings.seedUsdt);
  assert.deepEqual(market.engine.snapshot().reserves, { RUBA: f.settings.seedRuba, USDT: f.settings.seedUsdt });
  assert.deepEqual(market.engine.snapshot().custody, market.engine.snapshot().reserves);
  assert.equal(market.engine.accountSnapshot(seeder.address).lpShares, 10n ** 15n - 1000n);

  const receipt = await f.local.provider.getTransactionReceipt(saved.bootstrapTransactionHash!);
  assert.equal(receipt?.status, 1);
  const deposits = receipt!.logs
    .filter((log) => getAddress(log.address) === market.config.vaultAddress)
    .map((log) => { try { return market.chain.abi.parseLog(log); } catch { return null; } })
    .filter((log) => log?.name === 'Deposited');
  assert.equal(deposits.length, 2, 'both real custody deposits must be in the single CREATE receipt');
  for (const log of deposits) assert.equal(log!.args.account, seeder.address);
  return { saved, seeder, ruba, usdt };
}

test('live Anvil: atomic precompile preparation uses two writes and resumes without any writes', integration, async () => {
  const f = await fixture(true);
  try {
    const market = await f.prepare();
    const { saved } = await assertReady(f, market);
    assert.equal(saved.usePrecompile, true);
    assert.deepEqual(f.writes, ['tenderly_setBalance', 'eth_sendRawTransaction']);
    const reserves = market.engine.snapshot().reserves;
    const address = market.config.vaultAddress;
    // Simulate gas spent after setup. Resume must preserve the balance rather
    // than automatically consuming another faucet operation.
    await f.local.provider.send('anvil_setBalance', [f.wallet.address, '0x0']);
    f.closePrepared();
    const resumed = await f.prepare();
    assert.equal(resumed.config.vaultAddress, address);
    assert.deepEqual(resumed.engine.snapshot().reserves, reserves);
    assert.equal(f.writes.length, 2, 'resume must not refill gas or duplicate the deployment');
    assert.equal(await f.local.provider.getBalance(f.wallet.address), 0n);
    f.closePrepared();
    await f.prepare(true);
    assert.deepEqual(f.writes, ['tenderly_setBalance', 'eth_sendRawTransaction', 'eth_sendRawTransaction']);
    assert.equal(await f.local.provider.getBalance(f.wallet.address), f.settings.walletEth, 'explicit refill uses one atomic transaction');
  } finally { await f.close(); }
});

test('live Anvil: portable preparation uses three writes', integration, async () => {
  const f = await fixture(false);
  try {
    const market = await f.prepare();
    const { saved } = await assertReady(f, market);
    assert.equal(saved.usePrecompile, false);
    assert.deepEqual(f.writes, ['tenderly_setBalance', 'tenderly_setErc20Balance', 'eth_sendRawTransaction']);
  } finally { await f.close(); }
});

test('live Anvil: a new wallet is funded and whitelisted in one transaction after atomic setup', integration, async () => {
  const f = await fixture(true);
  try {
    const market = await f.prepare();
    const address = market.config.vaultAddress;
    f.closePrepared();
    f.settings.testWalletAddress = Wallet.createRandom().address;
    const updated = await f.prepare();
    assert.equal(updated.config.vaultAddress, address);
    assert.deepEqual(f.writes, ['tenderly_setBalance', 'eth_sendRawTransaction', 'eth_sendRawTransaction']);
    const tokenAbi = ['function balanceOf(address) view returns(uint256)'];
    assert.equal(await new Contract(updated.config.rubaAddress, tokenAbi, f.local.provider).balanceOf(f.settings.testWalletAddress), f.settings.walletRuba);
    assert.equal(await new Contract(MAINNET_USDT, tokenAbi, f.local.provider).balanceOf(f.settings.testWalletAddress), f.settings.walletUsdt);
    assert.equal(await f.local.provider.getBalance(f.settings.testWalletAddress), f.settings.walletEth);
    assert.equal(await updated.chain.vault.whitelist(f.settings.testWalletAddress), true);
    f.closePrepared();
    await f.prepare();
    assert.equal(f.writes.length, 3, 'the additional wallet must also resume without automatic refill');
  } finally { await f.close(); }
});

test('live Anvil: a mined refill with a lost response is recovered after restart without minting again', integration, async () => {
  const f = await fixture(true);
  try {
    const initial = await f.prepare();
    const vaultAddress = initial.config.vaultAddress;
    const rubaAddress = initial.config.rubaAddress;
    f.closePrepared();
    const newcomer = Wallet.createRandom().connect(f.local.provider);
    f.settings.testWalletAddress = newcomer.address;
    f.loseNextSendResponse();
    await assert.rejects(f.prepare(), /пополнить тестовый кошелёк/);

    const path = join(f.settings.stateDirectory, 'deployment.json');
    const pending = JSON.parse(await readFile(path, 'utf8')) as AtomicDeployment;
    assert.equal(pending.pendingWallet?.account, newcomer.address);
    assert.equal(pending.pendingWallet?.rawTransaction, f.signedTransactions[1]);
    assert.equal(f.writes.length, 3, 'exactly one refill was already accepted and mined');

    // The user can spend a successful but unacknowledged refill before retrying
    // the UI. Recovery must settle its original identity rather than mint again.
    const token = new Contract(rubaAddress, [
      'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)',
    ], newcomer);
    assert.equal(await token.balanceOf(newcomer.address), f.settings.walletRuba);
    await (await token.transfer(Wallet.createRandom().address, parseUnits('100', 18))).wait();
    const spentBalance = f.settings.walletRuba - parseUnits('100', 18);
    assert.equal(await token.balanceOf(newcomer.address), spentBalance);

    const recovered = await f.prepare();
    assert.equal(recovered.config.vaultAddress, vaultAddress);
    assert.equal(await token.balanceOf(newcomer.address), spentBalance, 'resume must not compensate already spent test tokens');
    assert.equal(f.writes.length, 3, 'the original refill receipt must be recovered without another signed transaction');
    const settled = JSON.parse(await readFile(path, 'utf8')) as AtomicDeployment;
    assert.equal(settled.pendingWallet, undefined);
    assert.equal(settled.lastPreparedWallet, newcomer.address);
    assert.equal(await f.local.provider.getTransactionCount(new Wallet(settled.deployerKey).address), 2);
  } finally { await f.close(); }
});
