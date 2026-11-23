import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Wallet } from 'ethers';
import { RubaEngine } from '../engine.ts';
import type { State } from '../engine.ts';
import { ZkRubaEngine } from '../zk/engine.ts';
import { decodeZk, encodeZk } from '../zk/journal.ts';
import type { ZkOperationRecord } from '../zk/journal.ts';
import { decryptAccount, decryptPool, fieldHex, hashAccount, hashOperation, keyCommit, randomField, verifyAccountProof } from '../../zk/crypto.js';

const user = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
const operator = new Wallet('0x' + '33'.repeat(32));
const vault = '0x0000000000000000000000000000000000000001';
const ruba = '0x0000000000000000000000000000000000000002';
const usdt = '0x0000000000000000000000000000000000000003';
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const types = { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] };
const CLAIM_DEADLINE = (1n << 64n) - 1n;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-zk-engine-'));
  const config = { dbPath: join(directory, 'ledger.sqlite'), chainId: 31337n, vaultAddress: vault,
    rubaAddress: ruba, usdtAddress: usdt, operatorPrivateKey: operator.privateKey };
  let engine = new ZkRubaEngine(config, 987654321n);
  let closed = false;
  const domain = { name: 'RubaZkOperation', version: '2', chainId: config.chainId, verifyingContract: vault };
  async function authorize(operation: object, callback: () => unknown, signer = user) {
    const prepared = engine.prepareAuthorization(signer.address, operation, randomField());
    const signature = await signer.signTypedData(domain, types, { commitment: prepared.commitment });
    return engine.withZkAuthorization({ account: signer.address, commitment: prepared.commitment,
      nonce: prepared.nonce, salt: prepared.salt, signature }, callback);
  }
  async function register(signer = user, recoveryKey = 123456789n) {
    const slot = engine.getZkAccount(signer.address).slot;
    return authorize({ kind: 'zkRegister', recoveryKey: recoveryKey.toString(), slot: slot.toString() },
      () => engine.registerZkAccount(signer.address, recoveryKey, slot), signer);
  }
  function deposit(eventId: bigint, token: 'RUBA' | 'USDT', amount: bigint, owner = user.address) {
    return engine.applyInboxRecord({ eventId, kind: 2, owner, token, amount, reference: eventId,
      legacyEventId: `deposit:${eventId}`, transactionHash: hash(Number(eventId)), blockNumber: Number(eventId) });
  }
  async function fund() {
    await register(); deposit(1n, 'RUBA', 1000n * 10n ** 18n); deposit(2n, 'USDT', 1000n * 10n ** 6n);
    await authorize({ kind: 'addLiquidity', rubaDesired: (500n * 10n ** 18n).toString(), usdtDesired: (500n * 10n ** 6n).toString(), rubaMin: '0', usdtMin: '0' },
      () => engine.addLiquidity(user.address, 500n * 10n ** 18n, 500n * 10n ** 6n));
  }
  async function swap() {
    return authorize({ kind: 'swap', tokenIn: 'RUBA', amountIn: (10n ** 18n).toString(), minOut: '1' },
      () => engine.swap(user.address, 'RUBA', 10n ** 18n, 1n));
  }
  return { get engine() { return engine; }, config, domain, authorize, register, deposit, fund, swap,
    restart() { engine.close(); closed = true; engine = new ZkRubaEngine(config); closed = false; return engine; },
    close() { if (!closed) { engine.close(); closed = true; } rmSync(directory, { recursive: true, force: true }); } };
}

test('ZK genesis, registered owner/key and separate read nonce remain bound to the account tree', async () => {
  const f = fixture();
  try {
    assert.equal(f.engine.getAcceptedCheckpoint().root, f.engine.getGenesisStateRoot());
    assert.equal(f.engine.getPendingTransition(), undefined);
    const before = f.engine.getZkAccount(user.address);
    assert.equal(before.registered, false);
    await f.register();
    const account = f.engine.getZkAccount(user.address);
    assert.equal(account.account[0], BigInt(user.address));
    assert.equal(account.spendNonce, 1n);
    assert.equal(account.account[7], keyCommit(123456789n));
    assert.equal(verifyAccountProof(account.slot, hashAccount(account.slot, account.account), account.path, account.accountsRoot), true);
    const root = account.stateRoot;
    f.engine.executeAction(user.address, 0n, () => f.engine.accountSnapshot(user.address));
    assert.equal(f.engine.getActionNonce(user.address), 1n);
    assert.equal(f.engine.getZkAccount(user.address).spendNonce, 1n);
    assert.equal(f.engine.getZkAccount(user.address).stateRoot, root);
    await assert.rejects(f.register(), /already registered|occupied/);
    const control = f.engine.getPendingTransition()!;
    assert.equal(control.mode, 0);
    assert.equal(control.operations.length, 1);
    assert.equal(control.previousRoot, f.engine.getGenesisStateRoot());
    assert.equal(control.publicSignals.length, 13);
  } finally { f.close(); }
});

