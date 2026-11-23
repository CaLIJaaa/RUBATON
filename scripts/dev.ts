import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, NonceManager, parseUnits } from 'ethers';
import type { Server } from 'node:http';
import { RubaApi } from '../server/api.ts';
import { VaultChain } from '../server/chain.ts';
import type { ServerConfig } from '../server/config.ts';
import { RubaEngine } from '../server/engine.ts';
import { deployLocalFixture, startLocalChain } from './local-deploy.ts';

function developmentPort(value = process.env.PORT ?? '3001'): number {
  if (!/^[0-9]+$/.test(value)) throw new Error('PORT должен быть целым числом от 1 до 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535.');
  }
  return port;
}

/**
 * Starts a new, disposable local-only market and keeps its UI open until Ctrl+C.
 * Deposits and initial LP reserves are backed by real transactions on its own
 * Anvil instance; the browser follows the same wallet flow as the normal API.
 */
export async function runDevelopment(log: (message: string) => void = console.log): Promise<void> {
  const port = developmentPort();
  const directory = await mkdtemp(join(tmpdir(), 'ruba-ui-'));
  let local: Awaited<ReturnType<typeof startLocalChain>> | undefined;
  let engine: RubaEngine | undefined;
  let chain: VaultChain | undefined;
  let server: Server | undefined;
  let stopWorker: (() => void) | undefined;
  let stopRequested = false;
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    log('Останавливаю локальный RUBA…');
    resolveStop?.();
  };
  const checkStop = () => {
    if (stopRequested) throw new Error('LOCAL_DEVELOPMENT_STOPPED');
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  try {
    local = await startLocalChain();
    checkStop();
    const fixture = await deployLocalFixture(local);
    checkStop();
    const { admin, operator, lp, trader, adminTransactions } = fixture;
    const ruba = fixture.ruba as Contract;
    const usdt = fixture.usdt as Contract;
    const vault = fixture.vault as Contract;
    const vaultAddress = await vault.getAddress();
    const rubaAddress = await ruba.getAddress();
    const usdtAddress = await usdt.getAddress();
    const config: ServerConfig = {
      rpcUrl: local.rpcUrl,
      chainId: 31337n,
      vaultAddress,
      rubaAddress,
      usdtAddress,
      operatorPrivateKey: operator.privateKey,
      deploymentBlock: fixture.deploymentBlock,
      confirmations: 0,
      withdrawalTtl: 900n,
      dbPath: join(directory, 'ledger.sqlite'),
      host: '127.0.0.1',
      port,
      syncIntervalMs: 2_000,
    };
    engine = new RubaEngine(config);
    chain = new VaultChain(config, engine);
    await chain.initialize();
    const api = new RubaApi(engine, chain, config);
    const adminVault = vault.connect(adminTransactions) as Contract;

    for (const wallet of [lp, trader]) {
      checkStop();
      await (await adminVault.setWhitelist(wallet.address, true)).wait();
      await (await ruba.mint(wallet.address, parseUnits('10000', 18))).wait();
      await (await usdt.mint(wallet.address, parseUnits('10000', 6))).wait();
    }

    // Seed the AMM only after the indexer observes actual LP token deposits.
    const lpTransactions = new NonceManager(lp);
    const lpVault = vault.connect(lpTransactions) as Contract;
    const rubaSeed = parseUnits('1000', 18);
    const usdtSeed = parseUnits('1000', 6);
    await (await (ruba.connect(lpTransactions) as Contract).approve(vaultAddress, rubaSeed)).wait();
    await (await (usdt.connect(lpTransactions) as Contract).approve(vaultAddress, usdtSeed)).wait();
    await (await lpVault.deposit(rubaAddress, rubaSeed)).wait();
    await (await lpVault.deposit(usdtAddress, usdtSeed)).wait();
    await api.sync();
    engine.addLiquidity(lp.address, rubaSeed, usdtSeed, rubaSeed, usdtSeed);
    checkStop();

    server = api.createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    });
    stopWorker = api.startWorker();

    log(`RUBA UI: http://127.0.0.1:${port}/`);
    log(`Добавьте в кошелёк локальную сеть: RPC ${local.rpcUrl}, Chain ID 31337, валюта ETH.`);
    log(`RUBA: ${rubaAddress}`);
    log(`USDT: ${usdtAddress}`);
    log(`Хранилище: ${vaultAddress}`);
    log(`Тестовый кошелёк для интерфейса: ${trader.address}`);
    // This key is derived from the deliberately public Anvil test mnemonic.
    // Never print the configured operator key or a key supplied by the user.
    log('Общедоступный тестовый ключ Anvil для импорта в кошелёк — не использовать с реальными средствами:');
    log(trader.privateKey);
    log('На тестовом кошельке: 10 000 RUBA, 10 000 USDT и тестовый ETH. Внесите токены через страницу «Баланс».');
    log('Кошелёк уже допущен к локальному рынку. Подтверждение входа в UI не меняет whitelist.');
    log('Начальная ликвидность: 1 000 RUBA / 1 000 USDT. Ctrl+C остановит UI и удалит временную сеть и журнал.');
    // Keep the admin address discoverable for local debugging, but never its key.
    log(`Администратор локального хранилища: ${admin.address}`);
    await stopped;
  } catch (error) {
    if (!(error instanceof Error && error.message === 'LOCAL_DEVELOPMENT_STOPPED')) throw error;
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    stopWorker?.();
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
        server!.closeIdleConnections();
      });
    }
    chain?.close();
    engine?.close();
    await local?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevelopment().catch((error: Error) => {
    const message = /EPERM|operation not permitted/.test(error.message)
      ? 'Окружение запрещает открывать локальные порты. Запустите npm run dev в обычном терминале.'
      : /EADDRINUSE/.test(error.message)
        ? 'Порт интерфейса занят. Завершите другой процесс или задайте PORT, например PORT=3002 npm run dev.'
        : error.message;
    console.error(`Локальный RUBA не запущен: ${message}`);
    process.exitCode = 1;
  });
}
