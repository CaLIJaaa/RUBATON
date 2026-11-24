import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, keccak256, parseUnits, toUtf8Bytes, verifyTypedData } from 'ethers';
import { RubaApi } from '../api.ts';
import type { ActionRequest, Operation } from '../api.ts';
import { ACTION_TYPES, WITHDRAWAL_TYPES, actionDomain, operationHash, withdrawalDomain } from '../auth.ts';
import type { VaultChain } from '../chain.ts';
import type { ServerConfig } from '../config.ts';
import { RubaEngine } from '../engine.ts';
import { publicReceiptBatch } from '../disclosure.ts';
import { verifyMerkleProof } from '../merkle.ts';
import type { TradeReceipt, WithdrawalRecord } from '../types.ts';

/** Test double for chain observations. Vault execution itself is tested by Forge. */
class FakeChain {
  readonly engine: RubaEngine;
  readonly config: ServerConfig;
  readonly signer: Wallet;
  allowed = new Set<string>();
  paused = false;
  timestamp = 1_000_000n;
  events: Array<() => void> = [];
  publishedRoots: string[] = [];
  externalPublications = new Map<bigint, { transactionHash: string; confirmed: boolean }>();

  constructor(engine: RubaEngine, config: ServerConfig) {
    this.engine = engine; this.config = config; this.signer = new Wallet(config.operatorPrivateKey);
  }
  async sync() { for (const event of this.events.splice(0)) event(); }
  async latestTimestamp() { return this.timestamp; }
  async assertNewActivity(account: string) {
    if (!this.allowed.has(account)) throw new Error('Account is not whitelisted');
    if (this.paused) throw new Error('Market is paused');
  }
  async withdrawalContext(_token: string) { return { signerEpoch: 1n, deadline: this.timestamp + 900n }; }
  async signWithdrawal(record: WithdrawalRecord) {
    const withdrawal = {
      account: record.account, token: record.tokenAddress, amount: record.amount,
      nonce: record.nonce, deadline: record.deadline, signerEpoch: record.signerEpoch,
    };
    const signature = await this.signer.signTypedData(withdrawalDomain(this.config.chainId, this.config.vaultAddress), WITHDRAWAL_TYPES, withdrawal);
    return { withdrawal, signature };
  }
  async publishPendingBatches() {
    for (const batch of this.engine.listPendingBatches()) {
      const observed = this.externalPublications.get(batch.batchId);
      if (observed?.confirmed) {
        this.publishedRoots.push(batch.receiptsRoot);
        this.engine.markBatchPublished(batch.batchId, observed.transactionHash);
      }
    }
  }
  async getDisclosureBatch(batchId: bigint) {
    const batch = this.engine.getBatch(batchId);
    if (!batch) return;
    return {
      chainId: this.config.chainId, vault: this.config.vaultAddress,
      status: batch.publishedTxHash ? 'published' : 'pending',
      source: batch.publishedTxHash ? 'contract' : 'server',
      batch: publicReceiptBatch(batch),
    };
  }
  acceptExternalPublication(batchId: bigint) {
    assert.ok(this.engine.getBatch(batchId));
    assert.equal(this.externalPublications.has(batchId), false);
    const transactionHash = keccak256(toUtf8Bytes(`user-publication:${batchId}`));
    this.externalPublications.set(batchId, { transactionHash, confirmed: false });
    return transactionHash;
  }
  confirmExternalPublication(batchId: bigint) {
    const publication = this.externalPublications.get(batchId);
    assert.ok(publication);
    publication.confirmed = true;
  }
}

