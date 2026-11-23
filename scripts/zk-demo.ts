import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, NonceManager, parseUnits } from 'ethers';
import { RubaApi } from '../server/api.ts';
import { WITHDRAWAL_TYPES, withdrawalDomain } from '../server/auth.ts';
import { ZkRubaEngine } from '../server/zk/engine.ts';
import { ZkVaultChain } from '../server/zk/chain.ts';
import type { ZkSignedPublication } from '../server/zk/types.ts';
import type { TradeReceipt, ProvenWithdrawalTicket } from '../server/types.ts';
import { FIELD, hashReceiptV2, verifyAccountProof } from '../zk/crypto.js';
import { actZkLocal, createZkLocalRuntime, deriveOwnerRecoveryKey, publishAllZkLocal, reconstructZkOwnerFromChain, seedZkLocalMarket, signedZkLocalRequest, zkPublicationArguments } from './zk-local-deploy.ts';

export interface ZkDemoResult {
  proofMode: 'groth16-bn254-v2'; tradeCount: 4; batchId: bigint; stateVersion: bigint;
  merkleVerified: boolean; recoveredWithoutApi: boolean; publicationPaidByUser: boolean;
  operatorNonceUnchanged: boolean; custodyUnchangedDuringSwaps: boolean; payoutAmount: bigint;
  forgedProofRejected: boolean; forgedHeaderRejected: boolean; forgedOwnerRejected: boolean;
  inventedInboxRejected: boolean; legacyBypassRejected: boolean; restartVerified: boolean;
  nonWhitelistedRegistrationRejected: boolean; nonWhitelistedDepositRejected: boolean;
  canonicalDepositAfterRevocation: boolean; nonWhitelistedWithdrawal: boolean;
  atomicPayout: boolean; acceptedClaimPayout: boolean; operatorRotationUnaffected: boolean; refundRejected: boolean;
}

