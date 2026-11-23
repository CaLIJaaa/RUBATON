import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TypedDataEncoder, Wallet, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { ACTION_TYPES, BATCH_PUBLICATION_TYPEHASH, BATCH_PUBLICATION_TYPES, actionDomain, batchPublicationDomain, operationHash, verifyAction, uint } from '../auth.ts';
import { RubaApi, validateOperation } from '../api.ts';
import type { ActionRequest, Operation } from '../api.ts';
import { RubaEngine } from '../engine.ts';
import type { ServerConfig } from '../config.ts';
import type { VaultChain } from '../chain.ts';

const user = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
const vault = '0x0000000000000000000000000000000000000001';
const ruba = '0x0000000000000000000000000000000000000002';
const usdt = '0x0000000000000000000000000000000000000003';
const now = 1_800_000_000n;

async function signed(operation: Operation, nonce = 0n, signer = user): Promise<ActionRequest> {
  const intent = { account: signer.address, actionHash: operationHash(operation), nonce: nonce.toString(), deadline: (now + 600n).toString() };
  return { intent, operation, signature: await signer.signTypedData(actionDomain(31337n, vault), ACTION_TYPES, intent) };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-auth-'));
  const config: ServerConfig = {
    rpcUrl: 'http://127.0.0.1:8545', chainId: 31337n, vaultAddress: vault, rubaAddress: ruba, usdtAddress: usdt,
    operatorPrivateKey: '0x' + '33'.repeat(32), deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n,
    dbPath: join(directory, 'ledger.sqlite'), host: '127.0.0.1', port: 3001, syncIntervalMs: 2000,
  };
  const engine = new RubaEngine(config);
  const state = { allowed: true, paused: false, syncs: 0, signatures: 0 };
  const fakeChain = {
    async sync() { state.syncs++; }, async latestTimestamp() { return now; },
    async assertNewActivity() { if (!state.allowed) throw new Error('Account is not whitelisted'); if (state.paused) throw new Error('Market is paused'); },
    async withdrawalContext() { return { signerEpoch: 1n, deadline: now + 900n }; },
    async signWithdrawal(record: { account: string; nonce: bigint }) {
      assert.equal(engine.getWithdrawal(record.account, record.nonce)?.status, 'pending', 'reservation must be durable before signing');
      state.signatures++;
      return { withdrawal: record, signature: 'fixture-signature' };
    },
    async expiryContext() { return { finalizedTimestamp: now + 901n, nonceUsed: false }; },
    async publishPendingBatches() {},
  } as unknown as VaultChain;
  const api = new RubaApi(engine, fakeChain, config);
  return { api, engine, config, state, close() { engine.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('canonical operation signing is key-order-independent and rejects ambiguous amounts', async () => {
  assert.equal(operationHash({ kind: 'quote', tokenIn: 'RUBA', amountIn: '100' }), operationHash({ amountIn: '100', tokenIn: 'RUBA', kind: 'quote' }));
  for (const value of [100, '-1', '01', '1e18', '1.0', '', (1n << 256n).toString()]) assert.throws(() => uint(value, 'amount'));
  assert.throws(() => validateOperation({ kind: 'withdraw', token: 'RUBA', amount: '100', recipient: other.address }));
  assert.throws(() => validateOperation({ kind: '__proto__' }));
});

test('signature binds operation, account, chain, vault and deadline', async () => {
  const request = await signed({ kind: 'withdraw', token: 'USDT', amount: '100' });
  assert.equal(verifyAction(31337n, vault, request.intent, request.operation, request.signature, now), user.address);
  assert.throws(() => verifyAction(31337n, vault, request.intent, { kind: 'withdraw', token: 'USDT', amount: '101' }, request.signature, now));
  assert.throws(() => verifyAction(1n, vault, request.intent, request.operation, request.signature, now));
  assert.throws(() => verifyAction(31337n, ruba, request.intent, request.operation, request.signature, now));
  assert.throws(() => verifyAction(31337n, vault, { ...request.intent, account: other.address }, request.operation, request.signature, now));
  assert.throws(() => verifyAction(31337n, vault, request.intent, request.operation, request.signature, now + 601n), /expired/);
});

test('batch-publication authorization binds all public fields, expiry, epoch, chain and Vault', async () => {
  const value = {
    batchId: 1n, previousStateRoot: '0x' + '00'.repeat(32), newStateRoot: '0x' + '11'.repeat(32), receiptsRoot: '0x' + '22'.repeat(32),
    firstTradeId: 1n, tradeCount: 4n, deadline: now + 600n, signerEpoch: 3n,
  };
  assert.equal(BATCH_PUBLICATION_TYPEHASH, keccak256(toUtf8Bytes(TypedDataEncoder.from(BATCH_PUBLICATION_TYPES).encodeType('BatchPublication'))));
  const domain = batchPublicationDomain(31337n, vault);
  const signature = await other.signTypedData(domain, BATCH_PUBLICATION_TYPES, value);
  assert.equal(verifyTypedData(domain, BATCH_PUBLICATION_TYPES, value, signature), other.address);
  for (const key of Object.keys(value) as (keyof typeof value)[]) {
    const original = value[key];
    const changed = typeof original === 'bigint' ? original + 1n : '0x' + 'ff'.repeat(32);
    assert.notEqual(verifyTypedData(domain, BATCH_PUBLICATION_TYPES, { ...value, [key]: changed }, signature), other.address, `${key} must be signed`);
  }
  for (const changedDomain of [batchPublicationDomain(1n, vault), batchPublicationDomain(31337n, ruba), { ...domain, name: 'RubaServer' }]) {
    assert.notEqual(verifyTypedData(changedDomain, BATCH_PUBLICATION_TYPES, value, signature), other.address);
  }
});

test('API authenticates account reads, rejects nonce replay and rolls back nonce with failed ledger action', async () => {
  const f = fixture();
  try {
    const request = await signed({ kind: 'account' });
    const result = await f.api.execute(request) as { account: string };
    assert.equal(result.account.toLowerCase(), user.address.toLowerCase());
    await assert.rejects(f.api.execute(request), /nonce/);
    const invalid = await signed({ kind: 'withdraw', token: 'USDT', amount: '1' }, 1n);
    await assert.rejects(f.api.execute(invalid), /balance|funds/i);
    assert.equal(f.engine.getActionNonce(user.address), 1n);
    assert.equal(f.state.signatures, 0);
    assert.equal('operatorPrivateKey' in f.api.publicConfig(), false);
  } finally { f.close(); }
});

test('proven-withdrawal API rejects refund requests before any ledger or chain mutation', async () => {
  const f = fixture();
  try {
    f.config.proofMode = 'zk';
    const before = f.engine.snapshot();
    const request = await signed({ kind: 'expireWithdrawal', nonce: '0' });
    await assert.rejects(f.api.execute(request), /Proven withdrawals do not expire or refund/);
    assert.deepEqual(f.engine.snapshot(), before);
    assert.equal(f.engine.getActionNonce(user.address), 0n);
    assert.equal(f.state.signatures, 0);
    assert.equal(f.state.syncs, 0);
    const config = f.api.publicConfig();
    assert.equal(config.withdrawalMode, 'proven-reservation-v1');
    assert.equal(config.publicationAuthorization, 'proof-only');
    assert.equal('operatorPrivateKey' in config, false);
  } finally { f.close(); }
});

test('internal worker guard rejects a stale plan without consuming funds or the action nonce', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, user.address, 'USDT', 1000n);
    const before = f.engine.snapshot();
    const request = await signed({ kind: 'withdraw', token: 'USDT', amount: '100' });
    await assert.rejects(f.api.execute(request, { beforeApply: () => { throw new Error('worker plan revision changed'); } }), /revision changed/);
    assert.deepEqual(f.engine.snapshot(), before);
    assert.equal(f.engine.getActionNonce(user.address), 0n);
    assert.equal(f.state.signatures, 0);
  } finally { f.close(); }
});

