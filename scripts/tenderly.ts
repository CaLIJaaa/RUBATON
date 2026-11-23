import { access, chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, JsonRpcProvider, NonceManager, Wallet, formatUnits, getAddress, parseEther, toQuantity } from 'ethers';
import type { Server } from 'node:http';
import { RubaApi } from '../server/api.ts';
import { VaultChain } from '../server/chain.ts';
import type { ServerConfig } from '../server/config.ts';
import { RubaEngine } from '../server/engine.ts';
import { deployArtifact } from './local-deploy.ts';
import { loadTenderlySettings } from './tenderly-config.ts';

import { MAINNET_USDT, ensureForkBalance, explainTenderlyFailure, seedTenderlyPool } from './tenderly-common.ts';
export { MAINNET_USDT, ensureForkBalance, explainTenderlyFailure, seedTenderlyPool } from './tenderly-common.ts';
import { prepareAtomicTenderly } from './tenderly-atomic.ts';

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256)',
  'function mint(address,uint256)',
];
const BOOTSTRAP_VAULT_ABI = [
  'function owner() view returns (address)',
  'function operator() view returns (address)',
  'function whitelist(address) view returns (bool)',
  'function setWhitelist(address,bool)',
  'function deposit(address,uint256) returns (uint256)',
];
const SEED_MARKER = 'tenderly:initial-liquidity';
type Settings = Awaited<ReturnType<typeof loadTenderlySettings>>;

interface Deployment {
  version: 1;
  chainId: string;
  deployerKey: string;
  operatorKey: string;
  seederKey: string;
  rubaAddress?: string;
  vaultAddress?: string;
  deploymentBlock?: number;
  ledgerInitialized?: boolean;
}

type Transaction = { wait(): Promise<null | { status: number | null }> };
async function confirmed(transaction: Promise<Transaction>): Promise<void> {
  const receipt = await (await transaction).wait();
  if (!receipt || receipt.status !== 1) throw new Error('Транзакция настройки не подтверждена.');
}

function providerFor(url: string): JsonRpcProvider {
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 1_000;
  return provider;
}

async function saveDeployment(path: string, deployment: Deployment): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(deployment, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readDeployment(path: string, chainId: bigint): Promise<Deployment | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let saved: Deployment;
  try { saved = JSON.parse(text) as Deployment; }
  catch { throw new Error('Повреждён файл развёртывания. Восстановите его из резервной копии.'); }
  if (saved.version !== 1 || saved.chainId !== chainId.toString()) {
    throw new Error('Сохранённое развёртывание относится к другой сети. Создайте отдельный Tenderly-форк.');
  }
  for (const key of [saved.deployerKey, saved.operatorKey, saved.seederKey]) new Wallet(key);
  if (saved.rubaAddress) getAddress(saved.rubaAddress);
  if (saved.vaultAddress && (!saved.rubaAddress || !Number.isSafeInteger(saved.deploymentBlock) || saved.deploymentBlock! < 0)) {
    throw new Error('Повреждён файл развёртывания. Восстановите его из резервной копии.');
  }
  return saved;
}

