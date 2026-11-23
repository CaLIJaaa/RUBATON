import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { RubaClient, loadConfig } from '../client.js';
import { canonicalJson, parseAmount, formatAmount, parseSlippage, minimumOutput, errorMessage } from '../model.js';
import { RubaEngine } from '../../server/engine.ts';
import { RubaApi } from '../../server/api.ts';
import { operationHash, WITHDRAWAL_TYPES, withdrawalDomain } from '../../server/auth.ts';
import { scopedMarketFetch } from '../markets.js';

const trader = new Wallet('0x' + '11'.repeat(32));
const operator = new Wallet('0x' + '22'.repeat(32));
const lp = new Wallet('0x' + '33'.repeat(32));
const other = new Wallet('0x' + '44'.repeat(32));
const config = {
  chainId: '31337', vaultAddress: getAddress('0x0000000000000000000000000000000000000001'),
  tokens: {
    RUBA: { address: getAddress('0x0000000000000000000000000000000000000002'), decimals: 18 },
    USDT: { address: getAddress('0x0000000000000000000000000000000000000003'), decimals: 6 },
  },
};
const now = 1_800_000_000n;
const wire = (value) => JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
const ZERO_ROOT = '0x' + '00'.repeat(32);
const BATCH_PUBLICATION_TYPES = { BatchPublication: [
  { name: 'batchId', type: 'uint256' }, { name: 'previousStateRoot', type: 'bytes32' },
  { name: 'newStateRoot', type: 'bytes32' }, { name: 'receiptsRoot', type: 'bytes32' },
  { name: 'firstTradeId', type: 'uint256' }, { name: 'tradeCount', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'signerEpoch', type: 'uint256' },
] };

function fixture({ chainMode, latestTimestamp = now, pendingTimestamp = now, onWalletStep } = {}) {
  const clientConfig = { ...config, ...(chainMode ? { chainMode } : {}) };
  const backendConfig = {
    chainId: 31337n, vaultAddress: config.vaultAddress, rubaAddress: config.tokens.RUBA.address, usdtAddress: config.tokens.USDT.address,
    dbPath: ':memory:', rpcUrl: 'http://127.0.0.1:8545', operatorPrivateKey: operator.privateKey,
    deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n, host: '127.0.0.1', port: 3001, syncIntervalMs: 2000,
    ...(chainMode ? { chainMode } : {}),
  };
  const engine = new RubaEngine(backendConfig);
  for (const [id, account, token, amount] of [
    [1n, lp.address, 'RUBA', parseAmount('1000', 18)], [2n, lp.address, 'USDT', parseAmount('1000', 6)],
    [3n, trader.address, 'RUBA', parseAmount('100', 18)], [4n, trader.address, 'USDT', parseAmount('100', 6)],
  ]) engine.recordDeposit(id, account, token, amount);
  engine.addLiquidity(lp.address, parseAmount('1000', 18), parseAmount('1000', 6));
  const context = {
    account: trader.address, chainId: 31337n, allowed: true, paused: false,
    withdrawalsPaused: { RUBA: false, USDT: false }, dropNextPost: false,
    posts: [], requests: [], blocks: [], pendingRequests: [], transfers: [], approvals: [], used: new Set(), nextDeposit: 5n,
    pendingBlock: { number: null, hash: null, timestamp: '0x' + pendingTimestamp.toString(16) },
    walletBalances: { RUBA: parseAmount('1000', 18), USDT: parseAmount('1000', 6) },
    allowances: { RUBA: 0n, USDT: 0n },
    epoch: 1n, publicationResponse: { status: 'idle', request: null, progress: { collected: 0, required: 4 } },
    lastBatchId: 0n, lastTradeId: 0n, stateRoot: ZERO_ROOT, publishedBatches: new Map(), publicationCalls: [],
    publicationSendError: null, publicationWaitError: null, publicationWaitStatus: 1,
    publicationSkipCommit: false, publicationNeverMines: false, publicationCommitBeforeSendError: false,
    publicationCompetitorCommit: false,
    publicationHash: '0x' + '55'.repeat(32), publicationWaitArgs: [],
  };
  const provider = {
    async send(method, params) {
      if (method === 'eth_chainId') return '0x' + context.chainId.toString(16);
      if (method === 'eth_accounts') return [context.account];
      if (method === 'eth_getBlockByNumber') {
        assert.deepEqual(params, ['pending', false]);
        context.blocks.push('pending');
        context.pendingRequests.push(params);
        return context.pendingBlock;
      }
      throw new Error('Unexpected provider method');
    },
    async getBlock(tag) {
      assert.equal(tag, 'latest', 'pending blocks must use raw RPC because their number/hash can be null');
      context.blocks.push(tag);
      return { timestamp: Number(latestTimestamp) };
    },
  };
  const chain = {
    async sync() {}, async latestTimestamp() { return now; }, async publishPendingBatches() {},
    async assertNewActivity() {
      if (!context.allowed) throw new Error('Account is not whitelisted');
      if (context.paused) throw new Error('Market is paused');
    },
    async withdrawalContext(token) {
      if (context.withdrawalsPaused[token]) throw new Error('Withdrawals for this token are paused');
      return { signerEpoch: 1n, deadline: now + 900n };
    },
    async signWithdrawal(record) {
      assert.equal(engine.getWithdrawal(record.account, record.nonce).status, 'pending');
      const withdrawal = {
        account: record.account, token: config.tokens[record.token].address,
        amount: record.amount, nonce: record.nonce, deadline: record.deadline, signerEpoch: record.signerEpoch,
      };
      return { withdrawal, signature: await operator.signTypedData(withdrawalDomain(31337n, config.vaultAddress), WITHDRAWAL_TYPES, withdrawal) };
    },
    async expiryContext() { return { finalizedTimestamp: now + 901n, nonceUsed: false }; },
  };
  const api = new RubaApi(engine, chain, backendConfig);
  const fetchImpl = async (path, init = {}) => {
    context.requests.push(path);
    if (path === '/config') return { ok: true, status: 200, async json() { return wire(clientConfig); } };
    if (path === '/publication') return { ok: true, status: 200, async json() { return wire(context.publicationResponse); } };
    if (path.startsWith('/nonce?')) return { ok: true, status: 200, async json() { return { account: trader.address, nonce: engine.getActionNonce(trader.address).toString() }; } };
    assert.equal(path, '/actions');
    const request = JSON.parse(init.body);
    context.posts.push(request);
    let result;
    try { result = await api.execute(request); }
    catch (error) { return { ok: false, status: error.status ?? 400, async json() { return { error: error.message }; } }; }
    if (context.dropNextPost) { context.dropNextPost = false; throw new TypeError('Failed to fetch'); }
    return { ok: true, status: 200, async json() { return wire({ result }); } };
  };
  const tx = () => ({ async wait() { return { status: 1 }; } });
  const vault = {
    async ruba() { return config.tokens.RUBA.address; }, async usdt() { return config.tokens.USDT.address; },
    async whitelist() { return context.allowed; }, async marketPaused() { return context.paused; },
    async operator() { return operator.address; }, async signerEpoch() { return context.epoch; },
    async lastBatchId() { return context.lastBatchId; }, async lastTradeId() { return context.lastTradeId; },
    async stateRoot() { return context.stateRoot; }, async batches(batchId) { return context.publishedBatches.get(BigInt(batchId)); },
    async publishSignedBatch(batch, deadline, signerEpoch, signature) {
      context.publicationCalls.push({ account: context.account, batch: wire(batch), deadline, signerEpoch, signature });
      const commit = () => {
        context.lastBatchId = BigInt(batch.batchId);
        context.lastTradeId += BigInt(batch.tradeCount);
        context.stateRoot = batch.newStateRoot;
        context.publishedBatches.set(BigInt(batch.batchId), wire(batch));
      };
      if (context.publicationSendError) {
        if (context.publicationCommitBeforeSendError) commit();
        throw context.publicationSendError;
      }
      return {
        hash: context.publicationHash,
        async wait(...args) {
          context.publicationWaitArgs.push(args);
          if (context.publicationNeverMines) return new Promise(() => {});
          if (context.publicationCompetitorCommit || (!context.publicationSkipCommit && context.publicationWaitStatus === 1)) commit();
          if (context.publicationWaitError) throw context.publicationWaitError;
          return { status: context.publicationWaitStatus, hash: context.publicationHash };
        },
      };
    },
    async withdrawalsPaused(address) { return context.withdrawalsPaused[address === config.tokens.RUBA.address ? 'RUBA' : 'USDT']; },
    async usedWithdrawalNonces(account, nonce) { return context.used.has(`${account}:${nonce}`); },
    async deposit(address, amount) {
      const token = address === config.tokens.RUBA.address ? 'RUBA' : 'USDT';
      context.transfers.push(['deposit', token, amount]);
      context.walletBalances[token] -= amount;
      engine.recordDeposit(context.nextDeposit++, trader.address, token, amount);
      return tx();
    },
    async withdraw(withdrawal) {
      const token = withdrawal.token === config.tokens.RUBA.address ? 'RUBA' : 'USDT';
      context.transfers.push(['withdraw', token, BigInt(withdrawal.amount)]);
      context.used.add(`${withdrawal.account}:${withdrawal.nonce}`);
      context.walletBalances[token] += BigInt(withdrawal.amount);
      engine.settleWithdrawal(withdrawal.account, BigInt(withdrawal.nonce), token, BigInt(withdrawal.amount), `fixture:${withdrawal.nonce}`);
      return tx();
    },
  };
  const contractFactory = (address) => {
    if (address === config.vaultAddress) return vault;
    const token = address === config.tokens.RUBA.address ? 'RUBA' : 'USDT';
    return {
      async balanceOf() { return context.walletBalances[token]; },
      async allowance() { return context.allowances[token]; },
      async approve(_spender, amount) {
        context.approvals.push([token, amount]); context.allowances[token] = amount; return tx();
      },
    };
  };
  const options = { fetchImpl, contractFactory, onWalletStep };
  const client = new RubaClient(clientConfig, provider, trader, options);
  return { engine, context, provider, client, options, fetchImpl, close() { engine.close(); } };
}