test('every economic mutation saves preimages, owner authorization, encrypted DA and a continuous four-swap proof witness', async () => {
  const f = fixture();
  try {
    await f.fund();
    const control = f.engine.getPendingTransition()!;
    assert.equal(control.mode, 0);
    assert.deepEqual(control.operations.map((op) => op.kind), [1, 2, 2, 4]);
    assert.equal(control.newInboxCursor, 2n);
    assert.equal(control.metadata.length, 8);
    assert.equal(control.accountDA.length, 8);
    let previousRoot = control.previousRoot;
    for (const operation of control.operations) {
      assert.equal(operation.beforeState.root, previousRoot);
      previousRoot = operation.afterState.root;
      assert.deepEqual(decryptAccount(operation.recoveryKey, operation.da.newLeaf, operation.da.ciphertext),
        [operation.newAccount[1], operation.newAccount[2], operation.newAccount[3], operation.newAccount[4], operation.newAccount[5], operation.newAccount[6], operation.newAccount[8]]);
      assert.ok(operation.ledgerAfter);
    }
    assert.deepEqual(decryptPool(987654321n, control.poolDA.poolHash, control.poolDA.poolCiphertext), control.endingState.pool);
    for (let count = 1; count <= 3; count++) { await f.swap(); assert.equal(f.engine.listTransitions().length, 1); assert.equal(f.engine.getBatch(1n), undefined); }
    await f.swap();
    const trade = f.engine.getTransitionForBatch(1n)!;
    assert.equal(trade.mode, 1);
    assert.equal(trade.previousRoot, control.newRoot);
    assert.equal(trade.stateVersion, 2n);
    assert.equal(trade.operations.length, 4);
    assert.equal(trade.newTradeId - trade.previousTradeId, 4n);
    assert.equal(trade.witness.receiptsRoot, trade.receiptsRoot.toString());
    const batch = f.engine.getBatch(1n)!;
    assert.equal(batch.receiptsRoot, fieldHex(trade.receiptsRoot));
    for (const id of batch.tradeIds) assert.equal(f.engine.getReceipt(id)?.proof?.length, 2);
    assert.equal(f.engine.getPendingTransition()!.stateVersion, 1n, 'the earliest unaccepted transition blocks later publication');
    f.engine.markTransitionAccepted(1n, hash(9001), 100);
    assert.equal(f.engine.getPendingTransition()!.stateVersion, 2n);
    f.engine.markTransitionAccepted(2n, hash(9002), 101);
    assert.equal(f.engine.getAcceptedCheckpoint().root, trade.newRoot);
    assert.equal(f.engine.getBatch(1n)?.publishedTxHash, hash(9002));
    f.restart();
    assert.equal(f.engine.getAcceptedCheckpoint().root, trade.newRoot);
    assert.equal(f.engine.getPendingTransition(), undefined);
    assert.equal(f.engine.getRecoveryBundle(user.address).recoveryKey, 123456789n);
  } finally { f.close(); }
});