export async function prepareTenderly(settings: Settings, log: (line: string) => void = console.log, fundOnly = false) {
  let legacy = false;
  try { legacy = JSON.parse(await readFile(join(settings.stateDirectory, 'deployment.json'), 'utf8')).version === 1; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!legacy) return prepareAtomicTenderly(settings, log, fundOnly);
  log('Продолжаю существующее развёртывание. Атомарная подготовка применяется к новым форкам.');
  const provider = providerFor(settings.rpcUrl);
  const publicProvider = settings.publicRpcUrl ? providerFor(settings.publicRpcUrl) : undefined;
  let engine: RubaEngine | undefined;
  let chain: VaultChain | undefined;
  let phase = 'проверить RPC';
  try {
    log('Проверяю Admin RPC и Ethereum USDT…');
    const network = await provider.getNetwork();
    if (network.chainId === 1n) {
      throw new Error('Создайте Tenderly Virtual TestNet с отдельным Chain ID, например 73571. Chain ID 1 здесь запрещён, чтобы кошелёк отличал форк от Ethereum mainnet.');
    }
    await provider.send('evm_getLatest', []); // Admin-only, read-only preflight.
    if (await provider.getCode(MAINNET_USDT) === '0x') {
      throw new Error('В форке нет Ethereum USDT. Нужен форк Ethereum mainnet.');
    }
    const usdt = new Contract(MAINNET_USDT, TOKEN_ABI, provider);
    if (BigInt(await usdt.decimals()) !== 6n) throw new Error('Неожиданное число знаков у USDT.');
    if (publicProvider && (await publicProvider.getNetwork()).chainId !== network.chainId) {
      throw new Error('Admin и Public RPC указывают разные Chain ID. Используйте RPC одного форка.');
    }
    if (publicProvider) {
      let adminCapable = false;
      try { await publicProvider.send('evm_getLatest', []); adminCapable = true; }
      catch { /* Public RPC is expected to reject Admin-only methods. */ }
      if (adminCapable) throw new Error('В поле Public RPC указан Admin RPC. Скопируйте Public RPC из Tenderly или оставьте поле пустым.');
    }
    await mkdir(settings.stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(settings.stateDirectory, 'deployment.json');
    let saved = await readDeployment(path, network.chainId);
    if (!saved) {
      if (fundOnly) throw new Error('Сначала выполните npm run tenderly:setup.');
      saved = {
        version: 1, chainId: network.chainId.toString(),
        deployerKey: Wallet.createRandom().privateKey,
        operatorKey: Wallet.createRandom().privateKey,
        seederKey: Wallet.createRandom().privateKey,
      };
      await saveDeployment(path, saved);
    }
    const deployer = new Wallet(saved.deployerKey, provider);
    const operator = new Wallet(saved.operatorKey, provider);
    const seeder = new Wallet(saved.seederKey, provider);
    const deployerSigner = new NonceManager(deployer);
    const seederSigner = new NonceManager(seeder);
    const ensureEth = (address: string, target: bigint) => ensureForkBalance(
      () => provider.getBalance(address), target,
      (value) => provider.send('tenderly_setBalance', [address, toQuantity(value)]),
    );
    phase = 'пополнить тестовый ETH через Admin RPC';
    log('Пополняю ETH для газа…');
    for (const wallet of [deployer, operator, seeder]) await ensureEth(wallet.address, parseEther('10'));
    await ensureEth(settings.testWalletAddress, settings.walletEth);

    phase = 'развернуть RUBA';
    log('Подготавливаю тестовый RUBA…');
    if (!saved.rubaAddress) {
      if (fundOnly) throw new Error('Развёртывание не завершено. Выполните npm run tenderly:setup.');
      const token = await deployArtifact('MockERC20', 'MockERC20', deployerSigner, ['Test RUBA', 'RUBA', 18]);
      saved.rubaAddress = await token.getAddress();
      await saveDeployment(path, saved);
    }
    if (await provider.getCode(saved.rubaAddress) === '0x') {
      throw new Error('Сохранённый RUBA отсутствует в форке. Возможно, форк был сброшен. Нужен новый форк и отдельный RPC.');
    }
    phase = 'развернуть RubaVault';
    log('Подготавливаю RubaVault…');
    if (!saved.vaultAddress) {
      if (fundOnly) throw new Error('Развёртывание не завершено. Выполните npm run tenderly:setup.');
      const vault = await deployArtifact('RubaVault', 'RubaVault', deployerSigner, [
        saved.rubaAddress, MAINNET_USDT, deployer.address, operator.address,
      ]);
      const receipt = await vault.deploymentTransaction()!.wait();
      if (!receipt || receipt.status !== 1) throw new Error('Не подтверждено развёртывание RubaVault.');
      saved.vaultAddress = await vault.getAddress();
      saved.deploymentBlock = receipt.blockNumber;
      await saveDeployment(path, saved);
    }
    const vaultAddress = getAddress(saved.vaultAddress);
    const rubaAddress = getAddress(saved.rubaAddress);
    const code = await provider.getCode(vaultAddress);
    if (code === '0x') throw new Error('Сохранённый RubaVault отсутствует в форке. Проверьте, не был ли форк сброшен.');
    if (publicProvider && await publicProvider.getCode(vaultAddress) !== code) {
      throw new Error('Public RPC не видит развёрнутый RubaVault. Укажите Public RPC того же форка.');
    }
    const adminVault = new Contract(vaultAddress, BOOTSTRAP_VAULT_ABI, deployerSigner);
    if (getAddress(await adminVault.owner()) !== deployer.address || getAddress(await adminVault.operator()) !== operator.address) {
      throw new Error('Владелец или оператор RubaVault изменён. Сохранённая конфигурация больше не подходит.');
    }
    const ruba = new Contract(rubaAddress, TOKEN_ABI, deployerSigner);
    async function fundTokens(account: string, rubaTarget: bigint, usdtTarget: bigint) {
      const balance = BigInt(await ruba.balanceOf(account));
      if (balance < rubaTarget) await confirmed(ruba.mint(account, rubaTarget - balance));
      await ensureForkBalance(
        async () => BigInt(await usdt.balanceOf(account)), usdtTarget,
        (value) => provider.send('tenderly_setErc20Balance', [MAINNET_USDT, account, toQuantity(value)]),
      );
    }
    phase = 'выдать токены и whitelist тестовому кошельку';
    log('Выдаю токены и допуск кошельку…');
    await fundTokens(settings.testWalletAddress, settings.walletRuba, settings.walletUsdt);
    for (const account of [settings.testWalletAddress, seeder.address]) {
      if (!await adminVault.whitelist(account)) await confirmed(adminVault.setWhitelist(account, true));
    }
    const config: ServerConfig = {
      rpcUrl: settings.rpcUrl, chainId: network.chainId, chainMode: 'tenderly',
      vaultAddress, rubaAddress, usdtAddress: MAINNET_USDT,
      operatorPrivateKey: saved.operatorKey, deploymentBlock: saved.deploymentBlock!,
      confirmations: 0, withdrawalTtl: 900n, dbPath: join(settings.stateDirectory, 'ledger.sqlite'),
      host: settings.host, port: settings.port, syncIntervalMs: 2_000,
    };
    phase = 'синхронизировать журнал и подготовить ликвидность';
    log('Синхронизирую депозиты и создаю начальную ликвидность…');
    if (saved.ledgerInitialized) {
      try { await access(config.dbPath); }
      catch { throw new Error('Отсутствует журнал уже настроенного рынка. Восстановите папку data/tenderly из резервной копии; повторное создание балансов запрещено.'); }
    }
    engine = new RubaEngine(config);
    chain = new VaultChain(config, engine);
    await chain.initialize();
    const api = new RubaApi(engine, chain, config);
    if (!fundOnly && engine.getMetadata(SEED_MARKER) !== 'complete') {
      await fundTokens(seeder.address, settings.seedRuba, settings.seedUsdt);
      const seederVault = new Contract(vaultAddress, BOOTSTRAP_VAULT_ABI, seederSigner);
      await seedTenderlyPool({
        engine, account: seeder.address, ruba: settings.seedRuba, usdt: settings.seedUsdt,
        sync: () => api.sync(),
        deposit: async (token, value) => {
          const address = token === 'RUBA' ? rubaAddress : MAINNET_USDT;
          const asset = new Contract(address, TOKEN_ABI, seederSigner);
          const allowance = BigInt(await asset.allowance(seeder.address, vaultAddress));
          if (allowance < value) {
            if (allowance !== 0n) await confirmed(asset.approve(vaultAddress, 0n));
            await confirmed(asset.approve(vaultAddress, value));
          }
          await confirmed(seederVault.deposit(address, value));
        },
      });
    }
    if (engine.getMetadata(SEED_MARKER) === 'complete' && !saved.ledgerInitialized) {
      saved.ledgerInitialized = true;
      await saveDeployment(path, saved);
    }
    if (publicProvider) {
      const boundary = await provider.getBlock('latest');
      const publicBoundary = boundary && await publicProvider.getBlock(boundary.number);
      if (!boundary?.hash || publicBoundary?.hash !== boundary.hash) {
        throw new Error('Admin и Public RPC расходятся по истории блоков. Укажите два RPC одного Tenderly-форка.');
      }
    }
    log(`Tenderly Chain ID: ${network.chainId}`);
    log(`Тестовый кошелёк (допущен к операциям): ${settings.testWalletAddress}`);
    log(`RUBA (18 знаков): ${rubaAddress}`);
    log(`USDT (6 знаков): ${MAINNET_USDT}`);
    log(`RubaVault: ${vaultAddress}`);
    const reserves = engine.snapshot().reserves;
    log(`Ликвидность: ${formatUnits(reserves.RUBA, 18)} RUBA / ${formatUnits(reserves.USDT, 6)} USDT.`);
    log(`Баланс кошелька пополнен минимум до ${formatUnits(settings.walletRuba, 18)} RUBA, ${formatUnits(settings.walletUsdt, 6)} USDT и ${formatUnits(settings.walletEth, 18)} ETH.`);
    if (settings.publicRpcUrl) log(`RPC для MetaMask/Rabby: ${settings.publicRpcUrl}`);
    else log('Добавьте в MetaMask/Rabby Public RPC этого Tenderly Virtual TestNet; Admin RPC в интерфейс не передаётся.');
    log('Ключи пользователя не нужны. Тестовые ключи оператора и журнал хранятся в data/tenderly; сохраните эту папку между запусками.');
    return {
      config, engine, chain, api,
      close() { chain!.close(); engine!.close(); provider.destroy(); publicProvider?.destroy(); },
    };
  } catch (error) {
    chain?.close();
    engine?.close();
    provider.destroy();
    publicProvider?.destroy();
    // Provider exceptions may contain an Admin RPC URL or transaction material.
    throw explainTenderlyFailure(error, phase);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'serve';
  if (!['serve', 'setup', 'fund'].includes(mode)) throw new Error('Неизвестный режим Tenderly.');
  const settings = await loadTenderlySettings();
  const release = await acquireTenderlyLock(settings.stateDirectory);
  try { await runWithSettings(mode, settings); }
  finally { await release(); }
}

export async function acquireTenderlyLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'run.lock');
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
    return async () => { await unlink(path); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(path);
          return acquireTenderlyLock(directory);
        }
      }
    }
    throw new Error('Этот Tenderly-рынок уже запущен или настройка выполняется. Сначала остановите его через Ctrl+C.');
  }
}