function adminFixture(onWalletStep) {
  const hash = '0x' + 'ab'.repeat(32);
  const context = {
    owner: trader.address, account: trader.address, chain: '0x7a69', block: 1n,
    baseToken: config.tokens.RUBA.address,
    marketPaused: false, withdrawalsPaused: new Map(), whitelist: new Map(),
    writes: [], blockTags: [], wait: null,
  };
  const assertReadBlock = (block) => {
    assert.deepEqual(block, { blockTag: '0x' + context.block.toString(16) });
    context.blockTags.push(block.blockTag);
  };
  const write = (method, args, commit) => {
    context.writes.push([method, ...args]);
    return { hash, async wait(confirmations) {
      assert.equal(confirmations, 1);
      if (context.wait) return context.wait();
      commit();
      context.block++;
      return { status: 1, hash };
    } };
  };
  const provider = { async getBlock(tag) {
    assertReadBlock({ blockTag: tag });
    return { timestamp: 1000 };
  }, async send(method) {
    if (method === 'eth_chainId') return context.chain;
    if (method === 'eth_accounts') return [context.account];
    if (method === 'eth_blockNumber') return '0x' + context.block.toString(16);
    assert.fail(`Unexpected RPC method: ${method}`);
  } };
  const vault = {
    async owner(block) { assertReadBlock(block); return context.owner; },
    async ruba(block) { assertReadBlock(block); return context.baseToken; },
    async usdt(block) { assertReadBlock(block); return config.tokens.USDT.address; },
    async whitelist(address, block) { assertReadBlock(block); return context.whitelist.get(address) ?? false; },
    async marketPaused(block) { assertReadBlock(block); return context.marketPaused; },
    async withdrawalsPaused(token, block) { assertReadBlock(block); return context.withdrawalsPaused.get(token) ?? false; },
    async setWhitelist(address, allowed) { return write('setWhitelist', [address, allowed], () => context.whitelist.set(address, allowed)); },
    async setMarketPaused(paused) { return write('setMarketPaused', [paused], () => { context.marketPaused = paused; }); },
    async setTokenWithdrawalsPaused(token, paused) { return write('setTokenWithdrawalsPaused', [token, paused], () => context.withdrawalsPaused.set(token, paused)); },
  };
  const client = new RubaClient({ ...config, proofMode: 'zk' }, provider, trader, {
    publicationWaitMs: 15,
    onWalletStep,
    fetchImpl: async () => { assert.fail('Administration uses the selected Vault, not the API'); },
    contractFactory(address, _abi, signer) {
      assert.equal(signer, trader);
      return address === config.vaultAddress ? vault : {};
    },
  });
  return { client, context, hash, vault };
}