test('worker step identity is committed or rolled back with its economic operation', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, user.address, 'USDT', 1000n);
    const request = await signed({ kind: 'withdraw', token: 'USDT', amount: '100' });
    await assert.rejects(f.api.execute(request, { onCommit: () => {
      f.engine.setMetadata('worker-step:test', 'committed');
      throw new Error('step checkpoint failed');
    } }), /checkpoint failed/);
    assert.equal(f.engine.getMetadata('worker-step:test'), undefined);
    assert.equal(f.engine.accountSnapshot(user.address).balances.USDT, 1000n);
    assert.equal(f.engine.getActionNonce(user.address), 0n);
    await f.api.execute(request, { onCommit: () => { f.engine.setMetadata('worker-step:test', 'committed'); } });
    assert.equal(f.engine.getMetadata('worker-step:test'), 'committed');
    assert.equal(f.engine.accountSnapshot(user.address).balances.USDT, 900n);
    assert.equal(f.engine.getActionNonce(user.address), 1n);
  } finally { f.close(); }
});

test('withdrawal reservation is signed after commit and recovery does not debit twice', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, user.address, 'USDT', 100n);
    await f.api.execute(await signed({ kind: 'withdraw', token: 'USDT', amount: '60' }));
    assert.equal(f.engine.accountSnapshot(user.address).balances.USDT, 40n);
    await f.api.execute(await signed({ kind: 'withdrawal', nonce: '0' }, 1n));
    assert.equal(f.engine.accountSnapshot(user.address).balances.USDT, 40n);
    assert.equal(f.state.signatures, 2);
    assert.equal(f.engine.getWithdrawal(user.address, 0n)?.amount, 60n);
  } finally { f.close(); }
});

