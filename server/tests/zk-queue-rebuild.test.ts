import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { ZkRubaEngine } from '../zk/engine.ts';
import type { QueueRule } from '../zk/engine.ts';
import { randomField } from '../../zk/crypto.js';

const user = new Wallet('0x' + '11'.repeat(32));
const trader = new Wallet('0x' + '22'.repeat(32));
const operator = new Wallet('0x' + '33'.repeat(32));
const vault = '0x0000000000000000000000000000000000000001';
const ruba = '0x0000000000000000000000000000000000000002';
const usdt = '0x0000000000000000000000000000000000000003';
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const types = { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] };
const CLAIM_DEADLINE = (1n << 64n) - 1n;
const RUBA = 10n ** 18n;
const USDT = 10n ** 6n;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-zk-rebuild-'));
  const config = { dbPath: join(directory, 'ledger.sqlite'), chainId: 31337n, vaultAddress: vault,
    rubaAddress: ruba, usdtAddress: usdt, operatorPrivateKey: operator.privateKey };
  let engine = new ZkRubaEngine(config, 987654321n);
  const domain = { name: 'RubaZkOperation', version: '2', chainId: config.chainId, verifyingContract: vault };
  async function authorize(signer: Wallet, operation: object, callback: () => unknown) {
    const prepared = engine.prepareAuthorization(signer.address, operation, randomField());
    const signature = await signer.signTypedData(domain, types, { commitment: prepared.commitment });
    return engine.withZkAuthorization({ account: signer.address, commitment: prepared.commitment,
      nonce: prepared.nonce, salt: prepared.salt, signature }, callback);
  }
  async function register(signer: Wallet, recoveryKey: bigint) {
    const slot = engine.getZkAccount(signer.address).slot;
    return authorize(signer, { kind: 'zkRegister', recoveryKey: recoveryKey.toString(), slot: slot.toString() },
      () => engine.registerZkAccount(signer.address, recoveryKey, slot));
  }
  function deposit(eventId: bigint, owner: string, token: 'RUBA' | 'USDT', amount: bigint) {
    return engine.applyInboxRecord({ eventId, kind: 2, owner, token, amount, reference: eventId,
      legacyEventId: `deposit:${eventId}`, transactionHash: hash(Number(eventId)), blockNumber: Number(eventId) });
  }
  function swap(signer: Wallet, tokenIn: 'RUBA' | 'USDT', amountIn: bigint) {
    return authorize(signer, { kind: 'swap', tokenIn, amountIn: amountIn.toString(), minOut: '1' },
      () => engine.swap(signer.address, tokenIn, amountIn, 1n));
  }
  function withdraw(signer: Wallet, token: 'RUBA' | 'USDT', amount: bigint) {
    return authorize(signer, { kind: 'withdraw', token, amount: amount.toString() },
      () => engine.reserveWithdrawal(signer.address, token, amount, CLAIM_DEADLINE, 0n));
  }
  async function acceptedMarket() {
    await register(user, 123456789n);
    deposit(1n, user.address, 'RUBA', 1000n * RUBA); deposit(2n, user.address, 'USDT', 1000n * USDT);
    await authorize(user, { kind: 'addLiquidity', rubaDesired: (500n * RUBA).toString(), usdtDesired: (500n * USDT).toString(), rubaMin: '0', usdtMin: '0' },
      () => engine.addLiquidity(user.address, 500n * RUBA, 500n * USDT));
    await register(trader, 555n);
    deposit(3n, trader.address, 'USDT', 100n * USDT);
    engine.closePendingBatch();
    engine.markTransitionAccepted(1n, hash(9001), 100);
  }
  return { get engine() { return engine; }, register, deposit, swap, withdraw, acceptedMarket,
    restart() { engine.close(); engine = new ZkRubaEngine(config); return engine; },
    close() { engine.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const excluded = (account: string): QueueRule => ({ kind, owner }) => owner === account && [1, 3, 4].includes(kind) ? 'owner is not whitelisted' : undefined;
const pending = (engine: ZkRubaEngine) => engine.listTransitions().filter((item) => item.status === 'pending');

test('trader removed between swap acceptance and publication: rebuild drops the trader and keeps the others', async () => {
  const f = fixture();
  try {
    await f.acceptedMarket();
    const traderBefore = f.engine.accountSnapshot(trader.address);
    const traderNonce = f.engine.getZkAccount(trader.address).spendNonce;
    await f.swap(trader, 'USDT', 10n * USDT);
    await f.swap(user, 'RUBA', 5n * RUBA);
    await f.withdraw(trader, 'RUBA', 1n);
    await f.swap(user, 'RUBA', 5n * RUBA);
    assert.deepEqual(pending(f.engine).map((item) => item.operations.map((op) => op.kind)), [[3, 3, 6]]);
    const oldUserOut = f.engine.getReceipt(2n)!.amountOut;

    const result = f.engine.rebuildQueue(excluded(trader.address));

    assert.equal(result.changed, true);
    assert.equal(result.fromStateVersion, 1n);
    assert.equal(result.kept, 2);
    assert.deepEqual(result.dropped.map((item) => [item.kind, item.owner]), [[3, trader.address], [6, trader.address]]);
    assert.match(result.dropped[1].reason, /follows a dropped operation/);
    assert.deepEqual(result.trades.map((item) => [item.previousTradeId, item.tradeId]), [[2n, 1n], [3n, 2n]]);
    assert.deepEqual(result.pendingVersions, [2n]);
    const [rebuilt] = pending(f.engine);
    assert.equal(rebuilt.mode, 1);
    assert.equal(rebuilt.previousRoot, f.engine.getAcceptedCheckpoint().root);
    assert.deepEqual(rebuilt.operations.map((op) => [op.kind, op.owner]), [[3, BigInt(user.address)], [3, BigInt(user.address)]]);
    assert.deepEqual(f.engine.accountSnapshot(trader.address), traderBefore);
    assert.equal(f.engine.getZkAccount(trader.address).spendNonce, traderNonce);
    assert.equal(f.engine.getReceipt(3n), undefined);
    assert.notEqual(f.engine.getReceipt(1n)!.amountOut, oldUserOut);

    const restarted = f.restart();
    assert.deepEqual(pending(restarted).map((item) => item.stateVersion), [2n]);
    restarted.markTransitionAccepted(2n, hash(9002), 101);
    assert.equal(restarted.getAcceptedCheckpoint().nextTradeId, 3n);
  } finally { f.close(); }
});

test('rebuild changes nothing when the Vault still accepts every pending operation', async () => {
  const f = fixture();
  try {
    await f.acceptedMarket();
    await f.swap(trader, 'USDT', 10n * USDT);
    await f.swap(user, 'RUBA', 5n * RUBA);
    f.engine.closePendingBatch();
    const before = f.engine.listTransitions();
    const result = f.engine.rebuildQueue(() => undefined);
    assert.equal(result.changed, false);
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(f.engine.listTransitions(), before);
  } finally { f.close(); }
});

test('paused market: swaps leave the queue, a Vault deposit stays in it', async () => {
  const f = fixture();
  try {
    await f.acceptedMarket();
    await f.swap(user, 'RUBA', 5n * RUBA);
    f.deposit(4n, trader.address, 'USDT', 7n * USDT);
    await f.swap(trader, 'USDT', 3n * USDT);
    f.engine.closePendingBatch();
    const result = f.engine.rebuildQueue(({ kind }) => kind === 3 || kind === 4 ? 'market is paused' : undefined);
    assert.deepEqual(result.dropped.map((item) => item.reason), ['market is paused', 'market is paused']);
    const [rebuilt] = pending(f.engine);
    assert.equal(rebuilt.mode, 0);
    assert.deepEqual(rebuilt.operations.map((op) => op.kind), [2]);
    assert.equal(rebuilt.newInboxCursor, 4n);
    assert.equal(f.engine.accountSnapshot(trader.address).balances.USDT, 107n * USDT);
    f.restart();
  } finally { f.close(); }
});

test('a registration the Vault would refuse is dropped together with the account it opened', async () => {
  const f = fixture();
  try {
    await f.acceptedMarket();
    const late = new Wallet('0x' + '44'.repeat(32));
    await f.register(late, 777n);
    await f.swap(user, 'RUBA', 5n * RUBA);
    f.engine.closePendingBatch();
    const result = f.engine.rebuildQueue(excluded(late.address));
    assert.deepEqual(result.dropped.map((item) => item.kind), [1]);
    assert.equal(f.engine.getZkAccount(late.address).registered, false);
    assert.deepEqual(pending(f.engine).map((item) => item.operations.map((op) => op.kind)), [[3]]);
    await f.register(late, 778n);
    f.restart();
  } finally { f.close(); }
});