test('vault owner reads and updates whitelist and pauses on the selected Vault using the wallet', async () => {
  const { client, context, hash } = adminFixture();
  assert.deepEqual(await client.getAdminStatus(), {
    owner: trader.address, isOwner: true, marketPaused: false, withdrawalsPaused: { RUBA: false, USDT: false },
  });
  assert.equal(await client.getWhitelist(other.address), false);
  const progress = [];
  assert.deepEqual(await client.setWhitelist(other.address.toLowerCase(), true, (message) => progress.push(message)), { status: 'confirmed', transactionHash: hash });
  assert.match(progress[0], /кошельке/);
  assert.match(progress[1], /подтверждения/);
  assert.equal(await client.getWhitelist(other.address), true);
  assert.equal(context.blockTags.at(-1), '0x2', 'post-transaction reads use the newly mined block');
  assert.deepEqual(await client.setMarketPaused(true), { status: 'confirmed', transactionHash: hash });
  assert.deepEqual(await client.setTokenWithdrawalsPaused('USDT', true), { status: 'confirmed', transactionHash: hash });
  assert.deepEqual(await client.getAdminStatus(), {
    owner: trader.address, isOwner: true, marketPaused: true, withdrawalsPaused: { RUBA: false, USDT: true },
  });
  assert.deepEqual(await client.getMarketStatus({ fresh: true }), {
    whitelisted: false, marketPaused: true, withdrawalsPaused: { RUBA: false, USDT: true }, timestamp: 1_000n,
  });
  assert.deepEqual(context.writes, [
    ['setWhitelist', other.address, true], ['setMarketPaused', true], ['setTokenWithdrawalsPaused', config.tokens.USDT.address, true],
  ]);
});

test('readable vault administration rejects non-owners, wrong vaults and stale wallet context before sending', async () => {
  const { client, context } = adminFixture();
  context.owner = operator.address;
  assert.equal((await client.getAdminStatus()).isOwner, false);
  assert.equal(await client.getWhitelist(other.address), false, 'entry status is readable regardless of ownership');
  await assert.rejects(client.setWhitelist(other.address, true), /только владелец/);
  await assert.rejects(client.setMarketPaused(true), /только владелец/);
  await assert.rejects(client.setTokenWithdrawalsPaused('RUBA', true), /только владелец/);
  context.owner = trader.address;
  await assert.rejects(client.setWhitelist('oops', true), /Ethereum-адрес/);
  await assert.rejects(client.setWhitelist('0x' + '00'.repeat(20), false), /нулевого/);
  await assert.rejects(client.setMarketPaused('false'), /состояние настройки/);
  await assert.rejects(client.setTokenWithdrawalsPaused('WBTC', true), /Неизвестный токен/);
  context.baseToken = other.address;
  await assert.rejects(client.setMarketPaused(true), /токенов не совпадают/);
  context.baseToken = config.tokens.RUBA.address;
  await assert.rejects(client.setMarketPaused(true, () => { context.account = other.address; }), /Кошелёк изменился/);
  context.account = trader.address;
  await assert.rejects(client.setMarketPaused(true, () => { context.chain = '0x1'; }), /Сеть кошелька изменилась/);
  assert.deepEqual(context.writes, []);
});

test('vault admin updates distinguish pending, reverted and replaced transactions', async () => {
  const steps = [];
  const { client, context, hash, vault } = adminFixture((event) => steps.push(event));
  const replacementHash = '0x' + 'ef'.repeat(32);
  context.wait = () => new Promise(() => {});
  assert.deepEqual(await client.setMarketPaused(true), { status: 'submitted', transactionHash: hash });
  assert.equal(context.writes.length, 1, 'waiting must not retry a pending transaction');
  const transactionSteps = steps.filter((step) => step.kind === 'transaction');
  assert.deepEqual(transactionSteps.map((step) => step.phase), ['start', 'update', 'pending']);
  assert.equal(new Set(transactionSteps.map((step) => step.id)).size, 1);
  assert.match(transactionSteps.at(-1).detail, /Подтверждение пока не получено/);
  context.wait = () => ({ status: 1, hash: replacementHash });
  assert.deepEqual(await client.setMarketPaused(true), { status: 'submitted', transactionHash: hash });
  context.wait = () => ({ status: 0, hash });
  await assert.rejects(client.setMarketPaused(true), /Контракт отклонил/);
  context.wait = () => { throw Object.assign(new Error('replaced'), {
    code: 'TRANSACTION_REPLACED', reason: 'replaced', cancelled: true, receipt: { status: 1, hash: replacementHash },
  }); };
  await assert.rejects(client.setMarketPaused(true), /отменена или заменена/);
  context.wait = () => { throw Object.assign(new Error('repriced'), {
    code: 'TRANSACTION_REPLACED', reason: 'repriced', cancelled: false, replacement: { hash: replacementHash }, receipt: { status: 1, hash: replacementHash },
  }); };
  assert.deepEqual(await client.setMarketPaused(true), { status: 'confirmed', transactionHash: replacementHash });
  vault.setMarketPaused = async () => { throw Object.assign(new Error('wallet rejected'), { info: { error: { code: 4001 } } }); };
  await assert.rejects(client.setMarketPaused(true), (error) => error.code === 'ACTION_REJECTED');
  vault.setMarketPaused = async () => { throw Object.assign(new Error('lost send response'), { code: 'TIMEOUT' }); };
  await assert.rejects(client.setMarketPaused(true), /Результат транзакции неизвестен.*обновите настройки/);
  vault.setMarketPaused = async () => ({ async wait() { return null; } });
  await assert.rejects(client.setMarketPaused(true), /Результат транзакции неизвестен.*обновите настройки/);
  vault.setMarketPaused = async () => { throw Object.assign(new Error('wallet response lost'), { transactionHash: hash }); };
  assert.deepEqual(await client.setMarketPaused(true), { status: 'submitted', transactionHash: hash });
});