/** End-to-end proof/custody flow on a new isolated Anvil chain, never on Tenderly. */
export async function runZkDemo(log: (message: string) => void = console.log): Promise<ZkDemoResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ruba-zk-demo-'));
  let runtime: Awaited<ReturnType<typeof createZkLocalRuntime>> | undefined;
  try {
    runtime = await createZkLocalRuntime(directory);
    let { engine, chain, api } = runtime;
    const { local, fixture, config } = runtime;
    const { vault, ruba, usdt, trader, operator } = fixture;
    await seedZkLocalMarket(local, fixture, engine, chain, api, log);
    log('ZK-регистрация, реальные вводы LP и начальная ликвидность подтверждены в контракте.');
    const traderTransactions = new NonceManager(trader);
    const adminVault = vault.connect(fixture.adminTransactions) as Contract;
    const operatorNonce = await local.provider.getTransactionCount(operator.address, 'latest');
    const outsider = local.wallets[4];
    const outsiderState = engine.getZkAccount(outsider.address);
    const outsiderKey = await deriveOwnerRecoveryKey(config, outsider);
    const registration = await signedZkLocalRequest(engine, chain, outsider, {
      kind: 'zkRegister', recoveryKey: outsiderKey.toString(), slot: outsiderState.slot.toString(),
    });
    await assert.rejects(api.execute(registration), /not whitelisted/);
    assert.equal(engine.getZkAccount(outsider.address).registered, false);
    assert.equal(engine.getActionNonce(outsider.address), 0n);
    assert.equal(engine.journal.getKey(outsiderState.slot), undefined);
    await (await adminVault.setWhitelist(trader.address, false)).wait();
    for (const [token, amount] of [[ruba, parseUnits('100', 18)], [usdt, parseUnits('100', 6)]] as const) {
      await (await (token.connect(traderTransactions) as Contract).approve(vault.target, amount)).wait();
      await assert.rejects((vault.connect(traderTransactions) as Contract).deposit.staticCall(token.target, amount),
        (error: any) => error.revert?.name === 'NotWhitelisted');
    }
    await (await adminVault.setWhitelist(trader.address, true)).wait();
    for (const [token, amount] of [[ruba, parseUnits('100', 18)], [usdt, parseUnits('100', 6)]] as const) {
      await (await (vault.connect(traderTransactions) as Contract).deposit(token.target, amount)).wait();
    }
    // Admission is checked when tokens enter the Vault. An already accepted
    // canonical credit must remain processable after revocation so it can exit.
    await (await adminVault.setWhitelist(trader.address, false)).wait();
    await api.sync();
    await publishAllZkLocal(api, chain, vault, traderTransactions, log);
    assert.equal(await vault.whitelist(trader.address), false);
    assert.equal(engine.accountSnapshot(trader.address).balances.USDT, parseUnits('100', 6));
    await (await adminVault.setWhitelist(trader.address, true)).wait();
    const custodyBefore = [await ruba.balanceOf(vault.target), await usdt.balanceOf(vault.target)];
    const supplyBefore = engine.snapshot().totalSupply;
    const first = await signedZkLocalRequest(engine, chain, trader, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    const receipts = [await api.execute(first) as TradeReceipt];
    await assert.rejects(api.execute(first), /nonce|stale/i);
    assert.equal((await chain.getPublicationRequest()).request, null);
    for (const [tokenIn, amountIn] of [['USDT', parseUnits('5', 6)], ['RUBA', parseUnits('10', 18)], ['USDT', parseUnits('5', 6)]] as const) {
      receipts.push(await actZkLocal(api, engine, chain, trader, { kind: 'swap', tokenIn, amountIn: amountIn.toString(), minOut: '1' }) as TradeReceipt);
      if (receipts.length < 4) assert.equal((await chain.getPublicationRequest()).request, null);
    }
    assert.deepEqual([await ruba.balanceOf(vault.target), await usdt.balanceOf(vault.target)], custodyBefore);
    assert.equal(engine.snapshot().totalSupply, supplyBefore);
    const prepared = await chain.getPublicationRequest();
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.request?.kind, 'zk');
    const ticket = prepared.request as ZkSignedPublication;
    assert.equal(ticket.publicSignals[2], 1n); assert.equal(ticket.batch.tradeCount, 4n);
    assert.equal(ticket.authorizationMode, 'proof-only');
    const userVault = vault.connect(traderTransactions) as Contract;

    const forgedProof = structuredClone(ticket);
    forgedProof.proof.a[0] = 0n;
    await assert.rejects(userVault.publishProvenTransition.staticCall(...zkPublicationArguments(forgedProof)));
    const forgedHeader = structuredClone(ticket);
    forgedHeader.publicSignals[4] = (forgedHeader.publicSignals[4] + 1n) % FIELD;
    await assert.rejects(userVault.publishProvenTransition.staticCall(...zkPublicationArguments(forgedHeader)));
    const forgedOwner = structuredClone(ticket);
    forgedOwner.operations[0].owner = fixture.admin.address;
    await assert.rejects(userVault.publishProvenTransition.staticCall(...zkPublicationArguments(forgedOwner)));
    const inventedInbox = structuredClone(ticket);
    Object.assign(inventedInbox.operations[0], { kind: 2n, eventId: BigInt(await vault.inboxCursor()) + 1n, token: 0n, amount: 1n, reference: 999n });
    await assert.rejects(userVault.publishProvenTransition.staticCall(...zkPublicationArguments(inventedInbox)));
    await assert.rejects(userVault.publishZkTransition.staticCall(...zkPublicationArguments(ticket), ticket.authorization));
    await assert.rejects(userVault.publishSignedBatch.staticCall(ticket.batch, ticket.deadline, ticket.signerEpoch, ticket.signature));
    await assert.rejects((vault.connect(operator) as Contract).publishBatch.staticCall(ticket.batch));

    // Restart with a pending immutable proof; neither journal nor publication
    // commitment may be replaced by arbitrary current database content.
    await api.drain(); await chain.prover.close(); chain.provider.destroy(); engine.close();
    engine = new ZkRubaEngine(config, fixture.poolRecoveryKey);
    chain = new ZkVaultChain(config, engine);
    await chain.initialize();
    api = new RubaApi(engine, chain, config);
    Object.assign(runtime, { engine, chain, api });
    const restarted = await chain.getPublicationRequest();
    assert.deepEqual((restarted.request as ZkSignedPublication).publicSignals, ticket.publicSignals);
    const tradePublications = await publishAllZkLocal(api, chain, vault, traderTransactions, log);
    assert.equal(tradePublications.length, 1);
    assert.equal(tradePublications[0].from, trader.address);
    assert.ok(tradePublications[0].gasUsed > 0n);
    assert.equal(await vault.lastBatchId(), 1n);
    for (const item of receipts) {
      const receipt = await actZkLocal(api, engine, chain, trader, { kind: 'receipt', tradeId: item.tradeId.toString() }) as TradeReceipt;
      assert.equal(hashReceiptV2(receipt), BigInt(receipt.leaf));
      assert.equal(receipt.proof?.length, 2);
      assert.equal(await vault.verifyZkReceipt(receipt.batchId, receipt.tradeId, BigInt(receipt.leaf), receipt.proof!.map(BigInt)), true);
      assert.equal(await vault.verifyZkReceipt(receipt.batchId, receipt.tradeId, hashReceiptV2({ ...receipt, amountOut: receipt.amountOut + 1n }), receipt.proof!.map(BigInt)), false);
    }
    const disclosed = await chain.getDisclosureBatch(1n);
    assert.equal(disclosed?.status, 'published');
    const recoveryKey = await deriveOwnerRecoveryKey(config, trader);
    const recovered = await reconstructZkOwnerFromChain(local.provider, config.vaultAddress, trader.address, recoveryKey, config.deploymentBlock);
    const expectedAccount = engine.getZkAccount(trader.address);
    assert.deepEqual(recovered.account, expectedAccount.account);
    assert.equal(recovered.stateRoot, BigInt(await vault.stateRoot()));
    assert.equal(verifyAccountProof(recovered.slot, recovered.leaf, recovered.path, recovered.accountsRoot), true);
    const backup = engine.getRecoveryBundle(trader.address);
    assert.equal(backup.accepted.root, recovered.stateRoot);
    assert.deepEqual(backup.accepted.account, recovered.account);
    log('Четыре сделки доказаны Groth16 и оплачены пользователем. Квитанции v2 приняты контрактом; баланс и Merkle-путь восстановлены из calldata без API.');

    // A non-whitelisted owner reserves a proof-backed perpetual claim. Market
    // pause and operator rotation cannot authorize, redirect, or cancel it.
    await (await adminVault.setWhitelist(trader.address, false)).wait();
    await (await adminVault.setMarketPaused(true)).wait();
    const payoutAmount = parseUnits('10', 6);
    const atomicAmount = parseUnits('3', 6);
    const payout = await actZkLocal(api, engine, chain, trader, { kind: 'withdraw', token: 'USDT', amount: atomicAmount.toString() }) as ProvenWithdrawalTicket;
    assert.equal(payout.kind, 'zk-withdrawal');
    assert.equal('signature' in payout, false);
    assert.equal(payout.withdrawal.nonce, payout.withdrawal.spendNonce);
    await assert.rejects(userVault.withdrawProven.staticCall(payout.withdrawal));
    await assert.rejects(actZkLocal(api, engine, chain, trader, { kind: 'expireWithdrawal', nonce: payout.withdrawal.nonce.toString() }), /expire|disabled|refund/i);
    const reservation = await chain.getPublicationRequest();
    assert.equal(reservation.status, 'ready');
    const reservationTicket = reservation.request as ZkSignedPublication;
    assert.ok(reservationTicket.operations.some((operation) => BigInt(operation.kind) === 6n && BigInt(operation.commitment) === payout.commitment));
    for (const changed of [
      { ...payout.withdrawal, account: fixture.admin.address },
      { ...payout.withdrawal, token: config.rubaAddress },
      { ...payout.withdrawal, amount: atomicAmount + 1n },
      { ...payout.withdrawal, nonce: payout.withdrawal.nonce + 1n },
      { ...payout.withdrawal, salt: (payout.withdrawal.salt + 1n) % FIELD },
    ]) await assert.rejects(userVault.publishProvenTransitionAndWithdraw.staticCall(...zkPublicationArguments(reservationTicket), changed));
    const refund = structuredClone(reservationTicket);
    refund.operations.find((operation) => BigInt(operation.kind) === 6n)!.kind = 8n;
    await assert.rejects(userVault.publishProvenTransition.staticCall(...zkPublicationArguments(refund)));
    const legacyWithdrawal = { account: trader.address, token: config.usdtAddress, amount: atomicAmount, nonce: payout.withdrawal.nonce,
      deadline: await chain.latestTimestamp() + 600n, signerEpoch: BigInt(await vault.signerEpoch()) };
    const oldSignature = await operator.signTypedData(withdrawalDomain(31337n, config.vaultAddress), WITHDRAWAL_TYPES, legacyWithdrawal);
    await assert.rejects(userVault.withdraw.staticCall(legacyWithdrawal, oldSignature), (error: any) => error.revert?.name === 'LegacyWithdrawalDisabled');
    await (await adminVault.setOperator(fixture.admin.address)).wait();
    const afterRotation = await chain.getPublicationRequest();
    assert.deepEqual((afterRotation.request as ZkSignedPublication).publicSignals, reservationTicket.publicSignals);
    assert.equal((afterRotation.request as ZkSignedPublication).authorizationMode, 'proof-only');
    const beforePayout = await usdt.balanceOf(trader.address);
    await (await userVault.publishProvenTransitionAndWithdraw(...zkPublicationArguments(reservationTicket), payout.withdrawal, { gasLimit: 25_000_000n })).wait();
    assert.equal(await usdt.balanceOf(trader.address), beforePayout + atomicAmount);
    assert.equal(await vault.spentWithdrawalCommitments(payout.commitment), true);
    await assert.rejects(userVault.withdrawProven.staticCall(payout.withdrawal));
    await api.sync();
    assert.equal(engine.getWithdrawal(trader.address, BigInt(payout.withdrawal.nonce))?.status, 'settled');
    await publishAllZkLocal(api, chain, vault, traderTransactions, log);
    const second = await actZkLocal(api, engine, chain, trader, { kind: 'withdraw', token: 'USDT', amount: (payoutAmount - atomicAmount).toString() }) as ProvenWithdrawalTicket;
    await publishAllZkLocal(api, chain, vault, traderTransactions, log);
    assert.equal((await vault.withdrawalClaims(second.commitment)).owner, trader.address);
    assert.equal(await vault.spentWithdrawalCommitments(second.commitment), false);
    await (await adminVault.setOperator(fixture.lp.address)).wait();
    await local.provider.send('evm_increaseTime', [604800]); await local.provider.send('evm_mine', []);
    await (await userVault.withdrawProven(second.withdrawal)).wait();
    assert.equal(await usdt.balanceOf(trader.address), beforePayout + payoutAmount);
    assert.equal(await vault.spentWithdrawalCommitments(second.commitment), true);
    await assert.rejects(userVault.withdrawProven.staticCall(second.withdrawal));
    await api.sync();
    await publishAllZkLocal(api, chain, vault, traderTransactions, log);
    assert.equal(engine.getAcceptedCheckpoint().root, BigInt(await vault.stateRoot()));
    assert.equal(await local.provider.getBalance(operator.address), 0n);
    assert.equal(await local.provider.getTransactionCount(operator.address, 'latest'), operatorNonce);
    const snapshot = engine.snapshot();
    assert.equal(await ruba.balanceOf(vault.target), snapshot.custody.RUBA);
    assert.equal(await usdt.balanceOf(vault.target), snapshot.custody.USDT);
    log('Без whitelist и подписи оператора проверены атомарный publish-and-withdraw и отдельное бессрочное погашение принятого claim. Смена оператора и пауза рынка не помешали; повторы, подмены, старый подписной путь и REFUND отклонены.');
    return {
      proofMode: 'groth16-bn254-v2', tradeCount: 4, batchId: 1n, stateVersion: BigInt(await vault.stateVersion()),
      merkleVerified: true, recoveredWithoutApi: true, publicationPaidByUser: true, operatorNonceUnchanged: true,
      custodyUnchangedDuringSwaps: true, payoutAmount, forgedProofRejected: true, forgedHeaderRejected: true,
      forgedOwnerRejected: true, inventedInboxRejected: true, legacyBypassRejected: true, restartVerified: true,
      nonWhitelistedRegistrationRejected: true, nonWhitelistedDepositRejected: true,
      canonicalDepositAfterRevocation: true, nonWhitelistedWithdrawal: true, atomicPayout: true,
      acceptedClaimPayout: true, operatorRotationUnaffected: true, refundRejected: true,
    };
  } finally {
    await runtime?.api.drain(); await runtime?.chain.prover.close(); runtime?.chain.provider.destroy(); runtime?.engine.close();
    await runtime?.local.close(); await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runZkDemo().then((result) => console.log(`ZK demo завершено: ${result.tradeCount} сделки, ${result.stateVersion} доказанных перехода.`)).catch((error: Error) => { console.error(`ZK demo остановлено: ${error.message}`); process.exitCode = 1; });
}
