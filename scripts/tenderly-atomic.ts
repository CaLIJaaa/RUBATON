import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Contract, ContractFactory, Interface, JsonRpcProvider, MaxUint256, NonceManager, Transaction,
  Wallet, ZeroHash, formatUnits, getAddress, getCreateAddress, isHexString, keccak256, parseEther, toQuantity,
} from 'ethers';
import type { TransactionReceipt } from 'ethers';
import { RubaApi } from '../server/api.ts';
import { VaultChain } from '../server/chain.ts';
import type { ServerConfig } from '../server/config.ts';
import { RubaEngine } from '../server/engine.ts';
import type { TenderlySettings } from './tenderly-config.ts';
import { MAINNET_USDT, ensureForkBalance, explainTenderlyFailure, seedTenderlyPool } from './tenderly-common.ts';

export const VNET_PRECOMPILE = '0xc100000000000000000000000000000000000000';
const SEED_MARKER = 'tenderly:initial-liquidity';
const TOKEN_ABI = ['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)'];
const BOOTSTRAP_ABI = [
  'function RUBA() view returns(address)', 'function VAULT() view returns(address)',
  'function TEST_WALLET() view returns(address)', 'function SEEDER() view returns(address)',
  'function SEED_RUBA() view returns(uint256)', 'function SEED_USDT() view returns(uint256)',
  'function USE_PRECOMPILE() view returns(bool)',
];
const ADMIN_ABI = [
  'function owner() view returns(address)', 'function operator() view returns(address)',
  'function whitelist(address) view returns(bool)',
  'function prepareTestWallet(address,uint256)',
  'function prepareTestWalletWithCheatcodes(address,uint256,uint256,uint256)',
];

export interface AtomicDeployment {
  version: 2;
  chainId: string;
  deployerKey: string;
  operatorKey: string;
  seederKey: string;
  bootstrapAddress: string;
  bootstrapNonce: number;
  usePrecompile: boolean;
  plan: { testWallet: string; walletRuba: string; walletUsdt: string; walletEth: string; seedRuba: string; seedUsdt: string };
  bootstrapRawTransaction?: string;
  bootstrapTransactionHash?: string;
  rubaAddress?: string;
  vaultAddress?: string;
  deploymentBlock?: number;
  ledgerInitialized?: boolean;
  lastPreparedWallet?: string;
  pendingWallet?: { account: string; rawTransaction: string; transactionHash: string };
}

type BalanceRpc = Pick<JsonRpcProvider, 'getBalance' | 'send'>;

/** A single Admin write for each distinct target, skipping every sufficient balance. */
export async function fundNativeBatch(provider: BalanceRpc, targets: { account: string; amount: bigint }[]): Promise<number> {
  const groups = new Map<bigint, string[]>();
  const unique = new Map<string, bigint>();
  for (const target of targets) {
    const account = getAddress(target.account);
    unique.set(account, target.amount > (unique.get(account) ?? 0n) ? target.amount : unique.get(account)!);
  }
  for (const [account, target] of unique) {
    if (await provider.getBalance(account) < target) groups.set(target, [...(groups.get(target) ?? []), account]);
  }
  for (const [target, accounts] of groups) {
    await provider.send('tenderly_setBalance', [accounts, toQuantity(target)]);
    for (const account of accounts) {
      if (await provider.getBalance(account) < target) throw new Error('Tenderly не подтвердил групповое пополнение ETH.');
    }
  }
  return groups.size;
}

export async function supportsVnetPrecompile(provider: Pick<JsonRpcProvider, 'call'>): Promise<boolean> {
  const abi = new Interface(['function getStorageAt(address,bytes32) view returns(bytes32)']);
  try {
    const result = await provider.call({ to: VNET_PRECOMPILE, data: abi.encodeFunctionData('getStorageAt', [MAINNET_USDT, ZeroHash]) });
    return isHexString(result, 32);
  } catch (error) {
    // Missing precompile is a capability result. Connectivity/quota failures are not.
    if (['CALL_EXCEPTION', 'BAD_DATA'].includes(String((error as {code?: string}).code))) return false;
    throw error;
  }
}

type BroadcastRpc = Pick<JsonRpcProvider, 'getTransactionReceipt' | 'getTransaction' | 'broadcastTransaction' | 'waitForTransaction'>;