test('browser amounts keep full RUBA18/USDT6 precision and reject unsafe inputs', () => {
  assert.equal(parseAmount('0,000001', 6), 1n);
  assert.equal(parseAmount('.5', 18), 500_000_000_000_000_000n);
  const amount = '9007199254740993.123456789012345678';
  assert.equal(formatAmount(parseAmount(amount, 18), 18), amount);
  for (const text of ['-1', '1e6', 'Infinity', '', '0.0000001']) assert.throws(() => parseAmount(text, 6));
  assert.throws(() => parseAmount('0', 6));
  assert.equal(parseAmount('0', 6, { allowZero: true }), 0n);
  assert.equal(parseSlippage('0.5'), 50n);
  assert.equal(minimumOutput(90_661_089n, 50n), 90_207_783n);
  assert.equal(minimumOutput(1n, 50n), 1n, 'dust quotes never remove minimum-output protection');
  assert.throws(() => parseSlippage('5.01'));
  assert.throws(() => parseSlippage('0.001'));
});

test('browser canonical signing matches the server and concurrent private reads serialize nonces', async () => {
  const operation = { amountIn: '1000000', kind: 'quote', tokenIn: 'USDT' };
  assert.equal(keccak256(toUtf8Bytes(canonicalJson(operation))), operationHash(operation));
  assert.throws(() => canonicalJson({ kind: 'swap', amountIn: 1 }));
  const f = fixture();
  try {
    await loadConfig(f.fetchImpl);
    await Promise.all([f.client.getAccount(), f.client.signedAction(operation), f.client.getAccount()]);
    assert.deepEqual(f.context.posts.map((request) => request.intent.nonce), ['0', '1', '2']);
    assert.equal(f.engine.getActionNonce(trader.address), 3n);
    assert.equal(f.context.transfers.length, 0);
  } finally { f.close(); }
});

test('Tenderly signs against raw pending time with null block number/hash while withdrawal status keeps mined time', async () => {
  const latestTimestamp = now - 3_600n;
  const f = fixture({ chainMode: 'tenderly', latestTimestamp, pendingTimestamp: now });
  try {
    const loadedConfig = await loadConfig(f.fetchImpl);
    assert.equal(loadedConfig.chainMode, 'tenderly');
    const market = await f.client.getMarketStatus();
    assert.equal(market.timestamp, latestTimestamp, 'pending time must not mark withdrawals expired');
    const account = await f.client.getAccount();
    assert.equal(account.balances.USDT, parseAmount('100', 6).toString());
    assert.equal(f.context.posts[0].intent.deadline, (now + 600n).toString());
    assert.deepEqual(f.context.blocks, ['latest', 'pending']);
    assert.deepEqual(f.context.pendingRequests, [['pending', false]]);
    assert.equal(f.context.pendingBlock.number, null);
    assert.equal(f.context.pendingBlock.hash, null);
    assert.equal(f.engine.getActionNonce(trader.address), 1n, 'the real API must accept the signed action');
  } finally { f.close(); }
});

test('Tenderly rejects missing or malformed pending timestamps before posting a signed action', async () => {
  const f = fixture({ chainMode: 'tenderly' });
  try {
    for (const block of [null, {}, { timestamp: null }, { timestamp: Number(now) }, { timestamp: now.toString() }, { timestamp: '0xNaN' }]) {
      f.context.pendingBlock = block;
      await assert.rejects(f.client.getAccount(), /Не удалось прочитать время сети/);
    }
    assert.equal(f.context.posts.length, 0);
    assert.equal(f.engine.getActionNonce(trader.address), 0n);
  } finally { f.close(); }
});

test('ordinary RPC actions use latest time even when pending time differs', async () => {
  const f = fixture({ pendingTimestamp: now + 10_000n });
  try {
    await f.client.getAccount();
    assert.deepEqual(f.context.blocks, ['latest']);
    assert.equal(f.context.pendingRequests.length, 0);
    assert.equal(f.context.posts[0].intent.deadline, (now + 600n).toString());
    assert.equal(f.engine.getActionNonce(trader.address), 1n);
  } finally { f.close(); }
});

test('real browser signatures swap with server accounting and recover a payout without double debiting', async () => {
  const f = fixture();
  try {
    const custodyBefore = f.engine.snapshot().custody;
    const quote = await f.client.signedAction({ kind: 'quote', tokenIn: 'RUBA', amountIn: parseAmount('100', 18).toString() });
    const result = await f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: parseAmount('100', 18).toString(), minOut: minimumOutput(quote.amountOut, 50n).toString() });
    assert.equal(result.amountOut, '90661089');
    assert.deepEqual(f.engine.snapshot().custody, custodyBefore);
    assert.equal(f.context.transfers.length, 0, 'a server swap must not send ERC20 out of custody');
    const ticket = await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: parseAmount('10', 6).toString() });
    const balance = f.engine.accountSnapshot(trader.address).balances.USDT;
    const recovered = await f.client.signedAction({ kind: 'withdrawal', nonce: ticket.withdrawal.nonce });
    assert.equal(f.engine.accountSnapshot(trader.address).balances.USDT, balance);
    f.context.allowed = false;
    f.context.paused = true;
    await f.client.redeemWithdrawal(recovered);
    assert.equal(f.engine.getWithdrawal(trader.address, 0n).status, 'settled');
    assert.equal(f.context.transfers.length, 1);
    await assert.rejects(f.client.redeemWithdrawal(recovered), /AlreadyUsed/);
  } finally { f.close(); }
});

