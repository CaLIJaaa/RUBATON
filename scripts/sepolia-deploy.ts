import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, getCreateAddress, parseUnits, keccak256 } from 'ethers';
import type { TransactionRequest } from 'ethers';
import { ASSETS, POOLS, SEPOLIA_CHAIN_ID, loadSepoliaSettings, loadDeployer, loadPrivateMarketKeys, artifact, artifactPins, readJson, writePrivateJson, verifyManifest, atomic } from './sepolia-config.ts';
import type { SepoliaSettings, RoleKey, PrivateMarketKeys, DeploymentManifest } from './sepolia-config.ts';
import { keyCommit } from '../zk/crypto.js';
import { DeploymentTransactions, InsufficientDeploymentFunds } from './sepolia-transactions.ts';
import { createMarketRuntimes, bootstrapMarkets, closeMarketRuntimes } from './sepolia-runtime.ts';
import { acquireDeploymentLock } from './sepolia-lock.ts';

export interface DeploymentEnvironment { settings: SepoliaSettings; provider: JsonRpcProvider; deployer: RoleKey; keys: PrivateMarketKeys; manifest: DeploymentManifest; save(): void }
export async function prepareDeployment(settings: SepoliaSettings, provider: JsonRpcProvider, deployer: RoleKey, keys: PrivateMarketKeys, expectedChainId = SEPOLIA_CHAIN_ID): Promise<DeploymentEnvironment> {
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== expectedChainId || BigInt(await provider.send('eth_chainId', [])) !== expectedChainId) throw new Error('RPC is not the explicitly requested deployment network');
  const path = join(settings.directory, 'manifest.json');
  const existing = existsSync(path) ? readJson<DeploymentManifest>(path) : undefined;
  let identity: { kind: 'genesis' | 'finalized'; blockNumber: number; blockHash: string };
  let genesisAvailability: 'verified' | 'pruned' = 'verified';
  if (existing?.network.identityCheckpoint) {
    identity = existing.network.identityCheckpoint;
    const pinned = await provider.getBlock(identity.blockNumber);
    if (!pinned?.hash || pinned.hash !== identity.blockHash) throw new Error('Pinned deployment network checkpoint unavailable or changed; use an archive RPC or reconcile the network');
    genesisAvailability = existing.network.genesisAvailability ?? (identity.kind === 'genesis' ? 'verified' : 'pruned');
  } else {
    let genesis;
    try { genesis = await provider.getBlock(0); } catch (error) {
      if (chainId !== SEPOLIA_CHAIN_ID) throw new Error('Anvil genesis must be available and pinned');
      genesisAvailability = 'pruned';
    }
    if (genesis?.hash) identity = { kind: 'genesis', blockNumber: 0, blockHash: genesis.hash };
    else {
      if (chainId !== SEPOLIA_CHAIN_ID) throw new Error('Anvil genesis must be available and pinned');
      if (existing && (Object.keys(existing.steps).length || existing.network.genesisHash)) throw new Error('Existing deployment genesis cannot be verified by this pruned RPC; provide an archive endpoint');
      const finalized = await provider.getBlock('finalized');
      if (!finalized?.hash || !Number.isSafeInteger(finalized.number) || finalized.number < 1) throw new Error('Sepolia RPC must provide a stable finalized identity checkpoint when genesis history is pruned');
      identity = { kind: 'finalized', blockNumber: finalized.number, blockHash: finalized.hash }; genesisAvailability = 'pruned';
    }
  }
  if (existing?.network.genesisHash && identity.kind === 'genesis' && existing.network.genesisHash !== identity.blockHash) throw new Error('Deployment network genesis changed; refusing another chain');

  const pins = artifactPins(settings.artifactsDir);
  let manifest: DeploymentManifest;
  if (existsSync(path)) {
    manifest = existing!;
    manifest.network.identityCheckpoint = identity; manifest.network.genesisAvailability = genesisAvailability;
    if (identity.kind === 'genesis') manifest.network.genesisHash = identity.blockHash;
    verifyManifest(manifest, chainId, keys, pins);
    if (getAddress(manifest.roles.deployer) !== deployer.address) throw new Error('Dedicated deployer differs from the immutable manifest');
  } else {
    const nonce = await provider.getTransactionCount(deployer.address, 'pending');
    const predicted = (offset: number) => getCreateAddress({ from: deployer.address, nonce: nonce + offset });
    const symbols = Object.keys(ASSETS) as (keyof typeof ASSETS)[];
    manifest = {
      schemaVersion: 1, deploymentId: `${chainId}-${deployer.address.toLowerCase()}-${nonce}`, status: 'prepared',
      network: { name: chainId === SEPOLIA_CHAIN_ID ? 'Sepolia' : 'Anvil', chainId: chainId.toString(), ...(identity.kind === 'genesis' ? { genesisHash: identity.blockHash } : {}), identityCheckpoint: identity, genesisAvailability, explorerUrl: chainId === SEPOLIA_CHAIN_ID ? 'https://sepolia.etherscan.io' : '', confirmations: chainId === SEPOLIA_CHAIN_ID ? settings.confirmations : 0 },
      artifacts: pins, roles: { deployer: deployer.address, admin: deployer.address, lp: keys.roles.lp.address, bot: keys.roles.bot.address, prover: keys.roles.prover.address, ...(settings.testWallet ? { testWallet: settings.testWallet } : {}) },
      shared: { verifier: predicted(4), poseidon: predicted(5) },
      tokens: Object.fromEntries(symbols.map((symbol, i) => [symbol, { address: predicted(i), symbol, decimals: ASSETS[symbol].decimals, faucetAmount: atomic(symbol, ASSETS[symbol].faucet).toString() }])),
      pools: Object.fromEntries(POOLS.map((pool, i) => [pool.id, { id: pool.id, label: pool.assets.join(' / '), assets: pool.assets,
        vault: predicted(6 + i), poolKeyCommit: keyCommit(keys.poolKeys[pool.id]).toString(),
        seedAmounts: pool.seed.map((amount, index) => atomic(pool.assets[index], amount).toString()),
        botAmounts: pool.bot.map((amount, index) => atomic(pool.assets[index], amount).toString()) }])), steps: {},
    } as DeploymentManifest;
  }
  if (settings.testWallet && settings.testWallet !== manifest.roles.testWallet) {
    const prior = Object.keys(manifest.steps).length ? [...(manifest.roles.authorizedTestWallets ?? []), ...(manifest.roles.testWallet ? [manifest.roles.testWallet] : [])] : [];
    manifest.roles.testWallet = settings.testWallet;
    manifest.roles.authorizedTestWallets = [...new Set([...prior, settings.testWallet])];
  }
  const save = () => writePrivateJson(path, manifest);
  const env = { settings, provider, deployer, keys, manifest, save };
  const privateJournalPath = join(settings.directory, 'transactions.json');
  const hasSignedPayload = existsSync(privateJournalPath) && Object.keys(readJson<{ steps: Record<string, unknown> }>(privateJournalPath).steps).length > 0;
  if ((Object.keys(manifest.steps).length || hasSignedPayload) && manifest.budget) {
    if (process.env.SEPOLIA_MAX_TOTAL_FEE_WEI && BigInt(manifest.budget.totalRequiredWei) > BigInt(process.env.SEPOLIA_MAX_TOTAL_FEE_WEI)) throw new Error('Existing prepared deployment exceeds the current total funding cap');
    if (process.env.SEPOLIA_MAX_FEE_PER_GAS_WEI && BigInt(manifest.budget.maxFeePerGas) > BigInt(process.env.SEPOLIA_MAX_FEE_PER_GAS_WEI)) throw new Error('Existing signed plan exceeds the current gas fee cap');
    const balance = await provider.getBalance(deployer.address);
    manifest.budget.balanceWei = balance.toString(); manifest.budget.sufficient = balance >= BigInt(manifest.budget.totalRequiredWei);
    save(); return env;
  }
  const fees = await provider.getFeeData();
  const maxFee = process.env.SEPOLIA_MAX_FEE_PER_GAS_WEI ? BigInt(process.env.SEPOLIA_MAX_FEE_PER_GAS_WEI) : fees.maxFeePerGas ?? parseUnits('2', 'gwei');
  const priority = fees.maxPriorityFeePerGas ?? parseUnits('1', 'gwei');
  if (maxFee <= 0n) throw new Error('Deployment fee ceiling must be positive');
  let gas = 0n, placeholders = false;
  for (const item of await deploymentRequests(env)) {
    try { gas += await provider.estimateGas({ from: deployer.address, ...item.request }); }
    catch { gas += item.fallbackGas; placeholders = true; }
  }
  const setupGas = 3_000_000n;
  const roleFundingByRoleWei = { lp: (60_000_000n * maxFee).toString(), bot: (40_000_000n * maxFee).toString() };
  const roleFundingWei = BigInt(roleFundingByRoleWei.lp) + BigInt(roleFundingByRoleWei.bot);
  const totalRequiredWei = ((gas * 120n / 100n + setupGas) * maxFee + roleFundingWei);
  const balance = await provider.getBalance(deployer.address);
  // These placeholders only size an unsigned preview. Network repricing can
  // invalidate them: each transaction still requires its own RPC estimate,
  // and an explicit refresh recomputes dependent Vault costs after deployment.
  manifest.budget = { source: placeholders ? 'rpc-with-unverified-dependent-contract-placeholders' : 'rpc-estimate', deploymentGas: gas.toString(), setupGas: setupGas.toString(),
    maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: (priority > maxFee ? maxFee : priority).toString(), roleFundingWei: roleFundingWei.toString(), roleFundingByRoleWei, totalRequiredWei: totalRequiredWei.toString(), balanceWei: balance.toString(), sufficient: balance >= totalRequiredWei };
  const cap = process.env.SEPOLIA_MAX_TOTAL_FEE_WEI;
  if (cap && totalRequiredWei > BigInt(cap)) throw new Error('Prepared deployment exceeds SEPOLIA_MAX_TOTAL_FEE_WEI; no transaction was broadcast');
  save();
  writePrivateJson(join(settings.directory, 'runtime.json'), { rpcUrl: settings.rpcUrl, artifactsDir: settings.artifactsDir, confirmations: manifest.network.confirmations });
  return env;
}
export async function deploymentRequests(env: Pick<DeploymentEnvironment, 'manifest' | 'settings'>): Promise<{ id: string; address: string; request: TransactionRequest; fallbackGas: bigint }[]> {
  const { manifest: m, settings } = env;
  const token = artifact(settings.artifactsDir, 'DemoToken'), verifier = artifact(settings.artifactsDir, 'Groth16Verifier'), vault = artifact(settings.artifactsDir, 'ZkRubaVault');
  const poseidon = readJson<{ abi: any; bytecode: string }>(join(settings.artifactsDir, 'poseidon2.json'));
  const requests = [];
  for (const symbol of Object.keys(ASSETS) as (keyof typeof ASSETS)[]) requests.push({ id: `deploy:token:${symbol}`, address: m.tokens[symbol].address,
    request: await new ContractFactory(token.abi, token.bytecode).getDeployTransaction(ASSETS[symbol].name, symbol, ASSETS[symbol].decimals, m.roles.admin, m.tokens[symbol].faucetAmount), fallbackGas: 1_500_000n });
  requests.push({ id: 'deploy:verifier', address: m.shared.verifier, request: await new ContractFactory(verifier.abi, verifier.bytecode).getDeployTransaction(), fallbackGas: 3_000_000n });
  requests.push({ id: 'deploy:poseidon', address: m.shared.poseidon, request: await new ContractFactory(poseidon.abi, poseidon.bytecode).getDeployTransaction(), fallbackGas: 6_000_000n });
  for (const definition of POOLS) { const pool = m.pools[definition.id]; requests.push({ id: `deploy:vault:${definition.id}`, address: pool.vault,
    request: await new ContractFactory(vault.abi, vault.bytecode).getDeployTransaction(m.tokens[definition.assets[0]].address, m.tokens[definition.assets[1]].address, m.roles.admin, m.roles.prover, m.shared.verifier, m.shared.poseidon, pool.poolKeyCommit), fallbackGas: 15_000_000n }); }
  return requests;
}
export async function deployPreparedMarkets(env: DeploymentEnvironment, log: (message: string) => void = console.log) {
  const { manifest, provider, settings, keys } = env;
  const balance = await provider.getBalance(env.deployer.address);
  // The conservative first-run requirement includes gas funding for both economic owners.
  if (!Object.keys(manifest.steps).length && balance < BigInt(manifest.budget!.totalRequiredWei)) throw new InsufficientDeploymentFunds(`Prepared Sepolia deployment needs up to ${manifest.budget!.totalRequiredWei} wei; balance is ${balance}. Fund ${env.deployer.address} and rerun the same command.`);
  const signer = new Wallet(env.deployer.privateKey, provider);
  const transactions = new DeploymentTransactions(provider, settings.directory, manifest, env.save);
  for (const item of await deploymentRequests(env)) {
    log(`Подготавливаю ${item.id}`);
    const receipt = await transactions.run(item.id, signer, item.request, undefined, item.address);
    if (getAddress(receipt.contractAddress!) !== getAddress(item.address)) throw new Error('Prepared CREATE address differs from actual deployment; refusing another deployment');
    const poolId = item.id.replace('deploy:vault:', '');
    if (manifest.pools[poolId]) manifest.pools[poolId].deploymentBlock = receipt.blockNumber;
    env.save();
  }
  for (const [address, expected] of [[manifest.shared.verifier, manifest.artifacts.verifierRuntimeCodeHash], [manifest.shared.poseidon, manifest.artifacts.poseidonRuntimeCodeHash]]) {
    if (keccak256(await provider.getCode(address)) !== expected) throw new Error('Shared verifier/Poseidon code differs from the unchanged pinned artifacts');
  }
  manifest.status = 'deployed'; env.save();
  const markets = await createMarketRuntimes(manifest, keys, settings);
  try { await bootstrapMarkets(markets, manifest, keys, settings, transactions, signer, log); return markets; }
  catch (error) { await closeMarketRuntimes(markets); throw error; }
}
export async function runSepoliaDeploy(log: (message: string) => void = console.log) {
  const settings = loadSepoliaSettings(); const provider = new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1 });
  let markets: Awaited<ReturnType<typeof createMarketRuntimes>> = [];
  let release: (() => void) | undefined;
  try {
    release = acquireDeploymentLock(settings.directory);
    const deployer = loadDeployer(settings.directory), keys = loadPrivateMarketKeys(settings.directory, SEPOLIA_CHAIN_ID, !existsSync(join(settings.directory, 'manifest.json')));
    const env = await prepareDeployment(settings, provider, deployer, keys);
    log(`Sepolia deployer: ${deployer.address}. Plan: ${join(settings.directory, 'manifest.json')}. Budget ceiling ${env.manifest.budget!.totalRequiredWei} wei.`);
    markets = await deployPreparedMarkets(env, log);
    log('Три Sepolia Vault развёрнуты и обеспечены подтверждённой ликвидностью.');
    return env.manifest;
  } catch (error) {
    if (error instanceof InsufficientDeploymentFunds) { log(error.message); return undefined; }
    throw error;
  } finally { await closeMarketRuntimes(markets); provider.destroy(); release?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSepoliaDeploy().catch(() => { console.error('Sepolia deployment failed; inspect the resumable local manifest and retry without replacing keys or databases.'); process.exitCode = 1; });
