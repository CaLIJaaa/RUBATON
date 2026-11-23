import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { canonicalJson } from '../../server/auth.ts';
import { loadPrivateMarketKeys, readJson, writePrivateJson } from '../sepolia-config.ts';
import { deploymentRequests, prepareDeployment } from '../sepolia-deploy.ts';
import { applySepoliaBudget, previewSepoliaBudget, saveBudgetProposal } from '../sepolia-budget.ts';
import type { BudgetRefreshProposal } from '../sepolia-budget.ts';
import { acquireDeploymentLock } from '../sepolia-lock.ts';

const blockHash = '0x' + '45'.repeat(32), cap = { SEPOLIA_MAX_TOTAL_FEE_WEI: '30000000000000000' };
test('proposal --out saves an atomic 0600 file without changing existing parent permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-budget-output-'));
  try {
    chmodSync(directory, 0o755);
    const path = join(directory, 'proposal.json');
    saveBudgetProposal(path, { version: 1 } as BudgetRefreshProposal);
    assert.equal(statSync(directory).mode & 0o777, 0o755);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    saveBudgetProposal(path, { version: 1, proposalDigest: 'new' } as BudgetRefreshProposal);
    assert.equal(statSync(directory).mode & 0o777, 0o755);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readJson<BudgetRefreshProposal>(path).proposalDigest, 'new');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-budget-'));
  const wallet = Wallet.createRandom(), keys = loadPrivateMarketKeys(directory, 11155111n, true);
  const settings = { directory, rpcUrl: 'https://example.invalid', artifactsDir: resolve('zk/artifacts'), port: 3001, confirmations: 1 };
  const receipts = new Map<string, any>(), codes = new Map<string, string>();
  let gas = 35_000_000n, head = 100, pending = 6, baseFee = 1n, balance = 60_000_000_000_000_000n, prepared = false;
  const provider = {
    async getNetwork() { return { chainId: 11155111n }; },
    async send(method: string, params: any[]) {
      if (method === 'eth_chainId') return '0xaa36a7';
      assert.equal(method, 'eth_estimateGas'); assert.equal(params[1], '0x64');
      const request = params[0];
      assert.equal(request.maxFeePerGas, '0x5f5e100'); assert.equal(request.maxPriorityFeePerGas, '0x1');
      return '0x' + (!request.to ? gas : request.data === '0x' ? 205_000n : 150_000n).toString(16);
    },
    async getBlock(tag: any) { return { number: tag === 'latest' ? head : Number(tag), hash: blockHash, baseFeePerGas: baseFee }; },
    async getTransactionCount(_address: string, tag: string) { return prepared ? tag === 'pending' ? pending : 6 : 0; },
    async getFeeData() { return { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1n }; },
    async estimateGas() { throw new Error('Unsigned dependencies not live yet'); },
    async getBalance() { return balance; }, async getCode(address: string) { return codes.get(address) ?? '0x'; },
    async getTransactionReceipt(hash: string) { return receipts.get(hash) ?? null; },
    async broadcastTransaction() { assert.fail('Budget refresh must never broadcast'); },
  };
  const env = await prepareDeployment(settings, provider as any, { address: wallet.address, privateKey: wallet.privateKey }, keys);
  prepared = true;
  const requests = await deploymentRequests(env), steps: Record<string, any> = {};
  for (const [nonce, request] of requests.slice(0, 6).entries()) {
    const raw = await wallet.signTransaction({ chainId: 11155111n, nonce, data: request.request.data, gasLimit: 6_000_000n, type: 2, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1n });
    const hash = keccak256(raw), intentHash = keccak256(toUtf8Bytes(canonicalJson({ sender: wallet.address, to: null, data: request.request.data, value: '0' })));
    steps[request.id] = { raw, hash, intentHash, sender: wallet.address, nonce, preparedBlock: 1 };
    env.manifest.steps[request.id] = { status: 'confirmed', sender: wallet.address, nonce: nonce.toString(), intentHash, transactionHash: hash, to: null, value: '0', predictedAddress: request.address, blockNumber: 1, blockHash, gasUsed: '4762500' };
    receipts.set(hash, { status: 1, blockNumber: 1, blockHash, contractAddress: request.address }); codes.set(request.address, '0x6000');
  }
  const verifier = readJson<any>('out/Groth16Verifier.sol/Groth16Verifier.json'), poseidon = readJson<any>('zk/artifacts/poseidon2.json');
  codes.set(env.manifest.shared.verifier, verifier.deployedBytecode.object);
  codes.set(env.manifest.shared.poseidon, poseidon.runtimeBytecode);
  requests.slice(0, 6).forEach((item) => { env.manifest.steps[item.id].codeHash = keccak256(codes.get(item.address)!); });
  env.save(); writePrivateJson(join(directory, 'transactions.json'), { version: 1, chainId: '11155111', steps });
  return { directory, settings, provider, env, receipts, steps, codes,
    setGas(value: bigint) { gas = value; }, setHead(value: number) { head = value; }, setPending(value: number) { pending = value; },
    setBaseFee(value: bigint) { baseFee = value; }, setBalance(value: bigint) { balance = value; },
    close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('Sepolia budget refresh estimates >16M total gas at the pinned RPC and preserves signed intents/fees/funding', async () => {
  const f = await fixture();
  try {
    const journalBefore = readFileSync(join(f.directory, 'transactions.json'), 'utf8');
    const manifestBefore = readFileSync(join(f.directory, 'manifest.json'), 'utf8');
    const proposal = await previewSepoliaBudget(f.settings, f.provider as any, cap);
    assert.equal(readFileSync(join(f.directory, 'manifest.json'), 'utf8'), manifestBefore, 'Preview is read-only');
    assert.equal(proposal.estimates.filter((item) => item.id.startsWith('deploy:vault:')).length, 3);
    assert.equal(proposal.estimates.find((item) => item.id.startsWith('deploy:vault:'))!.gasLimit, '42000000');
    assert.equal(proposal.estimates.find((item) => item.id.startsWith('fund:'))!.gasLimit, '246000');
    assert.equal(proposal.unestimatedSetupIds.length, 6);
    assert.ok(BigInt(proposal.ceilingWei) > BigInt(proposal.previousCeilingWei));
    assert.equal(proposal.withinCap, true); assert.equal(proposal.sufficient, true);
    assert.equal(JSON.stringify(proposal).includes(f.env.deployer.privateKey), false);
    assert.equal(JSON.stringify(proposal).includes(f.steps['deploy:token:RUBA'].raw), false);
    const updated = await applySepoliaBudget(f.settings, f.provider as any, proposal, cap);
    assert.equal(readFileSync(join(f.directory, 'transactions.json'), 'utf8'), journalBefore);
    assert.deepEqual(updated.steps, f.env.manifest.steps);
    assert.equal(updated.budget!.maxFeePerGas, f.env.manifest.budget!.maxFeePerGas);
    assert.equal(updated.budget!.maxPriorityFeePerGas, f.env.manifest.budget!.maxPriorityFeePerGas);
    assert.deepEqual(updated.budget!.roleFundingByRoleWei, { lp: '6000000000000000', bot: '4000000000000000' });
    assert.equal(updated.budget!.revisions!.length, 1);
    assert.equal(updated.budget!.totalRequiredWei, proposal.ceilingWei);
  } finally { f.close(); }
});

test('budget refresh cannot bypass cap, balance, fee, dependency or pending-transaction checks', async () => {
  const f = await fixture();
  try {
    const before = readFileSync(join(f.directory, 'manifest.json'), 'utf8');
    const insufficientCap = { SEPOLIA_MAX_TOTAL_FEE_WEI: '1000000000000000' };
    const proposal = await previewSepoliaBudget(f.settings, f.provider as any, insufficientCap);
    assert.equal(proposal.withinCap, false);
    await assert.rejects(applySepoliaBudget(f.settings, f.provider as any, proposal, insufficientCap), /total cap/);
    f.setBalance(1n);
    const unfunded = await previewSepoliaBudget(f.settings, f.provider as any, cap);
    assert.equal(unfunded.sufficient, false);
    await assert.rejects(applySepoliaBudget(f.settings, f.provider as any, unfunded, cap), /remaining balance/);
    f.setBalance(60_000_000_000_000_000n); f.setPending(7);
    await assert.rejects(previewSepoliaBudget(f.settings, f.provider as any, cap), /pending nonce/);
    f.setPending(6); f.setBaseFee(100_000_001n);
    await assert.rejects(previewSepoliaBudget(f.settings, f.provider as any, cap), /base fee/);
    f.setBaseFee(1n);
    const receipt = f.receipts.get(f.steps['deploy:token:RUBA'].hash);
    f.receipts.delete(f.steps['deploy:token:RUBA'].hash);
    await assert.rejects(previewSepoliaBudget(f.settings, f.provider as any, cap), /Every signed transaction/);
    f.receipts.set(f.steps['deploy:token:RUBA'].hash, receipt);
    f.codes.delete(f.env.manifest.shared.poseidon);
    await assert.rejects(previewSepoliaBudget(f.settings, f.provider as any, cap), /CREATE code\/address|verifier\/Poseidon/);
    assert.equal(readFileSync(join(f.directory, 'manifest.json'), 'utf8'), before);
  } finally { f.close(); }
});

test('budget revision rejects concurrent deployment, modified proposal/journal and increased estimates', async () => {
  const f = await fixture();
  try {
    const proposal = await previewSepoliaBudget(f.settings, f.provider as any, cap);
    const release = acquireDeploymentLock(f.directory);
    await assert.rejects(applySepoliaBudget(f.settings, f.provider as any, proposal, cap), /local lock/);
    release();
    await assert.rejects(applySepoliaBudget(f.settings, f.provider as any, { ...proposal, ceilingWei: '1' }, cap), /proposal digest/);
    f.setGas(36_000_000n);
    await assert.rejects(applySepoliaBudget(f.settings, f.provider as any, proposal, cap), /exceed the reviewed/);
    f.setGas(35_000_000n);
    const journal = readJson<any>(join(f.directory, 'transactions.json'));
    journal.steps['deploy:token:RUBA'].nonce++;
    writePrivateJson(join(f.directory, 'transactions.json'), journal);
    await assert.rejects(applySepoliaBudget(f.settings, f.provider as any, proposal, cap), /changed after preview/);
    await assert.rejects(previewSepoliaBudget(f.settings, f.provider as any, cap), /immutable transaction integrity/);
  } finally { f.close(); }
});