test('USDT deposit resets a nonzero allowance, approves only the amount, then deposits', async () => {
  const steps = [];
  const f = fixture({ onWalletStep: (event) => steps.push(event) });
  try {
    f.context.allowances.USDT = parseAmount('3', 6);
    await f.client.deposit('USDT', parseAmount('10', 6));
    assert.deepEqual(f.context.approvals, [['USDT', 0n], ['USDT', 10_000_000n]]);
    assert.deepEqual(f.context.transfers, [['deposit', 'USDT', 10_000_000n]]);
    assert.equal(f.engine.accountSnapshot(trader.address).balances.USDT, 110_000_000n);
    const transactionSteps = steps.filter((step) => step.kind === 'transaction');
    const starts = transactionSteps.filter((step) => step.phase === 'start');
    assert.deepEqual(starts.map((step) => step.title), [
      'Сбросить разрешение на перевод USDT', 'Разрешить перевод 10 USDT', 'Пополнить баланс обменника на 10 USDT',
    ]);
    assert.equal(new Set(starts.map((step) => step.id)).size, starts.length);
    for (const start of starts) assert.deepEqual(transactionSteps.filter((step) => step.id === start.id).map((step) => step.phase), ['start', 'update', 'done']);
    f.context.allowed = false;
    await assert.rejects(f.client.deposit('USDT', 1n), /whitelisted/);
    assert.equal(steps.at(-1).kind, 'check');
    assert.equal(steps.at(-1).phase, 'error');
    assert.equal(f.context.transfers.length, 1);
  } finally { f.close(); }
});

test('signature events bracket the wallet request and observer errors never change the signed action', async () => {
  const steps = [];
  const f = fixture();
  try {
    let rejectNext = false;
    const signer = {
      getAddress: () => trader.getAddress(),
      async signTypedData(...args) {
        assert.equal(steps.at(-1).phase, 'start');
        assert.equal(steps.at(-1).kind, 'signature');
        if (rejectNext) throw Object.assign(new Error('wallet rejected'), { code: 4001 });
        return trader.signTypedData(...args);
      },
    };
    const client = new RubaClient(config, f.provider, signer, { ...f.options, onWalletStep(event) {
      steps.push(event);
      throw new Error('test UI failure');
    } });
    await client.getAccount();
    rejectNext = true;
    await assert.rejects(client.signedAction({ kind: 'quote', tokenIn: 'RUBA', amountIn: '1' }), (error) => error.code === 4001);
    assert.deepEqual(steps.map((step) => [step.phase, step.title]), [
      ['start', 'Подписать запрос баланса'], ['done', 'Подписать запрос баланса'],
      ['start', 'Подписать запрос котировки'], ['error', 'Подписать запрос котировки'],
    ]);
    assert.equal(steps[0].id, steps[1].id);
    assert.equal(steps[2].id, steps[3].id);
    assert.notEqual(steps[0].id, steps[2].id);
    assert.equal(f.context.posts.length, 1);
  } finally { f.close(); }
});

test('account or network changes stop a signed action before it can be posted', async () => {
  const f = fixture();
  try {
    f.context.chainId = 1n;
    await assert.rejects(f.client.getAccount(), /Сеть/);
    f.context.chainId = 31337n;
    const changingSigner = {
      async getAddress() { return trader.address; },
      async signTypedData(...args) { const signature = await trader.signTypedData(...args); f.context.account = other.address; return signature; },
    };
    const client = new RubaClient(config, f.provider, changingSigner, f.options);
    await assert.rejects(client.getAccount(), /Кошелёк изменился/);
    assert.equal(f.context.posts.length, 0);
    assert.equal(f.engine.getActionNonce(trader.address), 0n);
  } finally { f.close(); }
});

test('payout tampering and token pauses are rejected before requesting an onchain transaction', async () => {
  const f = fixture();
  try {
    const ticket = await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '1000000' });
    await assert.rejects(f.client.redeemWithdrawal({ ...ticket, withdrawal: { ...ticket.withdrawal, account: other.address } }), /другому кошельку/);
    await assert.rejects(f.client.redeemWithdrawal({ ...ticket, withdrawal: { ...ticket.withdrawal, amount: '2000000' } }), /Подпись/);
    f.context.withdrawalsPaused.USDT = true;
    await assert.rejects(f.client.redeemWithdrawal(ticket), /paused/);
    assert.equal(f.context.transfers.length, 0);
    assert.equal(f.engine.getWithdrawal(trader.address, 0n).status, 'pending');
  } finally { f.close(); }
});

test('lost POST response never retries a committed swap and warns that its result is uncertain', async () => {
  const f = fixture();
  try {
    f.context.dropNextPost = true;
    await assert.rejects(f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: parseAmount('10', 18).toString(), minOut: '1' }), (error) => {
      assert.equal(error.uncertain, true);
      assert.match(errorMessage(error), /могло быть выполнено/);
      return true;
    });
    assert.equal(f.context.posts.length, 1);
    assert.equal(f.engine.getReceipt(1n).tradeId, 1n);
    assert.equal(f.engine.getReceipt(2n), undefined);
    const account = await f.client.getAccount();
    assert.equal(account.balances.RUBA, parseAmount('90', 18).toString());
  } finally { f.close(); }
});

test('disclosure export requests the selected own trade and rejects owner, domain and batch substitutions', async () => {
  const f = fixture();
  try {
    const original = {
      format: 'ruba-trade-disclosure', version: 1,
      receipt: { account: trader.address, tradeId: '7', batchId: '3', chainId: config.chainId, vault: config.vaultAddress },
      batch: { batchId: '3', receiptsRoot: '0x' + '12'.repeat(32) }, tokens: config.tokens,
    };
    let response = structuredClone(original);
    const operations = [];
    f.client.signedAction = async (operation) => { operations.push(operation); return response; };
    const bundle = await f.client.getDisclosure('7');
    assert.deepEqual(operations, [{ kind: 'disclosure', tradeId: '7' }]);
    assert.deepEqual(bundle, original);
    await assert.rejects(f.client.getDisclosure('0'), /положительный/);
    await assert.rejects(f.client.getDisclosure('1.5'), /Некорректная/);

    for (const [key, value, pattern] of [
      ['account', other.address, /другому кошельку/],
      ['tradeId', '8', /другую сделку/],
      ['chainId', '1', /другой сети/],
      ['vault', other.address, /другой сети/],
      ['batchId', '4', /другому пакету/],
    ]) {
      response = structuredClone(original);
      response.receipt[key] = value;
      await assert.rejects(f.client.getDisclosure('7'), pattern);
    }
    response = structuredClone(original);
    response.batch.stateSnapshot = 'private global ledger';
    await assert.rejects(f.client.getDisclosure('7'), /лишние приватные/);
    response = { format: 'unknown' };
    await assert.rejects(f.client.getDisclosure('7'), /некорректную квитанцию/);
    assert.equal(f.context.transfers.length, 0);
  } finally { f.close(); }
});