async function runWithSettings(mode: string, settings: Settings): Promise<void> {
  const prepared = await prepareTenderly(settings, console.log, mode === 'fund');
  if (mode !== 'serve') {
    prepared.close();
    console.log(mode === 'fund' ? 'Баланс кошелька пополнен до настроенных сумм.' : 'Tenderly готов. Запустите npm run tenderly.');
    return;
  }
  let server: Server | undefined;
  let stopWorker: (() => void) | undefined;
  try {
    server = prepared.api.createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(settings.port, settings.host, () => { server!.off('error', reject); resolve(); });
    });
    stopWorker = prepared.api.startWorker();
    console.log(`RUBA UI: http://${settings.host}:${settings.port}/`);
    console.log('Ctrl+C остановит UI. Форк, контракты и журнал сохранятся.');
    await new Promise<void>((resolve) => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    stopWorker?.();
    if (server?.listening) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeIdleConnections(); });
    prepared.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: Error & { code?: string }) => {
    console.error(error.code === 'EADDRINUSE'
      ? 'Порт UI занят. Остановите npm run dev или запустите PORT=3002 npm run tenderly.'
      : error.code === 'EPERM'
        ? 'Окружение запрещает локальные порты. Запустите npm run tenderly в обычном терминале.'
        : error.message);
    process.exitCode = 1;
  });
}
