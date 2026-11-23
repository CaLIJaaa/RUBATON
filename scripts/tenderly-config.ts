import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getAddress, MaxUint256, parseUnits, ZeroAddress } from 'ethers';
import { isTenderlyVirtualRpcUrl } from '../server/config.ts';

export interface TenderlySettings {
  rpcUrl: string;
  publicRpcUrl?: string;
  testWalletAddress: string;
  chainMode: 'tenderly';
  seedRuba: bigint;
  seedUsdt: bigint;
  walletRuba: bigint;
  walletUsdt: bigint;
  walletEth: bigint;
  port: number;
  host: '127.0.0.1';
  stateDirectory: string;
}

type FoundryConfigReader = (root: string, env: NodeJS.ProcessEnv) => unknown;

function readFoundryConfig(root: string, env: NodeJS.ProcessEnv): unknown {
  const result = spawnSync('forge', ['config', '--json'], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Foundry errors can contain endpoint credentials. Keep diagnostics local to
  // the setting name rather than forwarding its stdout/stderr.
  if (result.error || result.status !== 0) {
    throw new Error('Не удалось прочитать foundry.toml через forge config --json. Проверьте Foundry или задайте TENDERLY_RPC_URL.');
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('forge config --json вернул некорректную конфигурацию.'); }
}

function configuredRpc(env: NodeJS.ProcessEnv, root: string, readConfig: FoundryConfigReader): string {
  const direct = env.TENDERLY_RPC_URL?.trim();
  if (direct) return direct;
  const alias = env.TENDERLY_RPC_ENDPOINT?.trim() || 'mainnet';
  const config = readConfig(root, env);
  const endpoints = config && typeof config === 'object' && 'rpc_endpoints' in config
    ? config.rpc_endpoints : undefined;
  const endpoint = endpoints && typeof endpoints === 'object' && Object.hasOwn(endpoints, alias)
    ? (endpoints as Record<string, unknown>)[alias] : undefined;
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new Error('Задайте TENDERLY_RPC_URL или RPC-алиас TENDERLY_RPC_ENDPOINT в [rpc_endpoints] файла foundry.toml.');
  }
  return endpoint.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Не задана переменная ${key} для RPC-алиаса foundry.toml.`);
    return value.trim();
  }).trim();
}

function positiveAmount(env: NodeJS.ProcessEnv, key: string, fallback: string, decimals: number): bigint {
  const value = env[key]?.trim() ?? fallback;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Некорректное значение ${key}: нужна положительная десятичная сумма.`);
  let parsed: bigint;
  try { parsed = parseUnits(value, decimals); }
  catch { throw new Error(`Некорректное значение ${key}: допустимо не более ${decimals} знаков после точки.`); }
  if (parsed <= 0n || parsed > MaxUint256) throw new Error(`Некорректное значение ${key}: сумма должна быть положительной и помещаться в uint256.`);
  return parsed;
}

/** Validates settings without making RPC calls or touching deployment state. */
export function parseTenderlySettings(rpcUrl: string, env: NodeJS.ProcessEnv = process.env, root = process.cwd()): TenderlySettings {
  rpcUrl = rpcUrl.trim();
  if (!isTenderlyVirtualRpcUrl(rpcUrl)) {
    throw new Error('TENDERLY_RPC_URL должен быть HTTPS Admin RPC Tenderly Virtual TestNet.');
  }
  const publicRpcUrl = env.TENDERLY_PUBLIC_RPC_URL?.trim() || undefined;
  if (publicRpcUrl && !isTenderlyVirtualRpcUrl(publicRpcUrl)) {
    throw new Error('TENDERLY_PUBLIC_RPC_URL должен быть HTTPS RPC Tenderly Virtual TestNet.');
  }
  if (publicRpcUrl && new URL(publicRpcUrl).href === new URL(rpcUrl).href) {
    throw new Error('Admin RPC и Public RPC должны быть разными. Скопируйте Public RPC из Tenderly или оставьте его поле пустым.');
  }
  let testWalletAddress: string;
  try { testWalletAddress = getAddress(env.TEST_WALLET_ADDRESS?.trim() ?? ''); }
  catch { throw new Error('Укажите публичный адрес своего кошелька 0x… в TEST_WALLET_ADDRESS. Приватный ключ не нужен.'); }
  if (testWalletAddress === ZeroAddress) throw new Error('TEST_WALLET_ADDRESS не может быть нулевым адресом.');
  const rawPort = env.PORT?.trim() ?? '3001';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535.');
  }
  return {
    rpcUrl, publicRpcUrl, testWalletAddress, chainMode: 'tenderly',
    seedRuba: positiveAmount(env, 'TENDERLY_SEED_RUBA', '1000', 18),
    seedUsdt: positiveAmount(env, 'TENDERLY_SEED_USDT', '1000', 6),
    walletRuba: positiveAmount(env, 'TENDERLY_WALLET_RUBA', '10000', 18),
    walletUsdt: positiveAmount(env, 'TENDERLY_WALLET_USDT', '10000', 6),
    walletEth: positiveAmount(env, 'TENDERLY_WALLET_ETH', '10', 18),
    port, host: '127.0.0.1',
    stateDirectory: resolve(root, 'data', 'tenderly', createHash('sha256').update(rpcUrl).digest('hex').slice(0, 16)),
  };
}

export async function loadTenderlySettings(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
  readConfig: FoundryConfigReader = readFoundryConfig,
): Promise<TenderlySettings> {
  return parseTenderlySettings(configuredRpc(env, root, readConfig), env, root);
}