test('own disclosure export uses the real signed API and includes only the selected receipt and public batch', async () => {
  const f = fixture();
  try {
    const receipt = await f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: parseAmount('10', 18).toString(), minOut: '1' });
    assert.equal(receipt.batchId, undefined);
    assert.deepEqual(receipt.publication, { status: 'collecting', collected: 1, required: 4 });
    const pendingNonce = f.engine.getActionNonce(trader.address);
    await assert.rejects(f.client.getDisclosure(receipt.tradeId), (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /1 из 4/);
      return true;
    });
    assert.equal(f.engine.getActionNonce(trader.address), pendingNonce, 'a collecting receipt does not consume the disclosure nonce');
    for (let trade = 2; trade <= 4; trade += 1) {
      await f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: parseAmount('1', 18).toString(), minOut: '1' });
    }
    const beforeNonce = f.engine.getActionNonce(trader.address);
    const bundle = await f.client.getDisclosure(receipt.tradeId);
    assert.equal(bundle.receipt.account, trader.address);
    assert.equal(bundle.receipt.tradeId, receipt.tradeId);
    assert.equal(bundle.receipt.amountOut, receipt.amountOut);
    assert.equal(bundle.receipt.batchId, bundle.batch.batchId);
    assert.equal(bundle.receipt.proof.length, 2);
    assert.notEqual(bundle.batch.receiptsRoot, bundle.receipt.leaf);
    assert.equal(bundle.batch.tradeCount, '4');
    assert.equal(bundle.tokens.RUBA.address, config.tokens.RUBA.address);
    assert.equal(bundle.tokens.USDT.decimals, 6);
    assert.equal(Object.hasOwn(bundle.batch, 'stateSnapshot'), false);
    assert.equal(Object.hasOwn(bundle.batch, 'stateSalt'), false);
    assert.equal(f.engine.getActionNonce(trader.address), beforeNonce + 1n);
    assert.equal(f.context.posts.at(-1).operation.kind, 'disclosure');
    assert.equal(f.context.transfers.length, 0);
  } finally { f.close(); }
});

async function publicationFixture() {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.engine.swap(trader.address, 'RUBA', parseAmount('1', 18), 1n);
  const stored = f.engine.getBatch(1n);
  const batch = Object.fromEntries(['batchId', 'previousStateRoot', 'newStateRoot', 'receiptsRoot', 'firstTradeId', 'tradeCount'].map((field) => [field, stored[field]]));
  const deadline = now + 600n;
  const signerEpoch = 1n;
  const signature = await operator.signTypedData(withdrawalDomain(31337n, config.vaultAddress), BATCH_PUBLICATION_TYPES, { ...batch, deadline, signerEpoch });
  const ticket = wire({ chainId: 31337n, vault: config.vaultAddress, batch, deadline, signerEpoch, signature });
  f.context.publicationResponse = { status: 'ready', request: ticket, progress: { collected: 4, required: 4 } };
  return { ...f, ticket, receipt: wire(f.engine.getReceipt(4n)) };
}

test('publication request is a public read and does not consume a signed-action nonce', async () => {
  const f = await publicationFixture();
  try {
    assert.deepEqual(await f.client.getPublicationRequest(), f.context.publicationResponse);
    assert.deepEqual(f.context.requests, ['/publication']);
    assert.equal(f.context.posts.length, 0);
    assert.equal(f.engine.getActionNonce(trader.address), 0n);
    f.context.publicationResponse = { status: 'waiting', request: null, progress: { collected: 0, required: 4 } };
    assert.equal((await f.client.getPublicationRequest()).status, 'waiting');
    f.context.publicationResponse = { status: 'idle', request: null, progress: { collected: 2, required: 4 } };
    assert.equal((await f.client.getPublicationRequest()).progress.collected, 2);
    f.context.publicationResponse.progress.required = 3;
    await assert.rejects(f.client.getPublicationRequest(), /некорректный статус/);
  } finally { f.close(); }
});

test('the user publishes a real operator-signed batch and identical retries never send another transaction', async () => {
  const f = await publicationFixture();
  try {
    const messages = [];
    const result = await f.client.publishBatch(f.ticket, (message) => messages.push(message), f.receipt);
    assert.deepEqual(result, { status: 'published', transactionHash: f.context.publicationHash });
    assert.equal(f.context.publicationCalls.length, 1);
    assert.equal(f.context.publicationCalls[0].account, trader.address);
    assert.notEqual(f.context.publicationCalls[0].account, operator.address);
    assert.deepEqual(f.context.publicationCalls[0].batch, f.ticket.batch);
    assert.deepEqual(f.context.publicationWaitArgs, [[1, 45_000]]);
    assert.ok(messages.some((message) => /Газ оплачивается вашим кошельком/.test(message)));
    assert.equal(await f.client.batchAlreadyPublished(f.ticket.batch), true);
    assert.deepEqual(await f.client.publishBatch(f.ticket), { status: 'already-published' });
    assert.equal(f.context.publicationCalls.length, 1);
    assert.equal(f.context.transfers.length, 0, 'publishing a root does not transfer ERC20');
    assert.equal(f.engine.getReceipt(4n).tradeId, 4n, 'publication must not repeat a swap');
  } finally { f.close(); }
});