/** Never allocate another nonce after losing a deployment response. Replay identical signed bytes only. */
export async function sendRecoverableTransaction(provider: BroadcastRpc, saved: {
  bootstrapRawTransaction: string; bootstrapTransactionHash: string;
}): Promise<TransactionReceipt> {
  if (keccak256(saved.bootstrapRawTransaction) !== saved.bootstrapTransactionHash) throw new Error('Повреждена сохранённая транзакция подготовки.');
  let receipt = await provider.getTransactionReceipt(saved.bootstrapTransactionHash);
  if (!receipt) {
    const pending = await provider.getTransaction(saved.bootstrapTransactionHash);
    if (!pending) {
      try { await provider.broadcastTransaction(saved.bootstrapRawTransaction); }
      catch (error) {
        receipt = await provider.getTransactionReceipt(saved.bootstrapTransactionHash);
        if (!receipt) throw error;
      }
    }
    receipt ??= await provider.waitForTransaction(saved.bootstrapTransactionHash, 1, 120_000);
  }
  if (!receipt) throw new Error('Подготовка ещё не подтверждена. Повторите запуск: будет проверена та же транзакция.');
  if (receipt.status !== 1) throw new Error('Сохранённая транзакция откатилась целиком. Новая транзакция автоматически не отправляется. Проверьте причину в Tenderly.');
  return receipt;
}

export async function sendRecoverableBootstrap(provider: BroadcastRpc, saved: {
  bootstrapRawTransaction: string; bootstrapTransactionHash: string; bootstrapAddress: string;
}): Promise<TransactionReceipt> {
  const receipt = await sendRecoverableTransaction(provider, saved);
  if (!receipt.contractAddress || getAddress(receipt.contractAddress) !== getAddress(saved.bootstrapAddress)) {
    throw new Error('Адрес подтверждённой подготовки не совпадает с сохранённым планом.');
  }
  return receipt;
}

async function save(path: string, deployment: AtomicDeployment): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(deployment, null, 2) + '\n', { mode: 0o600 });
  await chmod(`${path}.tmp`, 0o600);
  await rename(`${path}.tmp`, path);
}

function checkedDeployment(value: unknown, chainId: bigint): AtomicDeployment {
  const saved = value as AtomicDeployment;
  if (!saved || saved.version !== 2 || saved.chainId !== chainId.toString() || !saved.plan
    || !Number.isSafeInteger(saved.bootstrapNonce) || saved.bootstrapNonce < 0 || typeof saved.usePrecompile !== 'boolean') {
    throw new Error('Сохранённая подготовка не соответствует этому форку.');
  }
  const deployer = new Wallet(saved.deployerKey);
  new Wallet(saved.operatorKey); new Wallet(saved.seederKey);
  if (getCreateAddress({ from: deployer.address, nonce: saved.bootstrapNonce }) !== getAddress(saved.bootstrapAddress)) {
    throw new Error('Повреждён адрес сохранённой подготовки.');
  }
  getAddress(saved.plan.testWallet);
  for (const key of ['walletRuba', 'walletUsdt', 'walletEth', 'seedRuba', 'seedUsdt'] as const) {
    if (!/^(0|[1-9][0-9]*)$/.test(saved.plan[key]) || BigInt(saved.plan[key]) > MaxUint256) throw new Error('Повреждены суммы сохранённой подготовки.');
  }
  if (saved.bootstrapRawTransaction) {
    const transaction = Transaction.from(saved.bootstrapRawTransaction);
    if (transaction.from !== deployer.address || transaction.nonce !== saved.bootstrapNonce || transaction.to !== null
      || transaction.chainId !== chainId || transaction.hash !== saved.bootstrapTransactionHash) {
      throw new Error('Сохранённая транзакция относится к другой подготовке.');
    }
  }
  if (saved.pendingWallet) {
    const transaction = Transaction.from(saved.pendingWallet.rawTransaction);
    if (transaction.from !== deployer.address || transaction.chainId !== chainId
      || transaction.to !== saved.vaultAddress || transaction.hash !== saved.pendingWallet.transactionHash) {
      throw new Error('Сохранённое пополнение относится к другому рынку.');
    }
    getAddress(saved.pendingWallet.account);
  }
  return saved;
}

