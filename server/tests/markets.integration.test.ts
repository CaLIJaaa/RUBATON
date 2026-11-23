import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, Contract, Interface, NonceManager, parseUnits } from 'ethers';
import { createLocalMarkets } from '../../scripts/markets-dev.ts';
import { serveMarkets, closeMarketRuntimes, createMarketRuntimes } from '../../scripts/sepolia-runtime.ts';
import { DeploymentTransactions, SerialTransactionQueue } from '../../scripts/sepolia-transactions.ts';
import { actZkLocal, zkPublicationArguments } from '../../scripts/zk-local-deploy.ts';
import { ZK_VAULT_ABI } from '../zk/chain.ts';
import type { ZkSignedPublication } from '../zk/types.ts';
import type { ProvenWithdrawalTicket } from '../types.ts';
import { ArbitrageWorker } from '../arbitrage.ts';
import { deviationBps, spotPrice, targetPrice } from '../price-math.ts';
import { POOLS } from '../../scripts/sepolia-config.ts';
import { MARKET_CONTROL_TYPES, controlActionHash, marketControlDomain } from '../markets.ts';
import { reconstructZkOwnerFromChain } from '../../scripts/zk-local-deploy.ts';

test('live three-market Anvil: automatic four swaps, administrator partial close, withdrawal flush and private DA recovery', {
  skip: process.env.RUBA_MARKETS_INTEGRATION !== '1' ? 'Run npm run test:markets:integration' : false, timeout: 1_800_000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ruba-markets-integration-'));
  let runtime: Awaited<ReturnType<typeof createLocalMarkets>> | undefined;
  let serving: Awaited<ReturnType<typeof serveMarkets>> | undefined;
  try {
    runtime = await createLocalMarkets(directory, { port: 0, log: (message) => context.diagnostic(message) });
    const { manifest, keys, provider, settings, env } = runtime;
    assert.equal(runtime.markets.length, 3);
    const roots = new Set<string>();
    for (const market of runtime.markets) {
      const vault = new Contract(market.config.vaultAddress, ZK_VAULT_ABI, provider);
      assert.equal(await vault.verifier(), manifest.shared.verifier); assert.equal(await vault.poseidon2(), manifest.shared.poseidon);
      assert.equal(await vault.withdrawalMode(), 'proven-reservation-v1');
      assert.equal(market.engine.getAcceptedCheckpoint().stateVersion, 2n);
      roots.add(market.engine.getAcceptedCheckpoint().root.toString());
      const definition = POOLS.find((pool) => pool.id === market.id)!;
      assert.equal(market.api.publicConfig().tokens.USDT.decimals, manifest.tokens[definition.assets[1]].decimals);
      assert.equal(market.api.publicConfig().tokens.USDT.symbol, definition.assets[1]);
    }
    assert.equal(roots.size, 3);
    serving = await serveMarkets(runtime.markets, manifest, keys, settings);
    const address = serving.http.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const catalog = await (await fetch(`${origin}/markets`)).json();
    assert.equal(catalog.markets.length, 3); assert.equal(catalog.network.name, 'Anvil');
    const firstConfig = await (await fetch(`${origin}/markets/ruba-weth/config`)).json();
    const thirdConfig = await (await fetch(`${origin}/markets/weth-wbtc/config`)).json();
    assert.equal(firstConfig.tokens.USDT.decimals, 18); assert.equal(firstConfig.tokens.USDT.symbol, 'WETH');
    assert.equal(thirdConfig.tokens.RUBA.symbol, 'WETH'); assert.equal(thirdConfig.tokens.USDT.decimals, 8);
    assert.equal((await fetch(`${origin}/markets/no-such-pool/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    const txs = new DeploymentTransactions(provider, directory, manifest, env.save);
    const bot = new Wallet(keys.roles.bot.privateKey, provider);
    const published: { market: typeof runtime.markets[number]; receipt: any }[] = [];
    serving.arb.stop(); await serving.arb.drain();
    const lp = new Wallet(keys.roles.lp.privateKey, provider);
    const users = new Map<string, unknown>(); const beforeDeviation = new Map<string, bigint>();
    for (const market of runtime.markets.slice(0, 2)) {
      const shares = market.engine.accountSnapshot(lp.address).lpShares / 10n;
      await actZkLocal(market.api, market.engine, market.chain, lp, { kind: 'removeLiquidity', shares: shares.toString(), rubaMin: '1', usdtMin: '1' });
      const control = (await market.chain.getPublicationRequest()).request as ZkSignedPublication;
      await txs.run(`test:lp-withdraw:${market.id}`, lp, { to: market.config.vaultAddress, data: new Interface(ZK_VAULT_ABI).encodeFunctionData('publishProvenTransition', zkPublicationArguments(control)) });
      await market.api.sync();
      await actZkLocal(market.api, market.engine, market.chain, lp, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('100', 18).toString(), minOut: '1' });
      assert.equal(market.engine.getBatchProgress().collected, 1);
      users.set(market.id, market.engine.accountSnapshot(lp.address));
      const metadata = market.config.tokenMetadata!;
      const target = targetPrice(serving.server.getSettings().prices[metadata.RUBA.symbol as 'RUBA'], serving.server.getSettings().prices[metadata.USDT.symbol as 'USDT']);
      const reserves = market.engine.snapshot().reserves;
      beforeDeviation.set(market.id, deviationBps(spotPrice(reserves.RUBA, reserves.USDT, metadata.RUBA.decimals, metadata.USDT.decimals), target));
      serving.server.settings.apply({ kind: 'arbitrage', marketId: market.id, enabled: true, delaySeconds: 5 }, serving.server.settings.getNonce());
    }
    const botNonceBefore = await provider.getTransactionCount(bot.address, 'latest');
    const worker = new ArbitrageWorker({ markets: runtime.markets, botSigner: bot, transactionSigner: new NonceManager(bot),
      settings: () => serving!.server.getSettings(), transactionQueue: new SerialTransactionQueue() });
    const clock = Date.now(); await worker.runOnce(clock);
    assert.equal(worker.getStatus(runtime.markets[0].id).status, 'scheduled');
    for (let iteration = 0; iteration < 12; iteration++) {
      await worker.runOnce(clock + 5001 + iteration);
      for (const market of runtime.markets) await market.api.sync();
      if (runtime.markets.slice(0, 2).every((market) => market.engine.getBatch(1n)?.publishedTxHash)) break;
      assert.notEqual(worker.getStatus(runtime.markets[0].id).status, 'error', 'Real worker must not hide a publication/math failure');
    }
    worker.stop(); await worker.drain();
    const publicationNonces = [] as number[];
    for (const market of runtime.markets.slice(0, 2)) {
      const batch = market.engine.getBatch(1n)!; assert.ok(batch?.publishedTxHash);
      const receipt = market.engine.getReceipt(1n)!; assert.equal(receipt.batchId, 1n); assert.equal(receipt.account, lp.address);
      for (let id = 2n; id <= 4n; id++) { const leg = market.engine.getReceipt(id)!; assert.equal(leg.account, bot.address); assert.ok(leg.amountIn > 0n && leg.amountOut > 0n); }
      const userNow = market.engine.accountSnapshot(lp.address), userThen = users.get(market.id) as typeof userNow;
      assert.deepEqual(userNow.balances, userThen.balances, 'Worker cannot debit the user beyond their own authorized swap');
      const metadata = market.config.tokenMetadata!, reserves = market.engine.snapshot().reserves;
      const target = targetPrice(serving.server.getSettings().prices[metadata.RUBA.symbol as 'RUBA'], serving.server.getSettings().prices[metadata.USDT.symbol as 'USDT']);
      const after = deviationBps(spotPrice(reserves.RUBA, reserves.USDT, metadata.RUBA.decimals, metadata.USDT.decimals), target);
      const absolute = (value: bigint) => value < 0n ? -value : value;
      assert.ok(absolute(after) < absolute(beforeDeviation.get(market.id)!));
      const publication = await provider.getTransaction(batch.publishedTxHash!); assert.equal(publication!.from, bot.address); publicationNonces.push(publication!.nonce);
      const vault = new Contract(market.config.vaultAddress, ['function verifyZkReceipt(uint256,uint256,uint256,uint256[2]) view returns(bool)'], provider);
      assert.equal(await vault.verifyZkReceipt(1n, 1n, BigInt(receipt.leaf), receipt.proof!.map(BigInt)), true);
      published.push({ market, receipt });
      serving.server.settings.apply({ kind: 'arbitrage', marketId: market.id, enabled: false, delaySeconds: 5 }, serving.server.settings.getNonce());
    }
    assert.equal(new Set(publicationNonces).size, 2); assert.deepEqual(publicationNonces.sort((a,b) => a-b), [botNonceBefore, botNonceBefore + 1]);
    context.diagnostic('Real ArbitrageWorker corrected two concurrent markets with three genuine bot legs each, owner signatures and unique shared Ethereum nonces.');
    const wrongVault = new Contract(published[1].market.config.vaultAddress, ['function verifyZkReceipt(uint256,uint256,uint256,uint256[2]) view returns(bool)'], provider);
    assert.equal(await wrongVault.verifyZkReceipt(1n, 1n, BigInt(published[0].receipt.leaf), published[0].receipt.proof.map(BigInt)), false);

    // An administrator seals two genuine swaps. The administrator signs only
    // the market command; its wallet then pays for the proof-only publication.
    const partial = runtime.markets[0];
    for (const [tokenIn, amountIn] of [['USDT', parseUnits('1', 6)], ['RUBA', parseUnits('0.1', 18)]] as const) {
      await actZkLocal(partial.api, partial.engine, partial.chain, lp, { kind: 'swap', tokenIn, amountIn: amountIn.toString(), minOut: '1' });
    }
    assert.equal(partial.engine.getBatchProgress().collected, 2);
    assert.equal((await partial.chain.getPublicationRequest()).status, 'idle');
    const admin = new Wallet(runtime.local.wallets[0].privateKey, provider);
    assert.equal(admin.address, manifest.roles.admin);
    const closeCommand = async () => {
      const command = { kind: 'closeBatch', marketId: partial.id };
      const nonce = serving!.server.settings.getNonce();
      const deadline = await partial.chain.latestTimestamp() + 300n;
      const signature = await admin.signTypedData(marketControlDomain(BigInt(manifest.network.chainId), runtime!.markets[0].config.vaultAddress),
        MARKET_CONTROL_TYPES, { actionHash: controlActionHash(command), nonce, deadline });
      return { command, nonce: nonce.toString(), deadline: deadline.toString(), signature };
    };
    const closeRequest = await closeCommand();
    const closeResponse = await fetch(`${origin}/admin/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(closeRequest) });
    assert.equal(closeResponse.status, 200);
    const closed = await closeResponse.json();
    assert.equal(closed.result.marketId, partial.id);
    assert.equal(closed.result.preparationError, undefined);
    assert.equal(closed.result.publication.status, 'ready');
    const partialTicket = (await partial.chain.getPublicationRequest()).request as ZkSignedPublication;
    assert.equal(partialTicket.batch.tradeCount, 2n);
    assert.equal(partialTicket.batch.batchId, 2n);
    assert.equal(partialTicket.publicSignals[8] - partialTicket.publicSignals[7], 2n);
    assert.equal(BigInt(closed.result.closedThroughStateVersion), partialTicket.publicSignals[1]);
    assert.equal((await fetch(`${origin}/admin/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(closeRequest) })).status, 409);
    const manualPublication = await txs.run('test:manual-partial:ruba-usdt', admin, { to: partial.config.vaultAddress,
      data: new Interface(ZK_VAULT_ABI).encodeFunctionData('publishProvenTransition', zkPublicationArguments(partialTicket)) });
    assert.ok(manualPublication);
    await partial.api.sync();
    const partialVault = new Contract(partial.config.vaultAddress, ['function verifyZkReceipt(uint256,uint256,uint256,uint256[2]) view returns(bool)'], provider);
    const partialReceipt = partial.engine.getReceipt(5n)!;
    assert.equal(await partialVault.verifyZkReceipt(2n, 5n, BigInt(partialReceipt.leaf), partialReceipt.proof!.map(BigInt)), true);
    assert.equal(await partialVault.verifyZkReceipt(2n, 7n, 0n, [0n, 0n]), false, 'An unused receipt leaf cannot be claimed');
    const accountSlot = partial.engine.getZkAccount(lp.address).slot;
    const recovered = await reconstructZkOwnerFromChain(provider, partial.config.vaultAddress, lp.address,
      partial.engine.journal.getKey(accountSlot)!, partial.config.deploymentBlock);
    assert.equal(recovered.nextTradeId, 7n);
    assert.equal(recovered.stateRoot, partial.engine.getAcceptedCheckpoint().root);
    const emptyResponse = await fetch(`${origin}/admin/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await closeCommand()) });
    assert.equal(emptyResponse.status, 200);
    const emptyClose = await emptyResponse.json();
    assert.equal(emptyClose.result.closedThroughStateVersion, null);
    assert.equal(emptyClose.result.publication?.status ?? 'idle', 'idle');
    context.diagnostic('Administrator signed a two-swap close; actual Groth16, receipt padding rejection, replay guard and API-free DA reconstruction passed.');

    const third = runtime.markets[2];
    assert.equal(third.engine.getZkAccount(bot.address).nextTradeId, 1n);
    assert.equal(third.engine.accountSnapshot(bot.address).balances.RUBA, parseUnits('3', 18), 'Shared WETH token does not mean shared internal balances');
    await actZkLocal(third.api, third.engine, third.chain, bot, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('0.001', 18).toString(), minOut: '1' });
    assert.equal(third.engine.getBatchProgress().collected, 1);
    const payout = await actZkLocal(third.api, third.engine, third.chain, bot, { kind: 'withdraw', token: 'USDT', amount: parseUnits('0.001', 8).toString() }) as ProvenWithdrawalTicket;
    const claimOffer = await third.chain.getPublicationRequest();
    const claimTicket = claimOffer.request as ZkSignedPublication;
    assert.equal(claimTicket.publicSignals[2], 1n, 'Withdrawal closes the pending trade packet without waiting for a second swap');
    assert.equal(claimTicket.batch.tradeCount, 1n);
    const token = new Contract(third.config.usdtAddress, ['function balanceOf(address) view returns(uint256)'], provider);
    const before = await token.balanceOf(bot.address);
    await txs.run('test:wbtc:atomic', bot, { to: third.config.vaultAddress, data: new Interface(ZK_VAULT_ABI).encodeFunctionData('publishProvenTransitionAndWithdraw', [...zkPublicationArguments(claimTicket), payout.withdrawal]) });
    await third.api.sync();
    assert.equal(await token.balanceOf(bot.address), before + parseUnits('0.001', 8));
    const settle = await third.chain.getPublicationRequest();
    await txs.run('test:wbtc:settle', bot, { to: third.config.vaultAddress, data: new Interface(ZK_VAULT_ABI).encodeFunctionData('publishProvenTransition', zkPublicationArguments(settle.request as ZkSignedPublication)) });
    await third.api.sync();
    assert.equal(third.engine.getWithdrawal(bot.address, payout.withdrawal.nonce)?.status, 'settled');
    await serving.close(); serving = undefined; runtime.markets.length = 0;
    const restarted = await createMarketRuntimes(manifest, keys, settings);
    runtime.markets.push(...restarted);
    assert.equal(restarted[0].engine.getAcceptedCheckpoint().stateVersion, 5n);
    assert.equal(restarted[1].engine.getAcceptedCheckpoint().stateVersion, 4n);
    assert.equal(restarted[2].engine.getAcceptedCheckpoint().stateVersion, 4n);
    assert.equal(await provider.getBalance(keys.roles.prover.address), 0n);
    assert.equal(await provider.getTransactionCount(keys.roles.prover.address), 0);
    context.diagnostic('All three seeded markets verified; actual proofs and WBTC8 payout succeeded; isolated persistent journals resumed.');
  } finally {
    if (serving) { await serving.close(); if (runtime) runtime.markets.length = 0; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
});
