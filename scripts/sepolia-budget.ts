import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Interface, JsonRpcProvider, Transaction, getAddress, getCreateAddress, keccak256, toQuantity, toUtf8Bytes } from 'ethers';
import type { TransactionRequest } from 'ethers';
import { canonicalJson } from '../server/auth.ts';
import { artifactPins, encode, loadSepoliaSettings, POOLS, readJson, SEPOLIA_CHAIN_ID, sha256, writePrivateJson } from './sepolia-config.ts';
import type { DeploymentManifest, SepoliaSettings } from './sepolia-config.ts';
import { deploymentRequests } from './sepolia-deploy.ts';
import { acquireDeploymentLock } from './sepolia-lock.ts';

interface SavedTransaction { intentHash: string; raw: string; hash: string; sender: string; nonce: number }
interface Journal { version: number; chainId: string; steps: Record<string, SavedTransaction> }
export interface BudgetRefreshProposal {
  version: 1; deploymentId: string; chainId: string; deployer: string;
  manifestDigest: string; journalDigest: string; proposalDigest: string;
  blockNumber: number; blockHash: string; nonce: number;
  previousCeilingWei: string; ceilingWei: string; configuredCapWei: string;
  maxFeePerGas: string; maxPriorityFeePerGas: string;
  roleFundingWei: string; roleFundingByRoleWei?: { lp: string; bot: string };
  committedUpperBoundWei: string; remainingUpperBoundWei: string;
  carriedSetupReserveGas: string; balanceWei: string; withinCap: boolean; sufficient: boolean;
  estimates: { id: string; gas: string; gasLimit: string; valueWei: string; source: 'rpc-at-block' }[];
  unestimatedSetupIds: string[];
}
/** --out may target a shared directory; only the new file's permissions change. */
export function saveBudgetProposal(path: string, proposal: BudgetRefreshProposal): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.budget-proposal-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, encode(proposal), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
const digest = (value: unknown) => sha256(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
function loadInputs(settings: SepoliaSettings) {
  const manifestPath = join(settings.directory, 'manifest.json'), journalPath = join(settings.directory, 'transactions.json');
  const manifestBytes = readFileSync(manifestPath), journalBytes = existsSync(journalPath) ? readFileSync(journalPath) : Buffer.from('');
  return { manifest: JSON.parse(manifestBytes.toString()) as DeploymentManifest,
    journal: journalBytes.length ? JSON.parse(journalBytes.toString()) as Journal : { version: 1, chainId: SEPOLIA_CHAIN_ID.toString(), steps: {} },
    manifestDigest: sha256(manifestBytes), journalDigest: sha256(journalBytes) };
}
function currentCap(env: NodeJS.ProcessEnv): bigint {
  if (!env.SEPOLIA_MAX_TOTAL_FEE_WEI || !/^[1-9][0-9]*$/.test(env.SEPOLIA_MAX_TOTAL_FEE_WEI)) throw new Error('Budget refresh requires an explicit positive SEPOLIA_MAX_TOTAL_FEE_WEI');
  return BigInt(env.SEPOLIA_MAX_TOTAL_FEE_WEI);
}
function setupRequests(manifest: DeploymentManifest) {
  const result: { id: string; request: TransactionRequest; needsVault?: string }[] = [];
  const mint = new Interface(['function mint(address,uint256)']), whitelist = new Interface(['function setWhitelist(address,bool)']);
  for (const role of ['lp', 'bot'] as const) {
    const value = manifest.budget!.roleFundingByRoleWei?.[role] !== undefined ? BigInt(manifest.budget!.roleFundingByRoleWei[role]) : BigInt(manifest.budget!.roleFundingWei) / 2n;
    if (value) result.push({ id: `fund:${manifest.roles[role]}`, request: { to: manifest.roles[role], value } });
  }
  for (const definition of POOLS) {
    const pool = manifest.pools[definition.id];
    const owners = [...new Set([manifest.roles.lp, manifest.roles.bot, ...(manifest.roles.authorizedTestWallets ?? []), ...(manifest.roles.testWallet ? [manifest.roles.testWallet] : [])])];
    for (const owner of owners) result.push({ id: `${pool.id}:whitelist:${owner}`, needsVault: pool.vault, request: { to: pool.vault, data: whitelist.encodeFunctionData('setWhitelist', [owner, true]) } });
    for (const role of ['lp', 'bot'] as const) definition.assets.forEach((symbol, index) => result.push({ id: `${pool.id}:mint:${role}:${symbol}`,
      request: { to: manifest.tokens[symbol].address, data: mint.encodeFunctionData('mint', [manifest.roles[role], (role === 'lp' ? pool.seedAmounts : pool.botAmounts)[index]]) } }));
  }
  return result;
}

/** Read-only proposal. Missing dependencies never fall back to another network's gas schedule. */
export async function previewSepoliaBudget(settings: SepoliaSettings, provider: JsonRpcProvider, env: NodeJS.ProcessEnv = process.env): Promise<BudgetRefreshProposal> {
  const inputs = loadInputs(settings), { manifest: m, journal } = inputs, budget = m.budget;
  const cap = currentCap(env);
  if (m.schemaVersion !== 1 || m.network.chainId !== SEPOLIA_CHAIN_ID.toString() || (await provider.getNetwork()).chainId !== SEPOLIA_CHAIN_ID || BigInt(await provider.send('eth_chainId', [])) !== SEPOLIA_CHAIN_ID) throw new Error('Budget refresh is restricted to the pinned Sepolia deployment');
  if (!budget || journal.version !== 1 || journal.chainId !== m.network.chainId) throw new Error('Missing prepared budget or inconsistent signed journal');
  if (canonicalJson(m.artifacts) !== canonicalJson(artifactPins(settings.artifactsDir))) throw new Error('Pinned deployment artifacts changed');
  const identity = m.network.identityCheckpoint ?? (m.network.genesisHash ? { blockNumber: 0, blockHash: m.network.genesisHash } : null);
  if (!identity || (await provider.getBlock(identity.blockNumber))?.hash !== identity.blockHash) throw new Error('Deployment network identity checkpoint is unavailable or changed');
  const block = await provider.getBlock('latest');
  if (!block?.hash) throw new Error('Current Sepolia block unavailable');
  const maxFee = BigInt(budget.maxFeePerGas), priority = BigInt(budget.maxPriorityFeePerGas);
  if (maxFee <= 0n || priority < 0n || priority > maxFee || BigInt(budget.setupGas) < 0n) throw new Error('Invalid immutable fee/reserve settings');
  if (env.SEPOLIA_MAX_FEE_PER_GAS_WEI && maxFee > BigInt(env.SEPOLIA_MAX_FEE_PER_GAS_WEI)) throw new Error('Immutable plan fee exceeds the current configured fee cap');
  if (block.baseFeePerGas != null && block.baseFeePerGas > maxFee) throw new Error('Current base fee exceeds the immutable fee ceiling; a budget increase cannot change signed fees');
  const deployer = getAddress(m.roles.deployer), nonce = await provider.getTransactionCount(deployer, 'latest');
  if (await provider.getTransactionCount(deployer, 'pending') !== nonce) throw new Error('Deployment has a pending nonce; reconcile it before budget refresh');
  const deployments = await deploymentRequests({ settings, manifest: m });
  const allExpected = new Map([...deployments, ...setupRequests(m)].map((item) => [item.id, item]));
  let committed = 0n;
  for (const [id, saved] of Object.entries(journal.steps)) {
    const tx = Transaction.from(saved.raw), recorded = m.steps[id];
    const intentHash = keccak256(toUtf8Bytes(canonicalJson({ sender: saved.sender, to: tx.to, data: tx.data, value: tx.value.toString() })));
    if (!tx.hash || tx.hash !== saved.hash || tx.from !== saved.sender || tx.nonce !== saved.nonce || tx.chainId.toString() !== m.network.chainId || saved.intentHash !== intentHash) throw new Error('Signed journal failed immutable transaction integrity checks');
    if (!recorded || recorded.status !== 'confirmed' || recorded.transactionHash !== saved.hash || recorded.intentHash !== intentHash || recorded.sender !== saved.sender || recorded.nonce !== saved.nonce.toString() || recorded.to !== tx.to || recorded.value !== tx.value.toString()) throw new Error('Public deployment journal differs from the original signed payload; resume reconciliation first');
    const expected = allExpected.get(id);
    if (expected && (getAddress(tx.from!) !== deployer || tx.to !== (expected.request.to ? getAddress(String(expected.request.to)) : null) || tx.data.toLowerCase() !== String(expected.request.data ?? '0x').toLowerCase() || tx.value !== BigInt(expected.request.value ?? 0n))) throw new Error('Signed transaction differs from its original deployment/setup intent');
    if (expected && 'address' in expected && getCreateAddress({ from: deployer, nonce: tx.nonce }) !== expected.address) throw new Error('Signed CREATE differs from its predicted address');
    const receipt = await provider.getTransactionReceipt(saved.hash);
    if (!receipt || receipt.status !== 1 || block.number - receipt.blockNumber < m.network.confirmations || (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash || (recorded.blockHash && recorded.blockHash !== receipt.blockHash)) throw new Error('Every signed transaction must have a canonical confirmed successful receipt before refreshing the budget');
    if (expected && 'address' in expected) {
      const code = await provider.getCode(expected.address, block.number);
      if (recorded.predictedAddress !== expected.address || !receipt.contractAddress || getAddress(receipt.contractAddress) !== expected.address || !recorded.codeHash || code === '0x' || keccak256(code) !== recorded.codeHash) throw new Error('Confirmed CREATE code/address differs from its pinned deployment identity');
    }
    if (getAddress(saved.sender) === deployer) committed += tx.value + tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);
  }
  if (Object.keys(m.steps).some((id) => !journal.steps[id])) throw new Error('Missing private payload for a public deployment step');
  for (const [address, hash] of [[m.shared.verifier, m.artifacts.verifierRuntimeCodeHash], [m.shared.poseidon, m.artifacts.poseidonRuntimeCodeHash]]) {
    const code = await provider.getCode(address, block.number);
    if (code === '0x' || keccak256(code) !== hash) throw new Error('Deploy and confirm the pinned verifier/Poseidon before refreshing dependent Vault estimates');
  }
  const estimates: BudgetRefreshProposal['estimates'] = [], unestimatedSetupIds: string[] = [];
  let futureNonce = nonce, remaining = BigInt(budget.setupGas) * maxFee;
  for (const item of [...deployments, ...setupRequests(m)]) {
    if (journal.steps[item.id]) continue;
    if ('address' in item) {
      if (getCreateAddress({ from: deployer, nonce: futureNonce++ }) !== item.address) throw new Error('Unoccupied CREATE nonce no longer matches the prepared address');
      if (await provider.getCode(item.address, block.number) !== '0x') throw new Error('Unsigned deployment address already contains code');
    }
    if ('needsVault' in item && item.needsVault && await provider.getCode(item.needsVault, block.number) === '0x') { unestimatedSetupIds.push(item.id); continue; }
    const request = { from: deployer, ...(item.request.to ? { to: String(item.request.to) } : {}), data: String(item.request.data ?? '0x'), value: toQuantity(BigInt(item.request.value ?? 0n)),
      maxFeePerGas: toQuantity(maxFee), maxPriorityFeePerGas: toQuantity(priority) };
    const gas = BigInt(await provider.send('eth_estimateGas', [request, toQuantity(block.number)]));
    if (gas <= 0n) throw new Error('RPC returned a non-positive gas estimate');
    const gasLimit = (gas * 120n + 99n) / 100n, value = BigInt(item.request.value ?? 0n);
    estimates.push({ id: item.id, gas: gas.toString(), gasLimit: gasLimit.toString(), valueWei: value.toString(), source: 'rpc-at-block' });
    remaining += value + gasLimit * maxFee;
  }
  if (unestimatedSetupIds.length && BigInt(budget.setupGas) === 0n) throw new Error('Missing explicit carried reserve for setup calls whose Vault is not deployed');
  const required = committed + remaining, ceiling = required > BigInt(budget.totalRequiredWei) ? required : BigInt(budget.totalRequiredWei);
  const balance = await provider.getBalance(deployer, block.number);
  if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error('Budget estimate block changed; obtain a fresh preview');
  const after = loadInputs(settings);
  if (after.manifestDigest !== inputs.manifestDigest || after.journalDigest !== inputs.journalDigest) throw new Error('Deployment changed during budget preview; stop it and retry');
  const proposal: Omit<BudgetRefreshProposal, 'proposalDigest'> = { version: 1, deploymentId: m.deploymentId, chainId: m.network.chainId, deployer,
    manifestDigest: inputs.manifestDigest, journalDigest: inputs.journalDigest, blockNumber: block.number, blockHash: block.hash, nonce,
    previousCeilingWei: budget.totalRequiredWei, ceilingWei: ceiling.toString(), configuredCapWei: cap.toString(),
    maxFeePerGas: budget.maxFeePerGas, maxPriorityFeePerGas: budget.maxPriorityFeePerGas, roleFundingWei: budget.roleFundingWei,
    ...(budget.roleFundingByRoleWei ? { roleFundingByRoleWei: { ...budget.roleFundingByRoleWei } } : {}),
    committedUpperBoundWei: committed.toString(), remainingUpperBoundWei: remaining.toString(), carriedSetupReserveGas: budget.setupGas,
    balanceWei: balance.toString(), withinCap: ceiling <= cap, sufficient: balance >= remaining, estimates, unestimatedSetupIds };
  return { ...proposal, proposalDigest: digest(proposal) };
}

/** Explicit local-only revision; it neither signs nor sends a transaction. */
export async function applySepoliaBudget(settings: SepoliaSettings, provider: JsonRpcProvider, proposal: BudgetRefreshProposal, env: NodeJS.ProcessEnv = process.env) {
  const release = acquireDeploymentLock(settings.directory);
  try {
    const { proposalDigest, ...unsigned } = proposal;
    if (digest(unsigned) !== proposalDigest) throw new Error('Budget proposal digest differs from its contents');
    const inputs = loadInputs(settings);
    if (inputs.manifestDigest !== proposal.manifestDigest || inputs.journalDigest !== proposal.journalDigest) throw new Error('Deployment changed after preview; obtain a fresh budget proposal');
    if ((await provider.getBlock(proposal.blockNumber))?.hash !== proposal.blockHash) throw new Error('Budget preview block is no longer canonical');
    const latest = await provider.getBlock('latest');
    if (!latest || latest.number < proposal.blockNumber || latest.number - proposal.blockNumber > 32) throw new Error('Budget proposal is stale; obtain a fresh preview');
    const fresh = await previewSepoliaBudget(settings, provider, env);
    if (!fresh.withinCap || !fresh.sufficient) throw new Error('Refreshed budget exceeds the explicit total cap or available remaining balance');
    if (BigInt(fresh.ceilingWei) > BigInt(proposal.ceilingWei)) throw new Error('Current estimates exceed the reviewed proposal; obtain a fresh preview');
    if (BigInt(proposal.ceilingWei) > currentCap(env)) throw new Error('Reviewed proposal exceeds the current configured total cap');
    // No await follows the final digest check and atomic write. The shared CLI
    // lock excludes a deployment process using stale in-memory manifest data.
    const final = loadInputs(settings);
    if (final.manifestDigest !== inputs.manifestDigest || final.journalDigest !== inputs.journalDigest) throw new Error('Deployment changed during budget validation');
    const budget = final.manifest.budget!;
    budget.revisions = [...(budget.revisions ?? []), { proposalDigest, blockNumber: fresh.blockNumber, blockHash: fresh.blockHash,
      previousCeilingWei: budget.totalRequiredWei, ceilingWei: proposal.ceilingWei, committedUpperBoundWei: fresh.committedUpperBoundWei,
      remainingUpperBoundWei: fresh.remainingUpperBoundWei, carriedSetupReserveGas: budget.setupGas }];
    budget.source = 'remaining-rpc-estimates-plus-carried-setup-reserve';
    budget.totalRequiredWei = proposal.ceilingWei; budget.balanceWei = fresh.balanceWei; budget.sufficient = fresh.sufficient;
    writePrivateJson(join(settings.directory, 'manifest.json'), final.manifest);
    return final.manifest;
  } finally { release(); }
}

export async function runSepoliaBudget(log: (message: string) => void = console.log) {
  const settings = loadSepoliaSettings(), provider = new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    const apply = process.argv.indexOf('--apply');
    if (apply >= 0) {
      const path = process.argv[apply + 1]; if (!path) throw new Error('--apply requires the reviewed proposal JSON path');
      const manifest = await applySepoliaBudget(settings, provider, readJson<BudgetRefreshProposal>(path));
      log(`Budget revision saved: ${manifest.budget!.totalRequiredWei} wei. Signed transactions, fees and role funding were preserved; no transaction was broadcast.`);
      return manifest;
    }
    const proposal = await previewSepoliaBudget(settings, provider);
    const output = process.argv.indexOf('--out');
    if (output >= 0) { const path = process.argv[output + 1]; if (!path) throw new Error('--out requires a proposal JSON path'); saveBudgetProposal(path, proposal); }
    log(JSON.stringify(proposal, null, 2)); return proposal;
  } finally { provider.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSepoliaBudget().catch((error) => { console.error(error instanceof Error ? error.message : 'Budget refresh failed'); process.exitCode = 1; });
