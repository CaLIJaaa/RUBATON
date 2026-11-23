import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Wallet, getAddress, keccak256, parseUnits } from 'ethers';
import { randomField, keyCommit } from '../zk/crypto.js';
import type { DemoSymbol, MarketId } from '../server/market-types.ts';

export const SEPOLIA_CHAIN_ID = 11155111n;
export const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
export const ASSETS: Record<DemoSymbol, { name: string; symbol: DemoSymbol; decimals: number; faucet: string }> = {
  RUBA: { name: 'Demo RUBA', symbol: 'RUBA', decimals: 18, faucet: '10000' },
  USDT: { name: 'Demo USDT', symbol: 'USDT', decimals: 6, faucet: '10000' },
  WETH: { name: 'Demo WETH', symbol: 'WETH', decimals: 18, faucet: '10' },
  WBTC: { name: 'Demo WBTC', symbol: 'WBTC', decimals: 8, faucet: '1' },
};
export const POOLS: { id: MarketId; assets: [DemoSymbol, DemoSymbol]; seed: [string, string]; bot: [string, string] }[] = [
  { id: 'ruba-usdt', assets: ['RUBA', 'USDT'], seed: ['3000', '3000'], bot: ['3000', '3000'] },
  { id: 'ruba-weth', assets: ['RUBA', 'WETH'], seed: ['3000', '1'], bot: ['3000', '1'] },
  { id: 'weth-wbtc', assets: ['WETH', 'WBTC'], seed: ['3', '0.1'], bot: ['3', '0.1'] },
];
export interface RoleKey { address: string; privateKey: string }
export interface PrivateMarketKeys {
  version: 1; chainId: string; roles: { lp: RoleKey; bot: RoleKey; prover: RoleKey };
  poolKeys: Record<string, string>; databasePaths: Record<string, string>;
}
export interface DeploymentStep {
  status: 'signed' | 'mined' | 'confirmed'; sender: string; nonce: string; intentHash: string;
  transactionHash: string; to: string | null; value: string; predictedAddress?: string;
  blockNumber?: number; blockHash?: string; gasUsed?: string; codeHash?: string;
}
export interface DeploymentManifest {
  schemaVersion: 1; deploymentId: string; status: 'prepared' | 'deployed' | 'ready';
  network: { name: string; chainId: string; genesisHash?: string; identityCheckpoint?: { kind: 'genesis' | 'finalized'; blockNumber: number; blockHash: string }; genesisAvailability?: 'verified' | 'pruned'; explorerUrl: string; confirmations: number };
  artifacts: { zkManifestSha256: string; verificationKeyHash: string; verifierRuntimeCodeHash: string; poseidonRuntimeCodeHash: string; vaultArtifactSha256: string; tokenArtifactSha256: string };
  roles: { deployer: string; admin: string; lp: string; bot: string; prover: string; testWallet?: string; authorizedTestWallets?: string[] };
  shared: { verifier: string; poseidon: string };
  tokens: Record<string, { address: string; symbol: string; decimals: number; faucetAmount: string }>;
  pools: Record<string, { id: string; label: string; assets: [DemoSymbol, DemoSymbol]; vault: string; deploymentBlock?: number; poolKeyCommit: string; seedAmounts: [string, string]; botAmounts: [string, string]; acceptedStateVersion?: string; acceptedRoot?: string }>;
  steps: Record<string, DeploymentStep>;
  budget?: { source: string; deploymentGas: string; setupGas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; roleFundingWei: string; roleFundingByRoleWei?: { lp: string; bot: string }; totalRequiredWei: string; balanceWei: string; sufficient: boolean;
    revisions?: { proposalDigest: string; blockNumber: number; blockHash: string; previousCeilingWei: string; ceilingWei: string; committedUpperBoundWei: string; remainingUpperBoundWei: string; carriedSetupReserveGas: string }[] };
}
export interface SepoliaSettings { directory: string; rpcUrl: string; port: number; confirmations: number; artifactsDir: string; testWallet?: string }
export const encode = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.tmp`;
  writeFileSync(temp, encode(value), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path); chmodSync(path, 0o600);
}
export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
export function validateRole(value: RoleKey): RoleKey {
  if (!value || getAddress(value.address) !== new Wallet(value.privateKey).address) throw new Error('Dedicated wallet address/key mismatch');
  return { address: getAddress(value.address), privateKey: value.privateKey };
}
export function loadSepoliaSettings(env: NodeJS.ProcessEnv = process.env): SepoliaSettings {
  const rpcUrl = env.SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC;
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Sepolia RPC must use HTTPS');
  const integer = (value: string, min: number, max: number) => { const n = Number(value); if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid Sepolia runtime numeric setting'); return n; };
  return { directory: resolve(env.SEPOLIA_STATE_DIR ?? 'data/sepolia'), rpcUrl,
    port: integer(env.PORT ?? '3001', 1, 65535), confirmations: integer(env.SEPOLIA_CONFIRMATIONS ?? '1', 1, 100),
    artifactsDir: resolve(env.ZK_ARTIFACTS_DIR ?? 'zk/artifacts'), ...(env.SEPOLIA_TEST_WALLET ? { testWallet: getAddress(env.SEPOLIA_TEST_WALLET) } : {}) };
}
export function loadDeployer(directory: string): RoleKey {
  const path = join(directory, 'deployer.json');
  if (!existsSync(path)) throw new Error('Dedicated deployer wallet is missing; create data/sepolia/deployer.json locally first');
  chmodSync(path, 0o600); return validateRole(readJson<RoleKey>(path));
}
export function loadPrivateMarketKeys(directory: string, chainId: bigint, create = false, roleKeys?: PrivateMarketKeys['roles']): PrivateMarketKeys {
  const path = join(directory, 'privatekeys.json');
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    const keys = readJson<PrivateMarketKeys>(path);
    if (keys.version !== 1 || keys.chainId !== chainId.toString()) throw new Error('Private market keys belong to another chain');
    Object.values(keys.roles).forEach(validateRole);
    const distinct = new Set(POOLS.map((pool) => { const key = BigInt(keys.poolKeys[pool.id]); keyCommit(key); if (key <= 0n) throw new Error('Invalid private pool recovery key'); return key.toString(); }));
    if (distinct.size !== POOLS.length) throw new Error('Each market requires a distinct pool recovery key');
    return keys;
  }
  if (!create) throw new Error('Private market keys are missing; refusing to replace published state');
  const role = (): RoleKey => { const wallet = Wallet.createRandom(); return { address: wallet.address, privateKey: wallet.privateKey }; };
  const keys: PrivateMarketKeys = { version: 1, chainId: chainId.toString(), roles: roleKeys ?? { lp: role(), bot: role(), prover: role() },
    poolKeys: Object.fromEntries(POOLS.map((pool) => [pool.id, randomField().toString()])),
    databasePaths: Object.fromEntries(POOLS.map((pool) => [pool.id, join(directory, 'markets', pool.id, 'ledger.sqlite')])) };
  writePrivateJson(path, keys); return keys;
}
export function artifact(directory: string, file: string, name = file) {
  const path = resolve('out', `${file}.sol`, `${name}.json`);
  const bytes = readFileSync(path); const json = JSON.parse(bytes.toString());
  return { abi: json.abi, bytecode: json.bytecode.object.startsWith('0x') ? json.bytecode.object : `0x${json.bytecode.object}`, sha256: sha256(bytes) };
}
export function artifactPins(directory: string): DeploymentManifest['artifacts'] {
  const bytes = readFileSync(join(directory, 'manifest.json')); const zk = JSON.parse(bytes.toString());
  if (zk.version !== 2 || zk.circuit !== 'ruba-transition-v2') throw new Error('Unsupported circuit artifact manifest');
  return { zkManifestSha256: sha256(bytes), verificationKeyHash: zk.verificationKeyHash,
    verifierRuntimeCodeHash: zk.verifierRuntimeCodeHash, poseidonRuntimeCodeHash: zk.poseidonRuntimeCodeHash,
    vaultArtifactSha256: artifact(directory, 'ZkRubaVault').sha256, tokenArtifactSha256: artifact(directory, 'DemoToken').sha256 };
}
export function verifyManifest(manifest: DeploymentManifest, chainId: bigint, keys: PrivateMarketKeys, pins: DeploymentManifest['artifacts']): void {
  if (manifest.schemaVersion !== 1 || manifest.network.chainId !== chainId.toString()) throw new Error('Deployment manifest belongs to another network/schema');
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(pins)) throw new Error('Pinned deployment artifacts changed; do not overwrite the existing release');
  for (const pool of POOLS) if (BigInt(manifest.pools[pool.id]?.poolKeyCommit) !== keyCommit(keys.poolKeys[pool.id])) throw new Error('Pool recovery key differs from its immutable deployment commitment');
  for (const role of ['lp', 'bot', 'prover'] as const) if (getAddress(manifest.roles[role]) !== getAddress(keys.roles[role].address)) throw new Error('Private role wallet differs from the deployment manifest');
}
export const atomic = (symbol: DemoSymbol, amount: string) => parseUnits(amount, ASSETS[symbol].decimals);