test('revocation or market pause prevents trading but allows existing balance withdrawal and LP exit', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, user.address, 'RUBA', 1_000_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, user.address, 'USDT', 10_000n * 10n ** 6n);
    const liquidity = f.engine.addLiquidity(user.address, 500_000n * 10n ** 18n, 5_000n * 10n ** 6n);
    f.state.allowed = false;
    await assert.rejects(f.api.execute(await signed({ kind: 'swap', tokenIn: 'RUBA', amountIn: '100', minOut: '0' })), /whitelisted/);
    assert.equal(f.engine.getActionNonce(user.address), 0n);
    f.state.allowed = true;
    f.state.paused = true;
    await assert.rejects(f.api.execute(await signed({ kind: 'quote', tokenIn: 'RUBA', amountIn: '100' })), /paused/);
    f.state.allowed = false;
    await f.api.execute(await signed({ kind: 'removeLiquidity', shares: (liquidity.shares / 2n).toString(), rubaMin: '0', usdtMin: '0' }));
    await f.api.execute(await signed({ kind: 'withdraw', token: 'USDT', amount: '100' }, 1n));
    assert.equal(f.state.signatures, 1);
  } finally { f.close(); }
});

test('trade receipt is available only to its signed owner', async () => {
  const f = fixture();
  try {
    f.engine.recordDeposit(1n, user.address, 'RUBA', 1_000n * 10n ** 18n);
    f.engine.recordDeposit(2n, user.address, 'USDT', 1_000n * 10n ** 6n);
    f.engine.addLiquidity(user.address, 500n * 10n ** 18n, 500n * 10n ** 6n);
    f.engine.swap(user.address, 'RUBA', 10n ** 18n, 0n);
    await assert.rejects(f.api.execute(await signed({ kind: 'receipt', tradeId: '1' }, 0n, other)), /Квитанция не найдена/);
    const receipt = await f.api.execute(await signed({ kind: 'receipt', tradeId: '1' })) as { account: string };
    assert.equal(receipt.account.toLowerCase(), user.address.toLowerCase());
  } finally { f.close(); }
});