for (const count of [1, 2, 3]) test(`manual close seals ${count} swaps with actual receipt count and survives restart`, async () => {
  const f = fixture();
  try {
    await f.fund();
    const control = f.engine.getPendingTransition()!;
    f.engine.markTransitionAccepted(control.stateVersion, hash(9100), 100);
    for (let index = 0; index < count; index++) await f.swap();
    assert.equal(f.engine.getPendingTransition(), undefined, 'ordinary publication lookup does not force a partial close');
    const transition = f.engine.closePendingBatch()!;
    const batch = f.engine.getBatch(1n)!;
    assert.equal(transition.mode, 1);
    assert.equal(transition.previousRoot, control.newRoot);
    assert.equal(transition.newTradeId - transition.previousTradeId, BigInt(count));
    assert.equal(batch.tradeCount, BigInt(count));
    assert.deepEqual(batch.tradeIds, Array.from({ length: count }, (_, index) => BigInt(index + 1)));
    for (const id of batch.tradeIds) assert.equal(f.engine.getReceipt(id)?.proof?.length, 2);
    const versions = f.engine.listTransitions().length;
    assert.deepEqual(f.engine.closePendingBatch(), transition);
    assert.equal(f.engine.listTransitions().length, versions, 'repeated close does not create another boundary');
    f.engine.markTransitionAccepted(transition.stateVersion, hash(9100 + count), 101);
    f.restart();
    assert.equal(f.engine.getBatch(1n)?.tradeCount, BigInt(count));
    assert.equal(f.engine.closePendingBatch(), undefined);
    for (let index = 0; index < 4; index++) await f.swap();
    const next = f.engine.getBatch(2n)!;
    assert.equal(next.firstTradeId, BigInt(count + 1));
    assert.equal(next.tradeCount, 4n);
    assert.equal(f.engine.getTransitionForBatch(2n)!.previousRoot, transition.newRoot);
    f.restart();
    assert.equal(f.engine.getBatch(2n)?.firstTradeId, BigInt(count + 1));
  } finally { f.close(); }
});

test('closing an empty ledger does not publish an empty root', () => {
  const f = fixture();
  try {
    assert.equal(f.engine.closePendingBatch(), undefined);
    assert.equal(f.engine.closePendingBatch(), undefined);
    assert.equal(f.engine.listTransitions().length, 0);
    assert.equal(f.engine.getAcceptedCheckpoint().stateVersion, 0n);
  } finally { f.close(); }
});

