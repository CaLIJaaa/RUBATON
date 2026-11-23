import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, NonceManager, TypedDataEncoder, Wallet, formatUnits, parseUnits, verifyTypedData } from 'ethers';
import type { HDNodeWallet } from 'ethers';
import { RubaApi } from '../server/api.ts';
import type { Operation } from '../server/api.ts';
import { ACTION_TYPES, BATCH_PUBLICATION_TYPES, actionDomain, batchPublicationDomain, operationHash } from '../server/auth.ts';
import { VaultChain } from '../server/chain.ts';
import type { ServerConfig } from '../server/config.ts';
import { RubaEngine } from '../server/engine.ts';
import { hashReceipt } from '../server/merkle.ts';
import type { TradeReceipt } from '../server/types.ts';
import { deployLocalFixture, startLocalChain } from './local-deploy.ts';

export interface DemoResult {
  tradeCount: number;
  batchId: bigint;
  merkleVerified: boolean;
  payoutAmount: bigint;
  custodyUnchangedDuringSwaps: boolean;
  publicationPaidByUser: boolean;
  operatorNonceUnchanged: boolean;
}

/** Full local-only scenario. It never connects to an existing/public network. */
export async function runDemo(log: (message: string) => void = console.log): Promise<DemoResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ruba-demo-'));
  let local: Awaited<ReturnType<typeof startLocalChain>> | undefined;
  let engine: RubaEngine | undefined;
  let chain: VaultChain | undefined;
  try {
    local = await startLocalChain();
    const fixture = await deployLocalFixture(local);
    const { lp, trader, operator, adminTransactions } = fixture;
    const ruba = fixture.ruba as Contract;
    const usdt = fixture.usdt as Contract;
    const vault = fixture.vault as Contract;
    const vaultAddress = await vault.getAddress();
    const rubaAddress = await ruba.getAddress();
    const usdtAddress = await usdt.getAddress();
    const config: ServerConfig = {
      rpcUrl: local.rpcUrl, chainId: 31337n, vaultAddress, rubaAddress, usdtAddress,
      operatorPrivateKey: operator.privateKey, deploymentBlock: fixture.deploymentBlock,
      confirmations: 0, withdrawalTtl: 900n, dbPath: join(directory, 'ledger.sqlite'),
      host: '127.0.0.1', port: 3001, syncIntervalMs: 2_000,
    };
    engine = new RubaEngine(config);
    chain = new VaultChain(config, engine);
    await chain.initialize();
    let api = new RubaApi(engine, chain, config);
    const adminVault = vault.connect(adminTransactions) as Contract;
    for (const account of [lp.address, trader.address]) await (await adminVault.setWhitelist(account, true)).wait();

    const lpTransactions = new NonceManager(lp);
    const traderTransactions = new NonceManager(trader);
    for (const [wallet, transactions, rubaAmount, usdtAmount] of [
      [lp, lpTransactions, parseUnits('1000', 18), parseUnits('1000', 6)],
      [trader, traderTransactions, parseUnits('100', 18), parseUnits('100', 6)],
    ] as const) {
      await (await ruba.mint(wallet.address, rubaAmount)).wait();
      await (await usdt.mint(wallet.address, usdtAmount)).wait();
      await (await (ruba.connect(transactions) as Contract).approve(vaultAddress, rubaAmount)).wait();
      await (await (usdt.connect(transactions) as Contract).approve(vaultAddress, usdtAmount)).wait();
      await (await (vault.connect(transactions) as Contract).deposit(rubaAddress, rubaAmount)).wait();
      await (await (vault.connect(transactions) as Contract).deposit(usdtAddress, usdtAmount)).wait();
    }
    await api.sync();
    assert.equal(engine.accountSnapshot(lp.address).balances.RUBA, parseUnits('1000', 18));
    assert.equal(engine.accountSnapshot(trader.address).balances.USDT, parseUnits('100', 6));
    log('Развёрнуты моки RUBA (18 знаков), USDT (6 знаков) и RubaVault. Вводы подтверждены индексатором.');

    async function signedRequest(wallet: HDNodeWallet, operation: Operation) {
      const intent = {
        account: wallet.address, actionHash: operationHash(operation),
        nonce: engine!.getActionNonce(wallet.address).toString(),
        deadline: (await chain!.latestTimestamp() + 600n).toString(),
      };
      const signature = await wallet.signTypedData(actionDomain(31337n, vaultAddress), ACTION_TYPES, intent);
      return { intent, operation, signature };
    }
    async function act(wallet: HDNodeWallet, operation: Operation) {
      return api.execute(await signedRequest(wallet, operation));
    }
    await act(lp, {
      kind: 'addLiquidity', rubaDesired: parseUnits('1000', 18).toString(), usdtDesired: parseUnits('1000', 6).toString(),
      rubaMin: parseUnits('1000', 18).toString(), usdtMin: parseUnits('1000', 6).toString(),
    });
    const before = { ruba: await ruba.balanceOf(vaultAddress), usdt: await usdt.balanceOf(vaultAddress) };
    const supplyBefore = engine.snapshot().totalSupply;
    const first = await signedRequest(trader, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    const receipts: TradeReceipt[] = [await api.execute(first) as TradeReceipt];
    await api.sync();
    assert.equal(await vault.lastBatchId(), 0n);
    assert.equal(receipts[0].batchId, undefined);
    assert.deepEqual(engine.getBatchProgress(), { collected: 1, required: 4 });
    assert.deepEqual(await chain.getPublicationRequest(), { status: 'idle', request: null, progress: { collected: 1, required: 4 } });
    log('Первый своп записан в журнал; публикация ожидает полный пакет из четырёх сделок.');
    await assert.rejects(api.execute(first), /nonce/i);
    for (const [tokenIn, amountIn] of [
      ['USDT', parseUnits('5', 6)], ['RUBA', parseUnits('10', 18)], ['USDT', parseUnits('5', 6)],
    ] as const) {
      receipts.push(await act(trader, { kind: 'swap', tokenIn, amountIn: amountIn.toString(), minOut: '1' }) as TradeReceipt);
      if (receipts.length < 4) {
        await api.sync();
        assert.equal(await vault.lastBatchId(), 0n);
        assert.equal(engine.listPendingBatches().length, 0);
        assert.deepEqual(engine.getBatchProgress(), { collected: receipts.length, required: 4 });
        assert.equal((await chain.getPublicationRequest()).request, null);
      }
    }
    assert.equal(await ruba.balanceOf(vaultAddress), before.ruba);
    assert.equal(await usdt.balanceOf(vaultAddress), before.usdt);
    assert.equal(engine.snapshot().totalSupply, supplyBefore);
    log('Четыре подписанных свопа проведены на сервере. Остатки ERC-20 в хранилище и количество LP-долей не изменились. Повтор заявки отклонён.');

    // Signing authorizations needs no ETH; catch any accidental operator send.
    await local.provider.send('anvil_setBalance', [operator.address, '0x0']);
    const operatorNonceBefore = await local.provider.getTransactionCount(operator.address, 'latest');
    const initial = await chain.getPublicationRequest();
    assert.equal(initial.status, 'ready');
    const initialTicket = initial.request!;
    assert.equal(initialTicket.batch.batchId, 1n);
    assert.equal(await vault.lastBatchId(), 0n, 'Preparing a ticket must not publish it');
    assert.deepEqual(await chain.getPublicationRequest(), initial);
    // A completed outbox batch survives a full server restart without changing its commitment.
    chain.close(); engine.close();
    engine = new RubaEngine(config);
    chain = new VaultChain(config, engine);
    await chain.initialize();
    api = new RubaApi(engine, chain, config);
    assert.deepEqual((await chain.getPublicationRequest()).request?.batch, initialTicket.batch);
    const userVault = vault.connect(traderTransactions) as Contract;
    await local.provider.send('evm_increaseTime', [601]);
    await local.provider.send('evm_mine', []);
    await assert.rejects(userVault.publishSignedBatch.staticCall(initialTicket.batch, initialTicket.deadline, initialTicket.signerEpoch, initialTicket.signature));
    const renewed = (await chain.getPublicationRequest()).request!;
    assert.ok(renewed.deadline > initialTicket.deadline);
    assert.deepEqual(renewed.batch, initialTicket.batch);
    // Rotation invalidates a public ticket even if the old operator is subsequently restored.
    await (await adminVault.setOperator(Wallet.createRandom().address)).wait();
    await assert.rejects(chain.getPublicationRequest(), /Operator changed/);
    await (await adminVault.setOperator(operator.address)).wait();
    await assert.rejects(userVault.publishSignedBatch.staticCall(renewed.batch, renewed.deadline, renewed.signerEpoch, renewed.signature));
    const publication = (await chain.getPublicationRequest()).request!;
    const typedValue = { ...publication.batch, deadline: publication.deadline, signerEpoch: publication.signerEpoch };
    assert.equal(verifyTypedData(batchPublicationDomain(31337n, vaultAddress), BATCH_PUBLICATION_TYPES, typedValue, publication.signature), operator.address);
    assert.equal(await vault.batchPublicationDigest(publication.batch, publication.deadline, publication.signerEpoch),
      TypedDataEncoder.hash(batchPublicationDomain(31337n, vaultAddress), BATCH_PUBLICATION_TYPES, typedValue));
    const wrongSequence = { ...publication.batch, batchId: publication.batch.batchId + 1n };
    const wrongSequenceSignature = await operator.signTypedData(batchPublicationDomain(31337n, vaultAddress), BATCH_PUBLICATION_TYPES,
      { ...wrongSequence, deadline: publication.deadline, signerEpoch: publication.signerEpoch });
    await assert.rejects(userVault.publishSignedBatch.staticCall(wrongSequence, publication.deadline, publication.signerEpoch, wrongSequenceSignature));
    const publicationTransaction = await userVault.publishSignedBatch(publication.batch, publication.deadline, publication.signerEpoch, publication.signature);
    const publicationReceipt = await publicationTransaction.wait();
    assert.ok(publicationReceipt);
    assert.equal(publicationReceipt.from, trader.address);
    assert.ok(publicationReceipt.gasUsed > 0n);
    assert.equal(await local.provider.getTransactionCount(operator.address, 'latest'), operatorNonceBefore);
    assert.equal(await local.provider.getBalance(operator.address), 0n);
    await assert.rejects(userVault.publishSignedBatch.staticCall(publication.batch, publication.deadline, publication.signerEpoch, publication.signature));
    await api.sync();
    assert.equal(engine.listPendingBatches().length, 0);
    assert.equal(engine.getBatch(1n)?.publishedTxHash, publicationTransaction.hash);
    const receipt = await act(trader, { kind: 'receipt', tradeId: receipts[0].tradeId.toString() }) as TradeReceipt;
    assert.equal(receipt.batchId, 1n);
    assert.ok(receipt.proof);
    assert.equal(await vault.verifyReceipt(receipt.batchId, receipt.leaf, receipt.proof), true);
    const changedLeaf = hashReceipt({ ...receipt, amountOut: receipt.amountOut + 1n });
    assert.equal(await vault.verifyReceipt(receipt.batchId, changedLeaf, receipt.proof), false);
    assert.equal(await vault.lastBatchId(), 1n);
    assert.deepEqual(engine.getBatchProgress(), { collected: 0, required: 4 });
    for (const item of receipts) {
      const sealed: TradeReceipt = engine.getReceipt(item.tradeId)!;
      assert.equal(sealed.batchId, 1n);
      assert.equal(sealed.proof?.length, 2);
      assert.equal(await vault.verifyReceipt(sealed.batchId, sealed.leaf, sealed.proof), true);
      assert.equal((await vault.batches(sealed.batchId)).tradeCount, 4n);
    }
    log('Пользователь оплатил публикацию четырёх свопов своим кошельком; оператор только подписал пакет. Проверены истечение срока, смена оператора, порядок, перезапуск и повтор. Доказательства Меркла приняты контрактом.');

    const payoutAmount = parseUnits('10', 6);
    const payout = await act(trader, { kind: 'withdraw', token: 'USDT', amount: payoutAmount.toString() }) as {
      withdrawal: { account: string; token: string; amount: bigint; nonce: bigint; deadline: bigint; signerEpoch: bigint };
      signature: string;
    };
    const afterReservation = engine.snapshot();
    assert.equal(afterReservation.pending.USDT, payoutAmount);
    // Existing claims remain withdrawable after access revocation and market pause.
    await (await adminVault.setWhitelist(trader.address, false)).wait();
    await (await adminVault.setMarketPaused(true)).wait();
    const walletBefore = await usdt.balanceOf(trader.address);
    await (await (vault.connect(traderTransactions) as Contract).withdraw(payout.withdrawal, payout.signature)).wait();
    await api.sync();
    assert.equal(await usdt.balanceOf(trader.address), walletBefore + payoutAmount);
    assert.equal(await vault.usedWithdrawalNonces(trader.address, payout.withdrawal.nonce), true);
    assert.equal(engine.snapshot().pending.USDT, 0n);
    assert.equal(engine.getWithdrawal(trader.address, payout.withdrawal.nonce)?.status, 'settled');
    await assert.rejects(act(trader, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('1', 18).toString(), minOut: '1' }), /whitelist|paused/i);
    log(`Выведено ${formatUnits(payoutAmount, 6)} USDT. Пауза и отзыв whitelist остановили новые сделки, сохранив возможность погасить ранее выданное разрешение.`);

    const snapshot = engine.snapshot();
    for (const token of ['RUBA', 'USDT'] as const) {
      assert.equal(snapshot.custody[token], snapshot.reserves[token] + snapshot.available[token] + snapshot.pending[token]);
    }
    assert.equal(await ruba.balanceOf(vaultAddress), snapshot.custody.RUBA);
    assert.equal(await usdt.balanceOf(vaultAddress), snapshot.custody.USDT);
    log('Проверено: токены хранилища = резервы AMM + свободные балансы + ожидающие выводы.');
    return { tradeCount: 4, batchId: 1n, merkleVerified: true, payoutAmount, custodyUnchangedDuringSwaps: true, publicationPaidByUser: true, operatorNonceUnchanged: true };
  } finally {
    chain?.provider.destroy();
    engine?.close();
    await local?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemo().catch((error: Error) => {
    const message = /EPERM|operation not permitted/.test(error.message)
      ? 'Окружение запрещает открывать локальные порты. Запустите npm run demo в обычном терминале на своём компьютере.'
      : error.message;
    console.error(`Демонстрация остановлена: ${message}`);
    process.exitCode = 1;
  });
}