test('publication rejects tampered signed fields, domains and receipt substitutions before the wallet spends gas', async () => {
  const f = await publicationFixture();
  try {
    for (const [field, value] of [
      ['newStateRoot', '0x' + '12'.repeat(32)], ['receiptsRoot', '0x' + '34'.repeat(32)],
      ['firstTradeId', '2'], ['batchId', '2'], ['previousStateRoot', '0x' + '56'.repeat(32)], ['tradeCount', '3'],
    ]) {
      const ticket = structuredClone(f.ticket); ticket.batch[field] = value;
      await assert.rejects(f.client.publishBatch(ticket));
    }
    for (const [field, value] of [['chainId', '1'], ['vault', other.address], ['signature', '0x'], ['signature', '0x' + 'ab'.repeat(64)], ['deadline', Number(now + 600n)]]) {
      const ticket = { ...f.ticket, [field]: value };
      await assert.rejects(f.client.publishBatch(ticket));
    }
    const receipt = { ...f.receipt, amountIn: (BigInt(f.receipt.amountIn) + 1n).toString() };
    await assert.rejects(f.client.publishBatch(f.ticket, () => {}, receipt), /Квитанция вашей сделки/);
    await assert.rejects(f.client.publishBatch(f.ticket, () => {}, { ...f.receipt, account: other.address }), /Квитанция вашей сделки/);
    const wrongSigner = await other.signTypedData(withdrawalDomain(31337n, config.vaultAddress), BATCH_PUBLICATION_TYPES, {
      ...f.ticket.batch, deadline: f.ticket.deadline, signerEpoch: f.ticket.signerEpoch,
    });
    await assert.rejects(f.client.publishBatch({ ...f.ticket, signature: wrongSigner }), /Подпись оператора/);
    assert.equal(f.context.publicationCalls.length, 0);
  } finally { f.close(); }
});

test('expired, rotated and stale publication requests are rejected before requesting a transaction', async () => {
  const f = await publicationFixture();
  try {
    await assert.rejects(f.client.publishBatch({ ...f.ticket, deadline: (now - 1n).toString() }), /Срок публикации истёк/);
    f.context.epoch = 2n;
    await assert.rejects(f.client.publishBatch(f.ticket), /Эпоха подписи/);
    f.context.epoch = 1n;
    f.context.stateRoot = '0x' + 'ab'.repeat(32);
    await assert.rejects(f.client.publishBatch(f.ticket), /Состояние публикации устарело/);
    f.context.lastBatchId = 1n;
    f.context.publishedBatches.set(1n, { ...f.ticket.batch, newStateRoot: '0x' + 'cd'.repeat(32) });
    await assert.rejects(f.client.publishBatch(f.ticket), /уже записан другой пакет/);
    assert.equal(f.context.publicationCalls.length, 0);
  } finally { f.close(); }
});

test('a wallet context change or explicit rejection does not become an unknown publication or send automatically', async () => {
  const f = await publicationFixture();
  try {
    await assert.rejects(f.client.publishBatch(f.ticket, () => { f.context.account = other.address; }), /Кошелёк изменился/);
    assert.equal(f.context.publicationCalls.length, 0);
    f.context.account = trader.address;
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
    f.context.publicationSendError = rejection;
    await assert.rejects(f.client.publishBatch(f.ticket), (error) => error === rejection);
    assert.equal(f.context.publicationCalls.length, 1);
    f.context.publicationSendError = Object.assign(new Error('wrapped rejection'), { code: 'UNKNOWN_ERROR', info: { error: { code: 4001 } } });
    await assert.rejects(f.client.publishBatch(f.ticket), (error) => error.code === 'ACTION_REJECTED');
    assert.equal(f.context.publicationCalls.length, 2);
    assert.equal(f.context.lastBatchId, 0n);
  } finally { f.close(); }
});

test('a lost send response returns unknown publication without repeating either the send or the swap', async () => {
  const f = await publicationFixture();
  try {
    f.context.publicationSendError = Object.assign(new Error('RPC disconnected'), { code: 'NETWORK_ERROR', transactionHash: f.context.publicationHash });
    const result = await f.client.publishBatch(f.ticket);
    assert.deepEqual(result, { status: 'submitted', transactionHash: f.context.publicationHash });
    assert.equal(f.context.publicationCalls.length, 1);
    assert.equal(f.context.publicationWaitArgs.length, 0);
    assert.equal(f.engine.getReceipt(5n), undefined);
    assert.equal(f.context.lastBatchId, 0n);
  } finally { f.close(); }
});

test('a matching contract state after a lost receipt confirms the batch without attributing a transaction', async () => {
  const f = await publicationFixture();
  try {
    f.context.publicationWaitError = Object.assign(new Error('connection lost'), { code: 'NETWORK_ERROR' });
    const result = await f.client.publishBatch(f.ticket);
    assert.deepEqual(result, { status: 'already-published' });
    assert.equal(f.context.publicationCalls.length, 1);
  } finally { f.close(); }
});

test('a competing payer publishing during a reverted or cancelled user transaction never attributes the failed hash', async () => {
  for (const error of [
    Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION', receipt: { status: 0, hash: '0x' + '66'.repeat(32) } }),
    Object.assign(new Error('cancelled'), { code: 'TRANSACTION_REPLACED', cancelled: true,
      receipt: { status: 1, hash: '0x' + '77'.repeat(32) }, replacement: { hash: '0x' + '77'.repeat(32) } }),
  ]) {
    const f = await publicationFixture();
    try {
      f.context.publicationWaitStatus = 0;
      f.context.publicationCompetitorCommit = true;
      f.context.publicationWaitError = error;
      assert.deepEqual(await f.client.publishBatch(f.ticket), { status: 'already-published' });
      assert.equal(f.context.publicationCalls.length, 1);
      assert.equal(await f.client.batchAlreadyPublished(f.ticket.batch), true);
    } finally { f.close(); }
  }
});

test('a lost send response with a fake hash cannot attribute an independently published batch', async () => {
  const f = await publicationFixture();
  try {
    f.context.publicationSendError = Object.assign(new Error('connection lost'), {
      code: 'NETWORK_ERROR', transactionHash: '0x' + '99'.repeat(32),
    });
    f.context.publicationCommitBeforeSendError = true;
    assert.deepEqual(await f.client.publishBatch(f.ticket), { status: 'already-published' });
    assert.equal(f.context.publicationCalls.length, 1);
    assert.equal(f.context.publicationWaitArgs.length, 0);
  } finally { f.close(); }
});