test('withdrawal closes a partial packet even when all auxiliary slots are occupied', async () => {
  const f = fixture();
  try {
    await f.fund(); f.engine.getPendingTransition();
    await f.swap();
    for (let index = 0; index < 4; index++) f.deposit(BigInt(index + 3), 'USDT', 100n);
    assert.equal(f.engine.canApplyInboxRecord(), false);
    const claim = await f.authorize({ kind: 'withdraw', token: 'USDT', amount: '100' },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', 100n, CLAIM_DEADLINE, 0n)) as ReturnType<ZkRubaEngine['reserveWithdrawal']>;
    const transition = f.engine.getTransitionForBatch(1n)!;
    assert.deepEqual(transition.operations.map((operation) => operation.kind), [3, 2, 2, 2, 2, 6]);
    assert.equal(f.engine.getBatch(1n)?.tradeCount, 1n);
    assert.equal(f.engine.getProvenWithdrawal(claim).stateVersion, transition.stateVersion);
    assert.equal(f.engine.canApplyInboxRecord(), true);
    f.restart();
    assert.equal(f.engine.getProvenWithdrawal(claim).stateVersion, transition.stateVersion);
  } finally { f.close(); }
});

test('LP removal closes three pending swaps using the eighth operation slot', async () => {
  const f = fixture();
  try {
    await f.fund(); f.engine.getPendingTransition();
    for (let index = 0; index < 3; index++) await f.swap();
    for (let index = 0; index < 4; index++) f.deposit(BigInt(index + 3), 'USDT', 100n);
    const shares = f.engine.accountSnapshot(user.address).lpShares / 10n;
    await f.authorize({ kind: 'removeLiquidity', shares: shares.toString(), rubaMin: '0', usdtMin: '0' },
      () => f.engine.removeLiquidity(user.address, shares));
    const transition = f.engine.getTransitionForBatch(1n)!;
    assert.equal(transition.operations.length, 8);
    assert.equal(transition.operations.at(-1)!.kind, 5);
    assert.equal(f.engine.getBatch(1n)?.tradeCount, 3n);
    assert.equal(f.engine.journal.operations(true).length, 0);
    f.restart();
    assert.equal(f.engine.getBatch(1n)?.tradeCount, 3n);
  } finally { f.close(); }
});

test('a rejected exit does not close or change the pending swap packet', async () => {
  const f = fixture();
  try {
    await f.fund(); f.engine.getPendingTransition();
    await f.swap();
    const before = f.engine.getZkAccount(user.address);
    const count = f.engine.listTransitions().length;
    const amount = f.engine.accountSnapshot(user.address).balances.USDT + 1n;
    await assert.rejects(f.authorize({ kind: 'withdraw', token: 'USDT', amount: amount.toString() },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', amount, CLAIM_DEADLINE, 0n)), /Insufficient/);
    assert.equal(f.engine.listTransitions().length, count);
    assert.equal(f.engine.getBatch(1n), undefined);
    assert.deepEqual(f.engine.getZkAccount(user.address), before);
  } finally { f.close(); }
});

test('missing, changed and replayed economic authorizations roll back ledger and witness together', async () => {
  const f = fixture();
  try {
    await f.fund();
    const before = f.engine.snapshot();
    const rows = f.engine.journal.operations().length;
    assert.throws(() => f.engine.swap(user.address, 'RUBA', 10n ** 18n, 0n), /salt|authorization/);
    const operation = { kind: 'swap', tokenIn: 'RUBA', amountIn: (10n ** 18n).toString(), minOut: '0' };
    const prepared = f.engine.prepareAuthorization(user.address, operation, randomField());
    const signature = await user.signTypedData(f.domain, types, { commitment: prepared.commitment });
    const authorization = { account: user.address, commitment: prepared.commitment, nonce: prepared.nonce, salt: prepared.salt, signature };
    assert.throws(() => f.engine.withZkAuthorization(authorization, () => f.engine.executeAction(user.address, 0n,
      () => f.engine.swap(user.address, 'RUBA', 2n * 10n ** 18n, 0n))), /mismatched/);
    assert.equal(f.engine.getActionNonce(user.address), 0n);
    assert.deepEqual(f.engine.snapshot(), before);
    assert.equal(f.engine.journal.operations().length, rows);
    const wrongSignature = await other.signTypedData(f.domain, types, { commitment: prepared.commitment });
    assert.throws(() => f.engine.withZkAuthorization({ ...authorization, signature: wrongSignature },
      () => f.engine.swap(user.address, 'RUBA', 10n ** 18n, 0n)), /owner signature/);
    assert.equal(f.engine.journal.operations().length, rows);
    f.engine.withZkAuthorization(authorization, () => f.engine.swap(user.address, 'RUBA', 10n ** 18n, 0n));
    assert.throws(() => f.engine.withZkAuthorization(authorization, () => f.engine.swap(user.address, 'RUBA', 10n ** 18n, 0n)), /mismatched|salt/);
    assert.equal(f.engine.journal.operations().length, rows + 1);
  } finally { f.close(); }
});

test('a caught nested economic failure cannot commit partial SQL witness data or consume its authorization', async () => {
  const f = fixture();
  try {
    await f.fund();
    const before = f.engine.snapshot(); const count = f.engine.journal.operations().length;
    const op = { kind: 'swap', tokenIn: 'RUBA', amountIn: (10n ** 18n).toString(), minOut: '0' };
    const prepared = f.engine.prepareAuthorization(user.address, op, randomField());
    const signature = await user.signTypedData(f.domain, types, { commitment: prepared.commitment });
    const append = f.engine.journal.append.bind(f.engine.journal);
    f.engine.journal.append = (record) => { append(record); throw new Error('Injected failure after SQL witness write'); };
    assert.throws(() => f.engine.withZkAuthorization({ account: user.address, commitment: prepared.commitment, nonce: prepared.nonce, salt: prepared.salt, signature }, () => {
      assert.throws(() => f.engine.swap(user.address, 'RUBA', 10n ** 18n, 0n), /Injected failure/);
      assert.equal(f.engine.journal.operations().length, count, 'the nested SQL write is already rolled back');
    }), /exactly one/);
    f.engine.journal.append = append;
    assert.deepEqual(f.engine.snapshot(), before);
    assert.equal(f.engine.journal.operations().length, count);
    assert.equal(f.engine.getCurrentInboxCursor(), 2n);
  } finally { f.close(); }
});

test('canonical inbox is contiguous/idempotent and four auxiliary slots preserve capacity for the remaining swaps', async () => {
  const f = fixture();
  try {
    await f.fund();
    f.engine.getPendingTransition();
    assert.equal(f.deposit(1n, 'RUBA', 1000n * 10n ** 18n), false);
    assert.throws(() => f.deposit(1n, 'RUBA', 1n), /Conflicting/);
    assert.throws(() => f.deposit(4n, 'RUBA', 1n), /sequential/);
    assert.throws(() => f.engine.recordDeposit(3n, user.address, 'RUBA', 1n), /canonical/);
    assert.throws(() => f.deposit(3n, 'RUBA', 1n << 96n), /96-bit/);
    assert.equal(f.engine.getCurrentInboxCursor(), 2n);
    await f.swap();
    for (let index = 0; index < 4; index++) f.deposit(BigInt(index + 3), 'USDT', 100n);
    const before = f.engine.getZkAccount(user.address);
    assert.equal(f.engine.canApplyInboxRecord(), false);
    assert.throws(() => f.deposit(7n, 'USDT', 100n), /capacity/);
    assert.deepEqual(f.engine.getZkAccount(user.address), before);
    assert.equal(f.engine.getCurrentInboxCursor(), 6n);
    for (let index = 0; index < 3; index++) await f.swap();
    const transition = f.engine.getTransitionForBatch(1n)!;
    assert.equal(transition.operations.length, 8);
    assert.equal(transition.operations.filter((op) => op.kind === 3).length, 4);
    assert.equal(f.engine.canApplyInboxRecord(), true);
  } finally { f.close(); }
});

test('proven withdrawal claims are perpetual, settle only through canonical inbox and cannot be refunded', async () => {
  const f = fixture();
  try {
    await f.fund();
    for (let index = 0; index < 2; index++) await f.authorize({ kind: 'withdraw', token: 'USDT', amount: '100' },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', 100n, CLAIM_DEADLINE, 0n));
    const nonce = f.engine.getZkAccount(user.address).spendNonce;
    assert.equal(f.engine.getZkAccount(user.address).withdrawalNonce, nonce);
    const claims = f.engine.accountSnapshot(user.address).withdrawals;
    assert.deepEqual(claims.map((claim) => claim.nonce), [2n, 3n]);
    assert.ok(claims.every((claim) => claim.deadline === CLAIM_DEADLINE && claim.signerEpoch === 0n));
    assert.throws(() => f.engine.settleWithdrawal(user.address, claims[0].nonce, 'USDT', 100n, 'fake'), /canonical/);
    f.engine.applyInboxRecord({ eventId: 3n, kind: 7, owner: user.address, token: 'USDT', amount: 100n,
      reference: claims[0].nonce, legacyEventId: '31337:vault:tx:0' });
    const before = f.engine.getZkAccount(user.address);
    assert.throws(() => f.engine.expireWithdrawal(user.address, claims[1].nonce, { finalizedTimestamp: CLAIM_DEADLINE + 1n, nonceUsed: false }), /disabled/);
    assert.deepEqual(f.engine.getZkAccount(user.address), before);
    assert.equal(f.engine.journal.operations().at(-1)!.kind, 7);
    assert.equal(f.engine.getZkAccount(user.address).spendNonce, nonce);
    assert.equal(f.engine.getZkAccount(user.address).account[6], 100n);
    assert.equal(f.engine.getWithdrawal(user.address, claims[0].nonce)?.status, 'settled');
    assert.equal(f.engine.getWithdrawal(user.address, claims[1].nonce)?.status, 'pending');
    f.restart();
    assert.equal(f.engine.getZkAccount(user.address).account[6], 100n);
    assert.equal(f.engine.getProvenWithdrawals(user.address).length, 1);
  } finally { f.close(); }
});

test('proven openings bind the actual spend nonce and survive interleaved swaps, sealing and restart', async () => {
  const f = fixture();
  try {
    await f.fund(); f.engine.getPendingTransition();
    f.engine.executeAction(user.address, 0n, () => f.engine.accountSnapshot(user.address));
    await f.swap();
    const firstNonce = f.engine.getZkAccount(user.address).spendNonce;
    const first = await f.authorize({ kind: 'withdraw', token: 'USDT', amount: '100' },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', 100n, CLAIM_DEADLINE, 0n)) as ReturnType<ZkRubaEngine['reserveWithdrawal']>;
    await f.swap();
    const secondNonce = f.engine.getZkAccount(user.address).spendNonce;
    const second = await f.authorize({ kind: 'withdraw', token: 'USDT', amount: '200' },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', 200n, CLAIM_DEADLINE, 0n)) as ReturnType<ZkRubaEngine['reserveWithdrawal']>;
    assert.equal(first.nonce, firstNonce); assert.equal(second.nonce, secondNonce);
    assert.equal(secondNonce, firstNonce + 2n);
    const opening = f.engine.getProvenWithdrawal(first);
    assert.equal(opening.stateVersion, 2n);
    assert.equal('signature' in opening, false);
    assert.equal(opening.withdrawal.nonce, opening.withdrawal.spendNonce);
    assert.equal(opening.commitment, hashOperation(f.engine.getDomain(), 6, 0, BigInt(user.address), firstNonce,
      [1n, 100n, firstNonce, 0n], opening.withdrawal.salt));
    assert.equal(f.engine.getZkAccount(user.address).provenWithdrawals.length, 2);
    assert.equal(f.engine.getRecoveryBundle(user.address).provenWithdrawals.length, 2);
    f.restart();
    assert.deepEqual(f.engine.getProvenWithdrawal(user.address, firstNonce), opening);
    assert.throws(() => f.engine.getProvenWithdrawal({ ...first, amount: first.amount + 1n }), /durable reservation/);
    assert.throws(() => f.engine.getProvenWithdrawal(user.address, 999n), /durable reservation/);
    await f.swap(); await f.swap();
    const sealed = f.engine.getProvenWithdrawal(user.address, firstNonce);
    assert.equal(sealed.stateVersion, 2n);
    assert.deepEqual(sealed.withdrawal, opening.withdrawal);
    assert.equal(f.engine.getProvenWithdrawal(second).stateVersion, 3n);
    sealed.withdrawal.salt += 1n;
    assert.equal(f.engine.getProvenWithdrawal(first).withdrawal.salt, opening.withdrawal.salt, 'returned openings are detached from persisted data');
    f.restart();
    assert.equal(f.engine.getProvenWithdrawal(first).stateVersion, 2n);
    assert.equal(f.engine.journal.getMeta('withdrawalMode'), 'proven-reservation-v1');
  } finally { f.close(); }
});

test('failed or mismatched reserve authorization rolls back the legacy nonce cache and private opening atomically', async () => {
  const f = fixture();
  try {
    await f.fund();
    const nonce = f.engine.getZkAccount(user.address).spendNonce;
    const before = f.engine.getZkAccount(user.address);
    const rows = f.engine.journal.operations().length;
    const ledgerBefore = (f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string }).state;
    const tooMuch = f.engine.accountSnapshot(user.address).balances.USDT + 1n;
    await assert.rejects(f.authorize({ kind: 'withdraw', token: 'USDT', amount: tooMuch.toString() },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', tooMuch, CLAIM_DEADLINE, 0n)), /Insufficient/);
    assert.equal((f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string }).state, ledgerBefore);
    assert.deepEqual(f.engine.getZkAccount(user.address), before);
    assert.equal(f.engine.journal.operations().length, rows);
    const salt = randomField();
    const wrong = hashOperation(f.engine.getDomain(), 6, 0, BigInt(user.address), nonce, [1n, 100n, nonce + 1n, 0n], salt);
    const signature = await user.signTypedData(f.domain, types, { commitment: wrong });
    assert.throws(() => f.engine.withZkAuthorization({ account: user.address, commitment: wrong, nonce, salt, signature },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', 100n, CLAIM_DEADLINE, 0n)), /mismatched/);
    await f.authorize({ kind: 'withdraw', token: 'USDT', amount: '100' }, () => f.engine.reserveWithdrawal(user.address, 'USDT', 100n, CLAIM_DEADLINE, 0n));
    assert.equal(f.engine.getProvenWithdrawals(user.address)[0].withdrawal.nonce, nonce);
    assert.equal(f.engine.journal.operations().length, rows + 1);
    assert.throws(() => f.engine.reserveWithdrawal(user.address, 'USDT', 1n, 1000n, 1n), /perpetual/);
  } finally { f.close(); }
});

test('ZK startup rejects a legacy database rather than trusting its current balances as genesis', () => {
  const f = fixture();
  const legacyPath = join(tmpdir(), `ruba-legacy-${Date.now()}-${Math.random()}.sqlite`);
  try {
    const config = { ...f.config, dbPath: legacyPath };
    const legacy = new RubaEngine(config);
    legacy.recordDeposit(1n, user.address, 'USDT', 100n); legacy.close();
    assert.throws(() => new ZkRubaEngine(config, 123n), /Legacy database/);
    const reopened = new RubaEngine(config); assert.equal(reopened.accountSnapshot(user.address).balances.USDT, 100n); reopened.close();
  } finally { f.close(); rmSync(legacyPath, { force: true }); rmSync(legacyPath + '-wal', { force: true }); rmSync(legacyPath + '-shm', { force: true }); }
});

test('proven mode refuses an older v2 journal without changing or automatically migrating its state', async () => {
  const f = fixture();
  try {
    await f.fund();
    const before = (f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string }).state;
    f.engine.db.prepare("DELETE FROM zk_meta WHERE key='withdrawalMode'").run();
    assert.throws(() => f.restart(), /old withdrawal mode.*fresh proven-reservation-v1/);
    const db = new DatabaseSync(f.config.dbPath);
    try {
      assert.equal((db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string }).state, before);
      assert.equal(db.prepare("SELECT value FROM zk_meta WHERE key='withdrawalMode'").get(), undefined);
    } finally { db.close(); }
  } finally { f.close(); }
});

test('proven mode refuses any stored REFUND operation even when its database marker claims the new mode', async () => {
  const f = fixture();
  try {
    await f.fund();
    const row = f.engine.db.prepare('SELECT seq,record FROM zk_operations WHERE seq=1').get() as { seq: number; record: string };
    const record = decodeZk<ZkOperationRecord>(row.record);
    record.kind = 8;
    f.engine.db.prepare('UPDATE zk_operations SET record=? WHERE seq=?').run(encodeZk(record), row.seq);
    assert.throws(() => f.restart(), /REFUND history is forbidden/);
  } finally { f.close(); }
});

test('a changed persisted opening is rejected before it can be returned or recovered after restart', async () => {
  const f = fixture();
  try {
    await f.fund();
    const request = await f.authorize({ kind: 'withdraw', token: 'USDT', amount: '100' },
      () => f.engine.reserveWithdrawal(user.address, 'USDT', 100n, CLAIM_DEADLINE, 0n)) as ReturnType<ZkRubaEngine['reserveWithdrawal']>;
    const row = f.engine.db.prepare('SELECT seq,record FROM zk_operations ORDER BY seq DESC LIMIT 1').get() as { seq: number; record: string };
    const record = decodeZk<ZkOperationRecord>(row.record);
    record.provenWithdrawal!.withdrawal.salt += 1n;
    f.engine.db.prepare('UPDATE zk_operations SET record=? WHERE seq=?').run(encodeZk(record), row.seq);
    assert.throws(() => f.engine.getProvenWithdrawal(request), /opening differs/);
    assert.throws(() => f.restart(), /opening differs/);
  } finally { f.close(); }
});

test('restart rejects altered old membership or authorization even when aggregate balances remain conserved', async () => {
  const f = fixture();
  try {
    await f.fund();
    const row = f.engine.db.prepare('SELECT seq,record FROM zk_operations WHERE seq=1').get() as { seq: number; record: string };
    const record = decodeZk<ZkOperationRecord>(row.record);
    record.beforeState.accounts[1][8] = 1n;
    f.engine.db.prepare('UPDATE zk_operations SET record=? WHERE seq=?').run(encodeZk(record), row.seq);
    assert.throws(() => f.restart(), /starting state|previous root|empty/);
  } finally { f.close(); }
});

test('restart refuses reassignment between owners even when total custody remains exactly conserved', async () => {
  const f = fixture();
  try {
    await f.fund(); await f.register(other, 444444n);
    f.deposit(3n, 'USDT', 100n, other.address);
    const row = f.engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string };
    const ledger = decodeZk<State>(row.state);
    ledger.balances[user.address].USDT += 1n;
    ledger.balances[other.address].USDT -= 1n;
    f.engine.db.prepare('UPDATE engine_state SET state=? WHERE id=1').run(encodeZk(ledger));
    assert.throws(() => f.restart(), /User ledger differs/);
  } finally { f.close(); }
});

test('restart refuses ciphertext replacement while the underlying account balances and signature stay intact', async () => {
  const f = fixture();
  try {
    await f.fund();
    const row = f.engine.db.prepare('SELECT seq,record FROM zk_operations WHERE seq=2').get() as { seq: number; record: string };
    const record = decodeZk<ZkOperationRecord>(row.record);
    record.da.ciphertext[0] += 1n;
    f.engine.db.prepare('UPDATE zk_operations SET record=? WHERE seq=?').run(encodeZk(record), row.seq);
    assert.throws(() => f.restart(), /encrypted DA/);
  } finally { f.close(); }
});