test('signed API flow conserves custody, batches receipts and reserves one-use withdrawals', async () => {
  const operator = Wallet.createRandom();
  const lp = Wallet.createRandom();
  const trader = Wallet.createRandom();
  const config: ServerConfig = {
    rpcUrl: 'http://127.0.0.1:1', chainId: 31337n,
    vaultAddress: Wallet.createRandom().address, rubaAddress: Wallet.createRandom().address, usdtAddress: Wallet.createRandom().address,
    operatorPrivateKey: operator.privateKey, deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n,
    dbPath: ':memory:', host: '127.0.0.1', port: 3001, syncIntervalMs: 2_000,
  };
  const engine = new RubaEngine(config);
  const chain = new FakeChain(engine, config);
  const api = new RubaApi(engine, chain as unknown as VaultChain, config);
  chain.allowed = new Set([lp.address, trader.address]);
  async function request(wallet: typeof trader, operation: Operation): Promise<ActionRequest> {
    const intent = {
      account: wallet.address, actionHash: operationHash(operation),
      nonce: engine.getActionNonce(wallet.address).toString(), deadline: (chain.timestamp + 600n).toString(),
    };
    return { intent, operation, signature: await wallet.signTypedData(actionDomain(config.chainId, config.vaultAddress), ACTION_TYPES, intent) };
  }
  async function act(wallet: typeof trader, operation: Operation) { return api.execute(await request(wallet, operation)); }
  try {
    chain.events.push(() => {
      engine.recordDeposit(1n, lp.address, 'RUBA', parseUnits('1000', 18));
      engine.recordDeposit(2n, lp.address, 'USDT', parseUnits('1000', 6));
      engine.recordDeposit(3n, trader.address, 'RUBA', parseUnits('100', 18));
      engine.recordDeposit(4n, trader.address, 'USDT', parseUnits('100', 6));
    });
    await api.sync();
    await act(lp, {
      kind: 'addLiquidity', rubaDesired: parseUnits('1000', 18).toString(), usdtDesired: parseUnits('1000', 6).toString(),
      rubaMin: '0', usdtMin: '0',
    });
    const unfundedLp = engine.accountSnapshot(trader.address);
    const lpAttempt = { kind: 'addLiquidity' as const, rubaDesired: parseUnits('101', 18).toString(), usdtDesired: parseUnits('101', 6).toString(), rubaMin: '0', usdtMin: '0' };
    const fundingNonce = engine.getActionNonce(trader.address);
    await assert.rejects(act(trader, lpAttempt), /Insufficient RUBA balance \(required 101000000000000000000, available 100000000000000000000\)/);
    assert.deepEqual(engine.accountSnapshot(trader.address), unfundedLp);
    assert.equal(engine.getActionNonce(trader.address), fundingNonce);
    const initial = engine.snapshot();
    const first = await request(trader, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    const firstReceipt = await api.execute(first) as TradeReceipt;
    assert.equal(firstReceipt.batchId, undefined);
    assert.equal(firstReceipt.proof, undefined);
    assert.deepEqual(engine.getBatchProgress(), { collected: 1, required: 4 });
    assert.equal(chain.publishedRoots.length, 0);
    await api.sync();
    assert.equal(chain.publishedRoots.length, 0);
    await assert.rejects(api.execute(first), /nonce/);
    for (const [tokenIn, amountIn] of [
      ['USDT', parseUnits('5', 6)], ['RUBA', parseUnits('10', 18)], ['USDT', parseUnits('5', 6)],
    ] as const) await act(trader, { kind: 'swap', tokenIn, amountIn: amountIn.toString(), minOut: '1' });
    assert.deepEqual(engine.snapshot().custody, initial.custody);
    assert.equal(engine.snapshot().totalSupply, initial.totalSupply);
    assert.equal(chain.publishedRoots.length, 0);
    assert.equal(engine.listPendingBatches().length, 1);
    await api.sync();
    assert.equal(chain.publishedRoots.length, 0, 'the worker observes publication state without spending operator gas');
    assert.equal(engine.listPendingBatches().length, 1);
    const userTransactionHash = chain.acceptExternalPublication(1n);
    await api.sync();
    assert.equal(chain.publishedRoots.length, 0, 'submission alone does not confirm the user publication');
    chain.confirmExternalPublication(1n);
    await api.sync();
    assert.equal(chain.publishedRoots.length, 1);
    const receipt = await act(trader, { kind: 'receipt', tradeId: firstReceipt.tradeId.toString() }) as TradeReceipt & { publication: { status: string; transactionHash: string } };
    assert.deepEqual(receipt.publication, { status: 'published', transactionHash: userTransactionHash });
    assert.equal(verifyMerkleProof(receipt.leaf, receipt.proof!, chain.publishedRoots[0]), true);
    await api.sync();
    assert.equal(chain.publishedRoots.length, 1, 'reconciliation must not duplicate a confirmed batch');
    const lpNonce = engine.getActionNonce(lp.address);
    const missingReceiptMessage = 'Квитанция не найдена для подключённого кошелька в выбранном пуле. Проверьте номер своей сделки и выбранную пару.';
    for (const kind of ['receipt', 'disclosure'] as const) {
      for (const tradeId of [receipt.tradeId.toString(), '999999']) {
        await assert.rejects(act(lp, { kind, tradeId }), (error: unknown) => {
          assert.equal((error as { status?: number }).status, 404);
          assert.equal((error as Error).message, missingReceiptMessage);
          return true;
        });
      }
    }
    assert.equal(engine.getActionNonce(lp.address), lpNonce);

    const amount = engine.accountSnapshot(trader.address).balances.USDT;
    const ticket = await act(trader, { kind: 'withdraw', token: 'USDT', amount: amount.toString() }) as Awaited<ReturnType<FakeChain['signWithdrawal']>>;
    assert.equal(engine.accountSnapshot(trader.address).balances.USDT, 0n);
    assert.equal(engine.snapshot().pending.USDT, amount);
    assert.equal(verifyTypedData(withdrawalDomain(config.chainId, config.vaultAddress), WITHDRAWAL_TYPES, ticket.withdrawal, ticket.signature), operator.address);
    const recovered = await act(trader, { kind: 'withdrawal', nonce: ticket.withdrawal.nonce.toString() }) as typeof ticket;
    assert.deepEqual(recovered, ticket);
    assert.equal(engine.snapshot().pending.USDT, amount);
    const beforeFailedSwap = engine.snapshot();
    await assert.rejects(act(trader, { kind: 'swap', tokenIn: 'USDT', amountIn: '1', minOut: '0' }), /Insufficient USDT/);
    assert.deepEqual(engine.snapshot(), beforeFailedSwap);

    chain.paused = true;
    chain.allowed.delete(trader.address);
    await assert.rejects(act(trader, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('1', 18).toString(), minOut: '0' }), /whitelisted/);
    // Existing withdrawal can still be recovered by its authenticated owner.
    assert.deepEqual(await act(trader, { kind: 'withdrawal', nonce: ticket.withdrawal.nonce.toString() }), ticket);
    chain.events.push(() => { engine.settleWithdrawal(trader.address, ticket.withdrawal.nonce, 'USDT', amount, 'confirmed-payout:1'); });
    await api.sync();
    assert.equal(engine.snapshot().pending.USDT, 0n);
    assert.equal(engine.snapshot().custody.USDT, initial.custody.USDT - amount);
    const lpShares = engine.accountSnapshot(lp.address).lpShares;
    await act(lp, { kind: 'removeLiquidity', shares: lpShares.toString(), rubaMin: '0', usdtMin: '0' });
    const end = engine.snapshot();
    for (const token of ['RUBA', 'USDT'] as const) {
      assert.equal(end.custody[token], end.reserves[token] + end.available[token] + end.pending[token]);
    }
  } finally { engine.close(); }
});
