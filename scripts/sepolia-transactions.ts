import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { Transaction, Wallet, getAddress, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import type { JsonRpcProvider, TransactionRequest, TransactionReceipt } from 'ethers';
import { canonicalJson } from '../server/auth.ts';
import { readJson, writePrivateJson } from './sepolia-config.ts';
import type { DeploymentManifest, DeploymentStep } from './sepolia-config.ts';

interface SignedStep { intentHash: string; raw: string; hash: string; sender: string; nonce: number; preparedBlock: number }
interface PrivateTransactionJournal { version: 1; chainId: string; steps: Record<string, SignedStep> }
export class DeploymentPending extends Error {}
export class InsufficientDeploymentFunds extends Error {}
export class SerialTransactionQueue {
  private queue: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> { const job = this.queue.then(operation); this.queue = job.catch(() => undefined); return job; }
  async drain() { await this.queue; }
}
/** Signed payload is durably recorded before any network broadcast; only the same payload can resume. */
export class DeploymentTransactions {
  readonly privatePath: string;
  readonly queue = new SerialTransactionQueue();
  private journal: PrivateTransactionJournal;
  constructor(readonly provider: JsonRpcProvider, readonly directory: string, readonly manifest: DeploymentManifest, readonly saveManifest: () => void) {
    this.privatePath = join(directory, 'transactions.json');
    this.journal = existsSync(this.privatePath) ? readJson(this.privatePath) : { version: 1, chainId: manifest.network.chainId, steps: {} };
    if (this.journal.version !== 1 || this.journal.chainId !== manifest.network.chainId) throw new Error('Signed deployment journal belongs to another network');
  }
  async run(id: string, signer: Wallet, request: TransactionRequest, gasLimit?: bigint, expectedCreateAddress?: string): Promise<TransactionReceipt> {
    return this.queue.run(() => this.execute(id, signer, request, gasLimit, expectedCreateAddress));
  }
  private async execute(id: string, signer: Wallet, request: TransactionRequest, gasLimit?: bigint, expectedCreateAddress?: string): Promise<TransactionReceipt> {
    if ((await this.provider.getNetwork()).chainId.toString() !== this.manifest.network.chainId) throw new Error('RPC network changed before deployment');
    const to = request.to ? getAddress(String(request.to)) : null;
    const data = String(request.data ?? '0x'), value = BigInt(request.value ?? 0n);
    const sender = signer.address;
    const intentHash = keccak256(toUtf8Bytes(canonicalJson({ sender, to, data, value: value.toString() })));
    let saved = this.journal.steps[id];
    if (saved && saved.intentHash !== intentHash) throw new Error(`Deployment step ${id} conflicts with its original immutable intent`);
    if (!saved && this.manifest.steps[id]) throw new Error(`Missing private signed payload for deployment step ${id}; restore its journal`);
    if (!saved) {
      const nonce = await this.provider.getTransactionCount(sender, 'pending');
      if (to === null && expectedCreateAddress && getCreateAddress({ from: sender, nonce }) !== getAddress(expectedCreateAddress)) throw new Error('CREATE nonce conflict: prepared contract address would change; no transaction was signed or broadcast');
      const fees = await this.provider.getFeeData();
      const maxFeePerGas = BigInt(this.manifest.budget?.maxFeePerGas ?? fees.maxFeePerGas ?? 2_000_000_000n);
      const maxPriorityFeePerGas = BigInt(this.manifest.budget?.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas ?? 1_000_000_000n);
      const estimated = gasLimit ?? ((await this.provider.estimateGas({ from: sender, to, data, value, maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas })) * 120n / 100n);
      if (sender === this.manifest.roles?.deployer && this.manifest.budget) {
        const committed = Object.values(this.journal.steps).filter((step) => step.sender === sender).reduce((sum, step) => {
          const tx = Transaction.from(step.raw); return sum + tx.value + tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);
        }, 0n);
        const configured = process.env.SEPOLIA_MAX_TOTAL_FEE_WEI;
        const cap = configured && BigInt(configured) < BigInt(this.manifest.budget.totalRequiredWei) ? BigInt(configured) : BigInt(this.manifest.budget.totalRequiredWei);
        if (committed + value + estimated * maxFeePerGas > cap) throw new Error('Next deployment step exceeds the prepared cumulative funding ceiling');
      }
      if (await this.provider.getBalance(sender) < value + estimated * maxFeePerGas) throw new InsufficientDeploymentFunds(`Insufficient test ETH for role ${sender}; deployment remains resumable`);
      const raw = await signer.signTransaction({ chainId: BigInt(this.manifest.network.chainId), nonce, to, data, value,
        gasLimit: estimated, type: 2, maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas });
      saved = { intentHash, raw, hash: keccak256(raw), sender, nonce, preparedBlock: await this.provider.getBlockNumber() };
      this.journal.steps[id] = saved;
      writePrivateJson(this.privatePath, this.journal);
      this.manifest.steps[id] = { status: 'signed', sender, nonce: nonce.toString(), intentHash, transactionHash: saved.hash, to, value: value.toString(),
        ...(to === null ? { predictedAddress: getCreateAddress({ from: sender, nonce }) } : {}) };
      this.saveManifest();
    }
    const decoded = Transaction.from(saved.raw);
    if (decoded.hash !== saved.hash || decoded.from !== sender || decoded.from !== saved.sender
      || decoded.chainId.toString() !== this.manifest.network.chainId || decoded.nonce !== saved.nonce
      || (decoded.to ? getAddress(decoded.to) : null) !== to || decoded.data.toLowerCase() !== data.toLowerCase() || decoded.value !== value) throw new Error('Signed deployment journal failed semantic integrity checks');
    if (to === null && expectedCreateAddress && getCreateAddress({ from: sender, nonce: saved.nonce }) !== getAddress(expectedCreateAddress)) throw new Error('Stored CREATE transaction differs from its prepared contract address');
    const restoredStep: DeploymentStep = { status: 'signed', sender, nonce: saved.nonce.toString(), intentHash, transactionHash: saved.hash, to, value: value.toString(),
      ...(to === null ? { predictedAddress: getCreateAddress({ from: sender, nonce: saved.nonce }) } : {}) };
    const recorded = this.manifest.steps[id];
    if (!recorded) {
      // A crash may occur between the private signed-payload write and the
      // public manifest write. Rebuild only from the fully checked original tx.
      this.manifest.steps[id] = restoredStep; this.saveManifest();
    } else if (recorded.intentHash !== intentHash || recorded.transactionHash !== saved.hash || recorded.sender !== sender
      || recorded.nonce !== saved.nonce.toString() || recorded.to !== to || recorded.value !== value.toString()
      || recorded.predictedAddress !== restoredStep.predictedAddress) throw new Error('Public deployment step differs from its immutable signed payload');
    let receipt = await this.provider.getTransactionReceipt(saved.hash);
    if (!receipt) {
      const known = await this.provider.getTransaction(saved.hash);
      if (!known) {
        if (await this.provider.getTransactionCount(sender, 'pending') > saved.nonce) throw new Error(`Pending nonce conflict for immutable deployment step ${id}; no automatic replacement is allowed`);
        if (await this.provider.getTransactionCount(sender, 'latest') > saved.nonce) throw new Error(`Nonce conflict for immutable deployment step ${id}; reconcile its original transaction before resuming`);
        try { await this.provider.broadcastTransaction(saved.raw); }
        catch (error) {
          if (!await this.provider.getTransaction(saved.hash) && !await this.provider.getTransactionReceipt(saved.hash)) throw new DeploymentPending(`Broadcast result unknown for ${id}; rerun to reconcile the same signed transaction`);
        }
      }
    }
    const timeout = Date.now() + 180_000;
    for (;;) {
      receipt = await this.provider.getTransactionReceipt(saved.hash);
      const head = receipt ? await this.provider.getBlock('latest') : null;
      if (receipt && head && head.number - receipt.blockNumber >= this.manifest.network.confirmations) break;
      if (Date.now() >= timeout) throw new DeploymentPending(`Transaction ${saved.hash} is awaiting the configured confirmation depth; resume the same signed transaction`);
      await delay(this.manifest.network.chainId === '31337' ? 100 : 1000);
    }
    if (receipt.status !== 1) throw new Error(`Deployment step ${id} reverted; no automatic replacement is allowed`);
    if ((await this.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('Deployment receipt is no longer canonical');
    const step = this.manifest.steps[id];
    if (step.blockHash && step.blockHash !== receipt.blockHash) throw new Error('Previously confirmed deployment step changed after a reorganization');
    Object.assign(step, { status: 'confirmed', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString() });
    if (receipt.contractAddress) {
      if (getAddress(receipt.contractAddress) !== getAddress(step.predictedAddress!)) throw new Error('Created contract address differs from the signed nonce plan');
      const code = await this.provider.getCode(receipt.contractAddress);
      if (code === '0x') throw new Error('Confirmed deployment has no contract code');
      const codeHash = keccak256(code);
      if (step.codeHash && step.codeHash !== codeHash) throw new Error('Deployed contract code differs from its recorded identity');
      step.codeHash = codeHash;
    }
    this.saveManifest();
    return receipt;
  }
}