test('a success receipt without matching contract state never reports publication and waiting is bounded', async () => {
  const f = await publicationFixture();
  try {
    f.context.publicationSkipCommit = true;
    assert.equal((await f.client.publishBatch(f.ticket)).status, 'submitted');
    f.context.publicationNeverMines = true;
    f.client.publicationWaitMs = 5;
    const before = Date.now();
    const result = await f.client.publishBatch(f.ticket);
    assert.equal(result.status, 'submitted');
    assert.ok(Date.now() - before < 2000);
    assert.equal(f.context.publicationCalls.length, 2, 'one send for each explicit user attempt, no internal retries');
    assert.equal(f.context.lastBatchId, 0n);
  } finally { f.close(); }
});

test('a mined failure and cancelled replacement are reported as failures while the swap remains durable', async () => {
  const f = await publicationFixture();
  try {
    f.context.publicationWaitStatus = 0;
    await assert.rejects(f.client.publishBatch(f.ticket), /Транзакция публикации отклонена/);
    f.context.publicationWaitStatus = 1;
    f.context.publicationSkipCommit = true;
    f.context.publicationWaitError = Object.assign(new Error('cancelled'), { code: 'TRANSACTION_REPLACED', cancelled: true, receipt: { status: 1 } });
    await assert.rejects(f.client.publishBatch(f.ticket), (error) => error.code === 'ACTION_REJECTED');
    assert.equal(f.engine.getReceipt(4n).tradeId, 4n);
    assert.equal(f.engine.getReceipt(5n), undefined);
  } finally { f.close(); }
});

test('generic token metadata accepts WETH18/WBTC8 and checks actual ERC20 decimals before operations', async () => {
  const changed = structuredClone(config);
  changed.tokens.RUBA.symbol = 'WETH'; changed.tokens.USDT.symbol = 'WBTC'; changed.tokens.USDT.decimals = 8;
  const result = await loadConfig(async () => ({ ok: true, async json() { return changed; } }));
  assert.equal(result.tokens.USDT.decimals, 8);
  const f = fixture();
  try {
    f.client.config = result;
    f.client.tokens.RUBA.decimals = async () => 18;
    f.client.tokens.USDT.decimals = async () => 8;
    await f.client.getMarketStatus();
    f.client.tokens.USDT.decimals = async () => 6;
    await assert.rejects(f.client.getMarketStatus(), /Точность токена/);
    assert.equal(f.context.posts.length, 0);
  } finally { f.close(); }
});

test('switching away while a wallet signature is pending disposes the old client before any HTTP mutation', async () => {
  const f = fixture();
  try {
    const original = f.client.signer.signTypedData.bind(f.client.signer);
    f.client.signer.signTypedData = async (...args) => { f.client.dispose(); return original(...args); };
    await assert.rejects(f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: '100', minOut: '1' }), /рынок изменился/);
    assert.equal(f.context.posts.length, 0);
    assert.equal(f.context.transfers.length, 0);
  } finally { f.close(); }
});

test('two market clients keep independent API nonce, balances, signing domains and recovery namespaces', async () => {
  const configs = [config, { ...config, vaultAddress: getAddress('0x' + '05'.repeat(20)) }];
  const ids = ['ruba-usdt', 'weth-wbtc'];
  const nonces = [0, 0]; const posted = [];
  const provider = { async send(method) { return method === 'eth_chainId' ? '0x7a69' : [trader.address]; }, async getBlock() { return { timestamp: Number(now) }; } };
  const fetch = async (path, init) => {
    const index = ids.findIndex((id) => path.startsWith(`/markets/${id}/`)); assert.ok(index >= 0);
    if (path.includes('/nonce?')) return { ok: true, async json() { return { account: trader.address, nonce: String(nonces[index]) }; } };
    assert.equal(path, `/markets/${ids[index]}/actions`);
    const body = JSON.parse(init.body); assert.equal(body.intent.nonce, String(nonces[index]++)); posted.push({ index, body });
    return { ok: true, async json() { return { result: { balances: { RUBA: String(index + 1), USDT: String(index + 10) } } }; } };
  };
  const clients = configs.map((cfg, index) => new RubaClient(cfg, provider, trader, { fetchImpl: scopedMarketFetch(ids[index], fetch), contractFactory: () => ({}) }));
  const balances = await Promise.all(clients.map((client) => client.getAccount()));
  assert.deepEqual(balances.map((snapshot) => snapshot.balances.RUBA), ['1', '2']);
  assert.deepEqual(posted.map((post) => post.body.intent.nonce), ['0', '0']);
  assert.notEqual(await clients[0].recoveryStorageKey(), await clients[1].recoveryStorageKey());
  for (const { index, body } of posted) assert.equal(verifyTypedData({ name: 'RubaServer', version: '1', chainId: 31337n, verifyingContract: configs[index].vaultAddress },
    { Action: [{ name: 'account', type: 'address' }, { name: 'actionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, body.intent, body.signature), trader.address);
});

test('faucet mints only the selected wallet token with no allowance, Vault deposit or signed API request', async () => {
  const steps = [];
  const f = fixture({ onWalletStep: (event) => steps.push(event) });
  try {
    let calls = 0; let next = now - 1n;
    f.client.tokens.USDT.nextFaucetAt = async (account) => { assert.equal(account, trader.address); return next; };
    f.client.tokens.USDT.FAUCET_AMOUNT = async () => 10000n * 10n ** 6n;
    f.client.tokens.USDT.faucet = async (...args) => { calls++; assert.equal(args.length, 0); return { async wait() { return { status: 1 }; } }; };
    assert.equal((await f.client.faucet('USDT')).amount, 10000n * 10n ** 6n);
    assert.equal(calls, 1); assert.equal(f.context.approvals.length, 0); assert.equal(f.context.transfers.length, 0); assert.equal(f.context.posts.length, 0);
    next = now + 60n;
    await assert.rejects(f.client.faucet('USDT'), /60 секунд/);
    assert.equal(calls, 1);
    assert.deepEqual(steps.filter((step) => step.kind === 'transaction').map((step) => [step.phase, step.title]), [
      ['start', 'Получить тестовые USDT на кошелёк'], ['update', 'Получить тестовые USDT на кошелёк'], ['done', 'Получить тестовые USDT на кошелёк'],
    ]);
    assert.equal(steps.at(-1).phase, 'error');
  } finally { f.close(); }
});