export async function prepareAtomicTenderly(settings: TenderlySettings, log: (line: string) => void, fundOnly = false,
  dependencies: { providerFactory?: (url: string) => JsonRpcProvider } = {}) {
  const provider = dependencies.providerFactory?.(settings.rpcUrl)
    ?? new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 1_000;
  const publicProvider = settings.publicRpcUrl ? new JsonRpcProvider(settings.publicRpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 }) : undefined;
  let chain: VaultChain | undefined;
  let engine: RubaEngine | undefined;
  let phase = 'проверить RPC';
  try {
    log('Проверяю форк и доступность атомарной подготовки…');
    const network = await provider.getNetwork();
    if (network.chainId === 1n) throw new Error('Для Tenderly нужен отдельный Chain ID, например 73571; Chain ID 1 здесь запрещён.');
    await provider.send('evm_getLatest', []);
    const usdt = new Contract(MAINNET_USDT, TOKEN_ABI, provider);
    if (await provider.getCode(MAINNET_USDT) === '0x' || BigInt(await usdt.decimals()) !== 6n) {
      throw new Error('Нужен форк Ethereum mainnet с USDT (6 знаков).');
    }
    if (publicProvider) {
      if ((await publicProvider.getNetwork()).chainId !== network.chainId) throw new Error('Admin и Public RPC должны относиться к одному форку.');
      let adminCapable = false;
      try { await publicProvider.send('evm_getLatest', []); adminCapable = true; } catch { /* Expected for Public RPC. */ }
      if (adminCapable) throw new Error('В поле Public RPC указан Admin RPC.');
    }
    await mkdir(settings.stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(settings.stateDirectory, 'deployment.json');
    let saved: AtomicDeployment | undefined;
    try { saved = checkedDeployment(JSON.parse(await readFile(path, 'utf8')), network.chainId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!saved) {
      if (fundOnly) throw new Error('Сначала выполните подготовку нового форка.');
      if (settings.walletRuba + settings.seedRuba > MaxUint256) throw new Error('Суммарный выпуск RUBA превышает uint256.');
      const deployer = Wallet.createRandom();
      const walletUsdt = BigInt(await usdt.balanceOf(settings.testWalletAddress));
      const usdtShortfall = settings.walletUsdt > walletUsdt ? settings.walletUsdt - walletUsdt : 0n;
      if (usdtShortfall + settings.seedUsdt > MaxUint256) throw new Error('Суммарное пополнение USDT превышает uint256.');
      const nonce = await provider.getTransactionCount(deployer.address, 'pending');
      saved = {
        version: 2, chainId: network.chainId.toString(), deployerKey: deployer.privateKey,
        operatorKey: Wallet.createRandom().privateKey, seederKey: Wallet.createRandom().privateKey,
        bootstrapNonce: nonce, bootstrapAddress: getCreateAddress({ from: deployer.address, nonce }),
        usePrecompile: await supportsVnetPrecompile(provider),
        plan: {
          testWallet: settings.testWalletAddress, walletRuba: settings.walletRuba.toString(),
          walletUsdt: usdtShortfall.toString(), walletEth: settings.walletEth.toString(),
          seedRuba: settings.seedRuba.toString(), seedUsdt: settings.seedUsdt.toString(),
        },
      };
      await save(path, saved);
    }
    const deployer = new Wallet(saved.deployerKey, provider);
    const operator = new Wallet(saved.operatorKey);
    const seeder = new Wallet(saved.seederKey);
    const deployedBefore = Boolean(saved.vaultAddress);
    if (!deployedBefore) {
      if (fundOnly) throw new Error('Подготовка ещё не завершена. Сначала продолжите настройку форка.');
      if (saved.plan.testWallet !== settings.testWalletAddress) throw new Error('Незавершённая подготовка сохранена для другого кошелька. Сначала продолжите её с первоначальным адресом.');
      phase = 'подготовить средства для атомарного развёртывания';
      if (!saved.bootstrapRawTransaction) {
        if (saved.usePrecompile) {
          log('Режим: 2 операции подготовки — ETH deployer и одна атомарная транзакция. Если лимит 20 ещё не использован, останется 18.');
          await fundNativeBatch(provider, [{ account: deployer.address, amount: parseEther('10') }]);
        } else {
          log('Режим совместимости: обычно 3 операции подготовки; с разными суммами ETH — до 4.');
          await fundNativeBatch(provider, [
            ...[deployer.address, operator.address, seeder.address].map((account) => ({ account, amount: parseEther('10') })),
            { account: saved.plan.testWallet, amount: BigInt(saved.plan.walletEth) },
          ]);
          const total = BigInt(saved.plan.seedUsdt) + BigInt(saved.plan.walletUsdt);
          await ensureForkBalance(async () => BigInt(await usdt.balanceOf(saved!.bootstrapAddress)), total,
            (value) => provider.send('tenderly_setErc20Balance', [MAINNET_USDT, saved!.bootstrapAddress, toQuantity(value)]));
        }
        const artifact = JSON.parse(await readFile(new URL('../out/TenderlyBootstrap.sol/TenderlyBootstrap.json', import.meta.url), 'utf8'));
        const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, deployer);
        const request = await factory.getDeployTransaction(
          MAINNET_USDT, deployer.address, operator.address, saved.plan.testWallet, seeder.address,
          saved.plan.walletRuba, saved.plan.walletUsdt, saved.plan.seedRuba, saved.plan.seedUsdt,
          saved.plan.walletEth, saved.usePrecompile,
        );
        const populated = await deployer.populateTransaction({ ...request, nonce: saved.bootstrapNonce });
        saved.bootstrapRawTransaction = await deployer.signTransaction(populated);
        saved.bootstrapTransactionHash = keccak256(saved.bootstrapRawTransaction);
        await save(path, saved); // Persist exact bytes before the first send.
      }
      phase = 'подтвердить атомарную транзакцию подготовки';
      log('Одной транзакцией создаю RUBA/vault, выдаю токены и допуск, вношу оба токена в хранилище…');
      const receipt = await sendRecoverableBootstrap(provider, saved as AtomicDeployment & {bootstrapRawTransaction: string; bootstrapTransactionHash: string});
      const bootstrap = new Contract(saved.bootstrapAddress, BOOTSTRAP_ABI, provider);
      const [ruba, vault, account, seedAccount, seedRuba, seedUsdt, precompile] = await Promise.all([
        bootstrap.RUBA(), bootstrap.VAULT(), bootstrap.TEST_WALLET(), bootstrap.SEEDER(),
        bootstrap.SEED_RUBA(), bootstrap.SEED_USDT(), bootstrap.USE_PRECOMPILE(),
      ]);
      if (getAddress(account) !== saved.plan.testWallet || getAddress(seedAccount) !== seeder.address
        || seedRuba !== BigInt(saved.plan.seedRuba) || seedUsdt !== BigInt(saved.plan.seedUsdt) || precompile !== saved.usePrecompile) {
        throw new Error('Подтверждённая подготовка не совпадает с сохранёнными параметрами.');
      }
      saved.rubaAddress = getAddress(ruba);
      saved.vaultAddress = getAddress(vault);
      saved.deploymentBlock = receipt.blockNumber;
      saved.lastPreparedWallet = saved.plan.testWallet;
      await save(path, saved);
    } else log('Использую сохранённые контракты. Повторное развёртывание и автоматическая выдача средств не выполняются.');
    if (!saved.rubaAddress || !saved.vaultAddress || !Number.isSafeInteger(saved.deploymentBlock)) throw new Error('Неполное сохранённое развёртывание.');
    if (await provider.getCode(saved.vaultAddress) === '0x' || await provider.getCode(saved.rubaAddress) === '0x') {
      throw new Error('Контракты отсутствуют: возможно, форк сброшен. Сохранённый журнал нельзя использовать с другой историей.');
    }
    const config: ServerConfig = {
      rpcUrl: settings.rpcUrl, chainId: network.chainId, chainMode: 'tenderly',
      vaultAddress: saved.vaultAddress, rubaAddress: saved.rubaAddress, usdtAddress: MAINNET_USDT,
      operatorPrivateKey: saved.operatorKey, deploymentBlock: saved.deploymentBlock!, confirmations: 0,
      withdrawalTtl: 900n, dbPath: join(settings.stateDirectory, 'ledger.sqlite'), host: settings.host,
      port: settings.port, syncIntervalMs: 2_000,
    };
    if (saved.ledgerInitialized) {
      try { await access(config.dbPath); } catch { throw new Error('Уже настроенный рынок потерял журнал. Восстановите data/tenderly из резервной копии.'); }
    }
    const adminVault = new Contract(config.vaultAddress, ADMIN_ABI, new NonceManager(deployer));
    if (getAddress(await adminVault.owner()) !== deployer.address || getAddress(await adminVault.operator()) !== operator.address) {
      throw new Error('Владелец или оператор сохранённого vault изменён.');
    }
    if (saved.pendingWallet) {
      log('Подтверждаю сохранённое пополнение: повторная отправка использует ту же транзакцию.');
      await sendRecoverableTransaction(provider, {
        bootstrapRawTransaction: saved.pendingWallet.rawTransaction,
        bootstrapTransactionHash: saved.pendingWallet.transactionHash,
      });
      saved.lastPreparedWallet = saved.pendingWallet.account;
      delete saved.pendingWallet;
      await save(path, saved);
    }
    if (deployedBefore && (fundOnly || (saved.lastPreparedWallet ?? saved.plan.testWallet) !== settings.testWalletAddress)) {
      phase = 'пополнить тестовый кошелёк';
      const ruba = new Contract(config.rubaAddress, TOKEN_ABI, provider);
      const [rubaBalance, usdtBalance, ethBalance, allowed] = await Promise.all([
        ruba.balanceOf(settings.testWalletAddress), usdt.balanceOf(settings.testWalletAddress),
        provider.getBalance(settings.testWalletAddress), adminVault.whitelist(settings.testWalletAddress),
      ]);
      const mint = settings.walletRuba > rubaBalance ? settings.walletRuba - rubaBalance : 0n;
      let request;
      if (saved.usePrecompile) {
        if (mint || !allowed || usdtBalance < settings.walletUsdt || ethBalance < settings.walletEth) {
          log('Пополняю кошелёк и допуск одной атомарной транзакцией…');
          request = await adminVault.prepareTestWalletWithCheatcodes.populateTransaction(settings.testWalletAddress, mint, settings.walletUsdt, settings.walletEth);
        }
      } else {
        await fundNativeBatch(provider, [{ account: settings.testWalletAddress, amount: settings.walletEth }]);
        await ensureForkBalance(async () => BigInt(await usdt.balanceOf(settings.testWalletAddress)), settings.walletUsdt,
          (value) => provider.send('tenderly_setErc20Balance', [MAINNET_USDT, settings.testWalletAddress, toQuantity(value)]));
        if (mint || !allowed) request = await adminVault.prepareTestWallet.populateTransaction(settings.testWalletAddress, mint);
      }
      if (request) {
        const rawTransaction = await deployer.signTransaction(await deployer.populateTransaction(request));
        saved.pendingWallet = { account: settings.testWalletAddress, rawTransaction, transactionHash: keccak256(rawTransaction) };
        await save(path, saved);
        await sendRecoverableTransaction(provider, {
          bootstrapRawTransaction: rawTransaction, bootstrapTransactionHash: saved.pendingWallet.transactionHash,
        });
        delete saved.pendingWallet;
      }
      saved.lastPreparedWallet = settings.testWalletAddress;
      await save(path, saved);
    }
    phase = 'подтвердить депозиты и восстановить пул';
    engine = new RubaEngine(config);
    chain = new VaultChain(config, engine);
    await chain.initialize();
    const api = new RubaApi(engine, chain, config);
    await seedTenderlyPool({
      engine, account: seeder.address, ruba: BigInt(saved.plan.seedRuba), usdt: BigInt(saved.plan.seedUsdt),
      sync: () => api.sync(),
      deposit: async () => { throw new Error('Атомарные депозиты не найдены. Повторные транзакции автоматически не отправляются.'); },
    });
    if (!saved.ledgerInitialized) { saved.ledgerInitialized = true; await save(path, saved); }
    if (publicProvider) {
      const boundary = await provider.getBlock('latest');
      const mirror = boundary && await publicProvider.getBlock(boundary.number);
      if (!boundary?.hash || mirror?.hash !== boundary.hash) throw new Error('Admin и Public RPC относятся к разной истории форка.');
    }
    const reserves = engine.snapshot().reserves;
    log(`Tenderly Chain ID: ${network.chainId}; кошелёк: ${settings.testWalletAddress}`);
    log(`RUBA: ${config.rubaAddress}; USDT: ${MAINNET_USDT}; RubaVault: ${config.vaultAddress}`);
    log(`Ликвидность: ${formatUnits(reserves.RUBA, 18)} RUBA / ${formatUnits(reserves.USDT, 6)} USDT.`);
    log('Повторный запуск готового рынка: 0 операций записи. Пополнение отдельно: npm run tenderly:fund.');
    return { config, engine, chain, api, close() { chain!.close(); engine!.close(); provider.destroy(); publicProvider?.destroy(); } };
  } catch (error) {
    chain?.close(); engine?.close(); provider.destroy(); publicProvider?.destroy();
    throw explainTenderlyFailure(error, phase);
  }
}
