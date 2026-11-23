import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAddress, Wallet } from 'ethers';

export interface TokenMetadata { symbol: string; decimals: number }
export interface TokenMetadataPair { RUBA: TokenMetadata; USDT: TokenMetadata }

/** RUBA/USDT remain internal asset roles; human symbols and units belong to each market. */
export function tokenMetadata(config: Pick<ServerConfig, 'tokenMetadata'>): TokenMetadataPair {
  const value = config.tokenMetadata ?? { RUBA: { symbol: 'RUBA', decimals: 18 }, USDT: { symbol: 'USDT', decimals: 6 } };
  for (const token of ['RUBA', 'USDT'] as const) {
    const asset = value[token];
    if (!asset || !/^[A-Z][A-Z0-9]{0,11}$/.test(asset.symbol)
      || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) throw new Error('Invalid market token metadata');
  }
  return { RUBA: { ...value.RUBA }, USDT: { ...value.USDT } };
}

export interface ServerConfig {
  rpcUrl: string;
  chainId: bigint;
  /** Explicit test-chain finality for a Tenderly Virtual TestNet. */
  chainMode?: 'tenderly' | 'sepolia';
  marketId?: string;
  marketLabel?: string;
  tokenMetadata?: TokenMetadataPair;
  vaultAddress: string;
  rubaAddress: string;
  usdtAddress: string;
  operatorPrivateKey: string;
  deploymentBlock: number;
  confirmations: number;
  withdrawalTtl: bigint;
  dbPath: string;
  host: string;
  port: number;
  syncIntervalMs: number;
  /** Explicit proof protocol. Omitted only by retained legacy fixtures/launchers. */
  proofMode?: 'zk' | 'legacy';
  zkArtifactsDir?: string;
  zkPoolRecoveryKey?: bigint;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}; see .env.example`);
  return value;
}

function integer(value: string, key: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${key}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  return n;
}

/** Only Tenderly's HTTPS Virtual TestNet endpoints may opt out of consensus finality. */
export function isTenderlyVirtualRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.startsWith('virtual.')
      && url.hostname.endsWith('.rpc.tenderly.co') && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const chainId = BigInt(required(env, 'CHAIN_ID'));
  if (chainId <= 0n) throw new Error('Invalid CHAIN_ID');
  const rpcUrl = required(env, 'RPC_URL');
  const parsedUrl = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('RPC_URL must use HTTP(S)');
  const chainMode = env.CHAIN_MODE || undefined;
  if (chainMode !== undefined && chainMode !== 'tenderly' && chainMode !== 'sepolia') throw new Error('Invalid CHAIN_MODE; supported test modes are tenderly and sepolia');
  if (chainMode === 'sepolia' && chainId !== 11155111n) throw new Error('CHAIN_MODE=sepolia requires CHAIN_ID=11155111');
  if (chainMode === 'tenderly' && !isTenderlyVirtualRpcUrl(rpcUrl)) {
    throw new Error('CHAIN_MODE=tenderly requires an HTTPS Tenderly Virtual TestNet RPC_URL');
  }
  const operatorPrivateKey = required(env, 'OPERATOR_PRIVATE_KEY');
  new Wallet(operatorPrivateKey); // Reject invalid keys without printing them.
  const dbPath = resolve(env.DB_PATH ?? 'data/ruba.sqlite');
  const proofMode = env.PROOF_MODE ?? 'zk';
  if (proofMode !== 'zk' && proofMode !== 'legacy') throw new Error('Invalid PROOF_MODE; use zk or legacy');
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('MVP API must bind to a loopback address');
  const configuredMetadata = ['TOKEN0_SYMBOL', 'TOKEN1_SYMBOL', 'TOKEN0_DECIMALS', 'TOKEN1_DECIMALS'].some((name) => env[name] !== undefined)
    ? tokenMetadata({ tokenMetadata: {
      RUBA: { symbol: required(env, 'TOKEN0_SYMBOL'), decimals: integer(required(env, 'TOKEN0_DECIMALS'), 'TOKEN0_DECIMALS', 0, 18) },
      USDT: { symbol: required(env, 'TOKEN1_SYMBOL'), decimals: integer(required(env, 'TOKEN1_DECIMALS'), 'TOKEN1_DECIMALS', 0, 18) },
    } }) : undefined;
  return {
    rpcUrl, chainId, chainMode, operatorPrivateKey, dbPath, host, proofMode,
    ...(configuredMetadata ? { tokenMetadata: configuredMetadata } : {}),
    zkArtifactsDir: resolve(env.ZK_ARTIFACTS_DIR ?? 'zk/artifacts'),
    ...(env.ZK_POOL_RECOVERY_KEY ? { zkPoolRecoveryKey: BigInt(env.ZK_POOL_RECOVERY_KEY) } : {}),
    vaultAddress: getAddress(required(env, 'VAULT_ADDRESS')),
    rubaAddress: getAddress(required(env, 'RUBA_ADDRESS')),
    usdtAddress: getAddress(required(env, 'USDT_ADDRESS')),
    deploymentBlock: integer(required(env, 'VAULT_DEPLOYMENT_BLOCK'), 'VAULT_DEPLOYMENT_BLOCK', 0, Number.MAX_SAFE_INTEGER),
    confirmations: integer(env.CONFIRMATIONS ?? (chainId === 31337n || chainMode === 'tenderly' ? '0' : chainMode === 'sepolia' ? '1' : '12'), 'CONFIRMATIONS', 0, 10_000),
    withdrawalTtl: BigInt(integer(env.WITHDRAWAL_TTL_SECONDS ?? '900', 'WITHDRAWAL_TTL_SECONDS', 30, 3_600)),
    port: integer(env.PORT ?? '3001', 'PORT', 1, 65_535),
    syncIntervalMs: integer(env.SYNC_INTERVAL_MS ?? '2000', 'SYNC_INTERVAL_MS', 100, 60_000),
  };
}
