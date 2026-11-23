import assert from 'node:assert/strict';
import { Contract, NonceManager, Wallet, parseUnits } from 'ethers';
import { RubaClient } from '../ui/client.js';
import { loadTenderlySettings } from './tenderly-config.ts';
import { acquireTenderlyLock, prepareTenderly } from './tenderly.ts';

// Explicit live test: affects the configured virtual fork, never a public chain.
// All operations use a new disposable wallet, not the user's signing key.
const qa = Wallet.createRandom();
const settings = await loadTenderlySettings({ ...process.env, TEST_WALLET_ADDRESS: qa.address });
let prepared;
let release;
const json = (value) => JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field);
try {
  console.log('Live-проверка: развёртывание, faucet и пул на настроенном Tenderly-форке…');
  release = await acquireTenderlyLock(settings.stateDirectory);
  prepared = await prepareTenderly(settings);
  const { api, chain, engine, config } = prepared;
  const signer = new NonceManager(qa.connect(chain.provider));
  const provider = {
    send: (method, params) => method === 'eth_accounts' ? Promise.resolve([qa.address]) : chain.provider.send(method, params),
    getBlock: (tag) => chain.provider.getBlock(tag),
  };
  const publicConfig = JSON.parse(json(api.publicConfig()));
  const fetchImpl = async (path, options = {}) => {
    const url = new URL(path, 'http://127.0.0.1');
    try {
      if (url.pathname === '/nonce') {
        const account = url.searchParams.get('account');
        return new Response(json({ account, nonce: engine.getActionNonce(account) }));
      }
      if (url.pathname === '/actions' && options.method === 'POST') {
        return new Response(json({ result: await api.execute(JSON.parse(options.body)) }));
      }
      throw new Error('Unexpected local API path');
    } catch (error) {
      return new Response(json({ error: error.message }), { status: 400 });
    }
  };
  const client = new RubaClient(publicConfig, provider, signer, { fetchImpl });
  assert.equal((await client.getMarketStatus()).whitelisted, true);
  await client.deposit('RUBA', parseUnits('10', 18));
  await client.deposit('USDT', parseUnits('10', 6));
  await api.sync();
  let balance = await client.getAccount();
  assert.equal(BigInt(balance.balances.RUBA), parseUnits('10', 18));
  assert.equal(BigInt(balance.balances.USDT), parseUnits('10', 6));
  console.log('OK: настоящие approve/deposit RUBA и mainnet USDT, индексатор и подписанное чтение UI-клиента.');
  const custody = engine.snapshot().custody;
  const receipts = [];
  for (const tokenIn of ['RUBA', 'USDT', 'RUBA', 'USDT']) {
    const amountIn = parseUnits('1', tokenIn === 'RUBA' ? 18 : 6).toString();
    const quote = await client.signedAction({ kind: 'quote', tokenIn, amountIn });
    receipts.push(await client.signedAction({ kind: 'swap', tokenIn, amountIn, minOut: quote.amountOut }));
  }
  assert.deepEqual(engine.snapshot().custody, custody);
  await api.sync();
  await api.sync();
  const receipt = await client.signedAction({ kind: 'receipt', tradeId: receipts[0].tradeId });
  const verifier = new Contract(config.vaultAddress, ['function verifyReceipt(uint256,bytes32,bytes32[]) view returns (bool)'], chain.provider);
  assert.ok(receipt.proof?.length);
  assert.equal(await verifier.verifyReceipt(receipt.batchId, receipt.leaf, receipt.proof), true);
  console.log('OK: четыре обмена, публикация пакета и проверка Merkle proof в RubaVault.');
  const added = await client.signedAction({
    kind: 'addLiquidity', rubaDesired: parseUnits('1', 18).toString(), usdtDesired: parseUnits('1', 6).toString(),
    rubaMin: '0', usdtMin: '0',
  });
  assert.ok(BigInt(added.shares) > 0n);
  await client.signedAction({ kind: 'removeLiquidity', shares: added.shares, rubaMin: '0', usdtMin: '0' });
  const usdt = new Contract(config.usdtAddress, ['function balanceOf(address) view returns (uint256)'], chain.provider);
  const before = BigInt(await usdt.balanceOf(qa.address));
  const ticket = await client.signedAction({ kind: 'withdraw', token: 'USDT', amount: parseUnits('1', 6).toString() });
  await client.redeemWithdrawal(ticket);
  await api.sync();
  assert.equal(BigInt(await usdt.balanceOf(qa.address)), before + parseUnits('1', 6));
  assert.equal(engine.getWithdrawal(qa.address, BigInt(ticket.withdrawal.nonce)).status, 'settled');
  console.log('OK: добавление/снятие ликвидности и настоящая выплата USDT на тестовый кошелёк.');
  console.log('TENDERLY_SMOKE_OK');
} catch (error) {
  // Do not print provider errors containing Admin RPC or signed transaction data.
  console.error(error.code ? 'Live-проверка Tenderly не прошла: ошибка RPC/транзакции.' : error.message);
  process.exitCode = 1;
} finally {
  prepared?.close();
  await release?.();
}
