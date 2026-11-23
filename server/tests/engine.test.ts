import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RubaEngine, MINIMUM_LIQUIDITY, sqrt } from "../engine.ts";
import { buildMerkleBatch, canonicalJson, commitState, hashPair, hashReceipt, verifyMerkleProof, ZERO_ROOT } from "../merkle.ts";
import type { EngineConfig } from "../types.ts";

const ALICE = "0x0000000000000000000000000000000000000011";
const BOB = "0x0000000000000000000000000000000000000022";
const CONFIG: EngineConfig = {
  dbPath: ":memory:", chainId: 31337n,
  vaultAddress: "0x0000000000000000000000000000000000000001",
  rubaAddress: "0x0000000000000000000000000000000000000002",
  usdtAddress: "0x0000000000000000000000000000000000000003",
};
const R = 10n ** 18n;
const U = 10n ** 6n;

function fixture(path = ":memory:"): RubaEngine {
  const engine = new RubaEngine({ ...CONFIG, dbPath: path });
  engine.recordDeposit(1n, ALICE, "RUBA", 2_000n * R);
  engine.recordDeposit(2n, ALICE, "USDT", 2_000n * U);
  engine.addLiquidity(ALICE, 1_000n * R, 1_000n * U);
  engine.recordDeposit(3n, BOB, "RUBA", 1_000n * R);
  engine.recordDeposit(4n, BOB, "USDT", 1_000n * U);
  return engine;
}

function conserved(engine: RubaEngine): void {
  const snapshot = engine.snapshot();
  for (const token of ["RUBA", "USDT"] as const) {
    assert.equal(snapshot.custody[token], snapshot.reserves[token] + snapshot.available[token] + snapshot.pending[token]);
  }
}

test("deposits are idempotent and conflicting replays roll back", () => {
  const engine = new RubaEngine(CONFIG);
  try {
    assert.equal(engine.recordDeposit(1n, ALICE, "USDT", 10n * U), true);
    assert.equal(engine.recordDeposit(1n, ALICE, "USDT", 10n * U), false);
    assert.throws(() => engine.recordDeposit(1n, ALICE, "USDT", 11n * U), /Conflicting deposit/);
    assert.throws(() => engine.recordDeposit(1n, BOB, "USDT", 10n * U), /Conflicting deposit/);
    assert.equal(engine.accountSnapshot(ALICE).balances.USDT, 10n * U);
    assert.equal(engine.accountSnapshot(BOB).balances.USDT, 0n);
    conserved(engine);
  } finally { engine.close(); }
});

test("rejects unsupported tokens, zero/negative amounts and invalid deposit IDs", () => {
  const engine = new RubaEngine(CONFIG);
  try {
    assert.throws(() => engine.recordDeposit(0n, ALICE, "USDT", U), /depositId/);
    assert.throws(() => engine.recordDeposit(1n, ALICE, "USDT", 0n), /amount/);
    assert.throws(() => engine.recordDeposit(1n, ALICE, "USDT", -U), /amount/);
    assert.throws(() => engine.recordDeposit(1n, ALICE, "ETH" as any, U), /Unsupported token/);
    assert.throws(() => engine.tokenSymbol("0x0000000000000000000000000000000000000099"), /Unsupported token/);
  } finally { engine.close(); }
});

test("initial liquidity handles RUBA 18 decimals and USDT 6 decimals with permanent minimum shares", () => {
  const engine = fixture();
  try {
    const snapshot = engine.snapshot();
    assert.equal(snapshot.totalSupply, 10n ** 15n);
    assert.equal(snapshot.lockedLiquidity, MINIMUM_LIQUIDITY);
    assert.equal(engine.accountSnapshot(ALICE).lpShares, 10n ** 15n - MINIMUM_LIQUIDITY);
    assert.deepEqual(snapshot.reserves, { RUBA: 1_000n * R, USDT: 1_000n * U });
    conserved(engine);
  } finally { engine.close(); }
});

test("integer square root floors non-squares without floating point", () => {
  assert.equal(sqrt(0n), 0n); assert.equal(sqrt(1n), 1n);
  assert.equal(sqrt(8n), 2n); assert.equal(sqrt(9n), 3n);
  assert.equal(sqrt(10n ** 60n + 1n), 10n ** 30n);
  assert.throws(() => sqrt(-1n), /nonnegative/);
});

test("RUBA to USDT swap credits output internally and excludes it from future liquidity", () => {
  const engine = fixture();
  try {
    const before = engine.snapshot();
    const shares = engine.accountSnapshot(ALICE).lpShares;
    const receipt = engine.swap(BOB, "RUBA", 100n * R, 90n * U);
    assert.equal(receipt.amountOut, 90_661_089n);
    assert.equal(receipt.feeNumerator, 300n * R);
    assert.equal(receipt.feeDenominator, 1000n);
    assert.deepEqual(engine.snapshot().custody, before.custody);
    assert.equal(engine.snapshot().reserves.RUBA, 1_100n * R);
    assert.equal(engine.snapshot().reserves.USDT, 909_338_911n);
    assert.equal(engine.accountSnapshot(BOB).balances.RUBA, 900n * R);
    assert.equal(engine.accountSnapshot(BOB).balances.USDT, 1_090_661_089n);
    assert.equal(engine.snapshot().totalSupply, before.totalSupply);
    assert.equal(engine.accountSnapshot(ALICE).lpShares, shares);
    assert.ok(engine.snapshot().reserves.RUBA * engine.snapshot().reserves.USDT >= before.reserves.RUBA * before.reserves.USDT);
    conserved(engine);
  } finally { engine.close(); }
});

test("reverse swap uses current reserves and both directions preserve solvency", () => {
  const engine = fixture();
  try {
    engine.swap(BOB, "RUBA", 100n * R, 0n);
    const quote = engine.quote("USDT", 50n * U);
    const before = engine.snapshot();
    const receipt = engine.swap(BOB, "USDT", 50n * U, quote);
    assert.equal(receipt.amountOut, quote);
    assert.equal(engine.snapshot().reserves.USDT, before.reserves.USDT + 50n * U);
    assert.equal(engine.snapshot().reserves.RUBA, before.reserves.RUBA - quote);
    assert.deepEqual(engine.snapshot().custody, before.custody);
    conserved(engine);
  } finally { engine.close(); }
});

test("slippage failure atomically restores ledger, trade ID and authentication nonce", () => {
  const engine = fixture();
  try {
    const before = engine.snapshot();
    const accountBefore = engine.accountSnapshot(BOB);
    assert.throws(() => engine.executeAction(BOB, 0n, () => engine.swap(BOB, "RUBA", 100n * R, 1_000n * U)), /Slippage/);
    assert.deepEqual(engine.snapshot(), before);
    assert.deepEqual(engine.accountSnapshot(BOB), accountBefore);
    assert.equal(engine.getReceipt(1n), undefined);
    engine.executeAction(BOB, 0n, () => engine.swap(BOB, "RUBA", R, 0n));
    assert.equal(engine.getActionNonce(BOB), 1n);
    assert.throws(() => engine.executeAction(BOB, 0n, () => engine.swap(BOB, "RUBA", R, 0n)), /nonce/);
    assert.equal(engine.snapshot().nextTradeId, 2n);
  } finally { engine.close(); }
});

test("failed callback restores an otherwise successful action and rejects async callbacks", () => {
  const engine = fixture();
  try {
    const before = engine.snapshot();
    assert.throws(() => engine.executeAction(BOB, 0n, () => { engine.swap(BOB, "RUBA", R, 0n); throw new Error("rollback"); }), /rollback/);
    assert.deepEqual(engine.snapshot(), before);
    assert.equal(engine.getActionNonce(BOB), 0n);
    assert.throws(() => engine.executeAction(BOB, 0n, (() => Promise.resolve()) as any), /synchronous/);
    assert.equal(engine.getActionNonce(BOB), 0n);
  } finally { engine.close(); }
});

test("small swaps that round to zero and swaps above user balance fail atomically", () => {
  const engine = fixture();
  try {
    const before = engine.snapshot();
    assert.throws(() => engine.swap(BOB, "RUBA", 1n, 0n), /rounds to zero/);
    assert.throws(() => engine.swap(BOB, "RUBA", 1_001n * R, 0n), /Insufficient RUBA/);
    assert.deepEqual(engine.snapshot(), before);
  } finally { engine.close(); }
});

test("subsequent liquidity uses optimal ratio and leaves unused tokens with the provider", () => {
  const engine = fixture();
  try {
    const initialSupply = engine.snapshot().totalSupply;
    const result = engine.addLiquidity(BOB, 200n * R, 400n * U);
    assert.deepEqual(result, { rubaAmount: 200n * R, usdtAmount: 200n * U, shares: initialSupply / 5n });
    assert.equal(engine.accountSnapshot(BOB).balances.USDT, 800n * U);
    assert.equal(engine.snapshot().totalSupply, initialSupply + result.shares);
    conserved(engine);
  } finally { engine.close(); }
});

test("liquidity add minima failures restore initial supply and locked liquidity", () => {
  const engine = new RubaEngine(CONFIG);
  try {
    engine.recordDeposit(1n, ALICE, "RUBA", 100n * R);
    engine.recordDeposit(2n, ALICE, "USDT", 100n * U);
    const before = engine.snapshot();
    assert.throws(() => engine.addLiquidity(ALICE, 100n * R, 100n * U, 101n * R), /slippage/);
    assert.deepEqual(engine.snapshot(), before);
    assert.throws(() => engine.addLiquidity(ALICE, 1n, 1n), /initial liquidity/);
    assert.deepEqual(engine.snapshot(), before);
  } finally { engine.close(); }
});

test("LP exit is proportional to current reserves and never claims trader output balances", () => {
  const engine = fixture();
  try {
    engine.swap(BOB, "RUBA", 100n * R, 0n);
    const traderBefore = engine.accountSnapshot(BOB);
    const before = engine.snapshot();
    const shares = engine.accountSnapshot(ALICE).lpShares / 2n;
    const output = engine.removeLiquidity(ALICE, shares);
    assert.equal(output.rubaAmount, shares * before.reserves.RUBA / before.totalSupply);
    assert.equal(output.usdtAmount, shares * before.reserves.USDT / before.totalSupply);
    assert.deepEqual(engine.accountSnapshot(BOB), traderBefore);
    assert.deepEqual(engine.snapshot().custody, before.custody);
    conserved(engine);
  } finally { engine.close(); }
});

test("removing all owned LP shares keeps the locked minimum and leaves no unbacked claims", () => {
  const engine = fixture();
  try {
    const owned = engine.accountSnapshot(ALICE).lpShares;
    engine.removeLiquidity(ALICE, owned);
    assert.equal(engine.snapshot().totalSupply, MINIMUM_LIQUIDITY);
    assert.equal(engine.accountSnapshot(ALICE).lpShares, 0n);
    assert.throws(() => engine.removeLiquidity(ALICE, 1n), /Insufficient LP/);
    assert.ok(engine.snapshot().reserves.RUBA > 0n && engine.snapshot().reserves.USDT > 0n);
    conserved(engine);
  } finally { engine.close(); }
});

test("withdrawal is reserved before signing, survives recovery, then settles exactly once", () => {
  const engine = fixture();
  try {
    const before = engine.snapshot();
    const ticket = engine.reserveWithdrawal(BOB, "USDT", 100n * U, 1_000n, 1n);
    assert.equal(ticket.nonce, 0n);
    assert.equal(engine.accountSnapshot(BOB).balances.USDT, 900n * U);
    assert.equal(engine.snapshot().pending.USDT, 100n * U);
    assert.deepEqual(engine.snapshot().custody, before.custody);
    assert.deepEqual(engine.getPendingWithdrawal(BOB, 0n), ticket);
    assert.equal(engine.settleWithdrawal(BOB, 0n, "USDT", 100n * U, "tx1:0"), true);
    assert.equal(engine.settleWithdrawal(BOB, 0n, "USDT", 100n * U, "tx1:0"), false);
    assert.equal(engine.snapshot().custody.USDT, before.custody.USDT - 100n * U);
    assert.equal(engine.snapshot().pending.USDT, 0n);
    assert.equal(engine.getPendingWithdrawal(BOB, 0n), undefined);
    assert.throws(() => engine.settleWithdrawal(BOB, 0n, "USDT", 100n * U, "tx2:0"), /no longer pending/);
    const next = engine.reserveWithdrawal(BOB, "RUBA", R, 1_000n, 1n);
    assert.equal(next.nonce, 1n);
    conserved(engine);
  } finally { engine.close(); }
});

test("unknown or mismatched settlements and conflicting event IDs cannot remove custody", () => {
  const engine = fixture();
  try {
    engine.reserveWithdrawal(BOB, "USDT", U, 1_000n, 1n);
    engine.reserveWithdrawal(BOB, "USDT", U, 1_000n, 1n);
    const before = engine.snapshot();
    assert.throws(() => engine.settleWithdrawal(BOB, 0n, "USDT", 2n * U, "tx:0"), /mismatched/);
    assert.throws(() => engine.settleWithdrawal(BOB, 0n, "RUBA", U, "tx:0"), /mismatched/);
    assert.throws(() => engine.settleWithdrawal(ALICE, 0n, "USDT", U, "tx:0"), /mismatched/);
    assert.deepEqual(engine.snapshot(), before);
    engine.settleWithdrawal(BOB, 0n, "USDT", U, "tx:0");
    assert.throws(() => engine.settleWithdrawal(BOB, 1n, "USDT", U, "tx:0"), /Conflicting/);
    assert.equal(engine.getWithdrawal(BOB, 1n)?.status, "pending");
    conserved(engine);
  } finally { engine.close(); }
});

test("expiry requires finalized time after deadline and unused onchain nonce", () => {
  const engine = fixture();
  try {
    engine.reserveWithdrawal(BOB, "USDT", 100n * U, 1_000n, 1n);
    assert.throws(() => engine.expireWithdrawal(BOB, 0n, { finalizedTimestamp: 1_000n, nonceUsed: false }), /not finalized/);
    assert.throws(() => engine.expireWithdrawal(BOB, 0n, { finalizedTimestamp: 1_001n, nonceUsed: true }), /nonce has been used/);
    assert.equal(engine.accountSnapshot(BOB).balances.USDT, 900n * U);
    engine.expireWithdrawal(BOB, 0n, { finalizedTimestamp: 1_001n, nonceUsed: false });
    assert.equal(engine.accountSnapshot(BOB).balances.USDT, 1_000n * U);
    assert.equal(engine.snapshot().pending.USDT, 0n);
    assert.equal(engine.getWithdrawal(BOB, 0n)?.status, "expired");
    assert.throws(() => engine.expireWithdrawal(BOB, 0n, { finalizedTimestamp: 1_002n, nonceUsed: false }), /not pending/);
    conserved(engine);
  } finally { engine.close(); }
});

test("only every fourth trade creates a durable nonoverlapping outbox batch", () => {
  const engine = fixture();
  try {
    let previousRoot = ZERO_ROOT;
    for (let id = 1n; id <= 8n; id++) {
      const receipt = engine.swap(BOB, "RUBA", R, 0n);
      assert.equal(engine.listPendingBatches().length, Number(id / 4n));
      assert.deepEqual(engine.getBatchProgress(), { collected: Number(id % 4n), required: 4 });
      if (id % 4n !== 0n) {
        assert.equal(receipt.batchId, undefined);
        assert.equal(receipt.proof, undefined);
        assert.equal(engine.flushUnbatchedReceipts(), 0);
        assert.equal(engine.getBatch(id / 4n + 1n), undefined);
        continue;
      }
      const batch = engine.getBatch(id / 4n)!;
      assert.equal(batch.batchId, id / 4n); assert.equal(batch.firstTradeId, id - 3n); assert.equal(batch.tradeCount, 4n);
      assert.equal(batch.previousStateRoot, previousRoot);
      assert.equal(batch.newStateRoot, commitState(CONFIG.chainId, CONFIG.vaultAddress, batch.stateSnapshot, batch.stateSalt));
      assert.deepEqual(batch.tradeIds, [id - 3n, id - 2n, id - 1n, id]);
      assert.equal(JSON.parse(batch.stateSnapshot).nextTradeId, (id + 1n).toString());
      for (const tradeId of batch.tradeIds) {
        const stored = engine.getReceipt(tradeId)!;
        assert.equal(stored.batchId, id / 4n);
        assert.equal(stored.proof!.length, 2);
        assert.equal(hashReceipt(stored), stored.leaf);
        assert.equal(verifyMerkleProof(stored.leaf, stored.proof!, batch.receiptsRoot), true);
        assert.equal(verifyMerkleProof(hashReceipt({ ...stored, amountOut: stored.amountOut + 1n }), stored.proof!, batch.receiptsRoot), false);
      }
      previousRoot = batch.newStateRoot;
    }
    const txHash = "0x" + "ab".repeat(32);
    engine.markBatchPublished(1n, txHash);
    engine.markBatchPublished(1n, txHash);
    assert.deepEqual(engine.listPendingBatches().map((item) => item.batchId), [2n]);
    assert.throws(() => engine.markBatchPublished(1n, "0x" + "cd".repeat(32)), /another transaction/);
  } finally { engine.close(); }
});

test("Merkle trees support one to four leaves including duplicated odd siblings", () => {
  const leaves = Array.from({ length: 4 }, (_, index) => "0x" + (index + 1).toString(16).padStart(64, "0"));
  for (let size = 1; size <= 4; size++) {
    const { root, proofs } = buildMerkleBatch(leaves.slice(0, size));
    assert.equal(proofs.length, size);
    for (let index = 0; index < size; index++) {
      assert.equal(proofs[index].length, Math.ceil(Math.log2(size)));
      assert.equal(verifyMerkleProof(leaves[index], proofs[index], root), true);
      assert.equal(verifyMerkleProof(ZERO_ROOT, proofs[index], root), false);
    }
    if (size === 1) { assert.equal(root, leaves[0]); assert.deepEqual(proofs[0], []); }
    if (size === 3) assert.equal(proofs[2][0], leaves[2]);
  }
  assert.throws(() => buildMerkleBatch([]), /one to four/);
  assert.throws(() => buildMerkleBatch([...leaves, leaves[0]]), /one to four/);
  assert.throws(() => buildMerkleBatch(['0x123']), /Invalid receipt leaf/);
  const left = hashPair(leaves[0], leaves[1]); const right = hashPair(leaves[2], leaves[3]);
  assert.deepEqual(buildMerkleBatch(leaves), { root: hashPair(left, right),
    proofs: [[leaves[1], right], [leaves[0], right], [leaves[3], left], [leaves[2], left]] });
  assert.equal(canonicalJson({ z: 2n, a: { y: "v", x: 1n } }), canonicalJson({ a: { x: 1n, y: "v" }, z: 2n }));
});

test("restart preserves one-to-three-trade tails until exactly four trades collect", () => {
  for (const tailSize of [1, 2, 3]) {
    const directory = mkdtempSync(join(tmpdir(), "ruba-legacy-batches-"));
    const path = join(directory, "ledger.sqlite");
    let engine = fixture(path);
    try {
      for (let index = 0; index < 4 + tailSize; index++) engine.swap(BOB, "RUBA", R, 0n);
      engine.markBatchPublished(1n, '0x' + 'a1'.repeat(32));
      const historical = engine.getBatch(1n)!;
      const before = engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get();
      engine.close();
      engine = new RubaEngine({ ...CONFIG, dbPath: path });
      assert.equal(engine.getBatch(2n), undefined);
      assert.deepEqual(engine.getBatchProgress(), { collected: tailSize, required: 4 });
      assert.equal(engine.flushUnbatchedReceipts(), 0);
      assert.deepEqual(engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get(), before);
      assert.deepEqual(engine.getBatch(1n), historical);
      for (let id = 1n; id <= 4n; id++) {
        const receipt = engine.getReceipt(id)!;
        assert.equal(verifyMerkleProof(receipt.leaf, receipt.proof!, engine.getBatch(receipt.batchId!)!.receiptsRoot), true);
      }
      for (let index = tailSize; index < 4; index++) {
        engine.swap(BOB, "USDT", U, 0n);
        if (index < 3) assert.equal(engine.getBatch(2n), undefined);
      }
      const recovered = engine.getBatch(2n)!;
      assert.equal(recovered.firstTradeId, 5n);
      assert.equal(recovered.tradeCount, 4n);
      assert.equal(recovered.previousStateRoot, historical.newStateRoot);
      assert.deepEqual(recovered.tradeIds, [5n, 6n, 7n, 8n]);
      assert.deepEqual(engine.getBatch(1n), historical);
      assert.deepEqual(engine.getBatchProgress(), { collected: 0, required: 4 });
      assert.deepEqual(engine.listPendingBatches().map((batch) => batch.batchId), [2n]);
      conserved(engine);
    } finally { engine.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("historical singleton commitments remain unchanged while new batches contain four trades", () => {
  const directory = mkdtempSync(join(tmpdir(), "ruba-historical-singleton-"));
  const path = join(directory, "ledger.sqlite");
  let engine = fixture(path);
  try {
    engine.swap(BOB, "RUBA", R, 0n);
    const row = engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string };
    const state = JSON.parse(row.state, (_key, item) => item && typeof item === 'object' && '$bigint' in item ? BigInt(item.$bigint) : item);
    const stateSalt = '0x' + '31'.repeat(32);
    const stateSnapshot = '{"historicalMode":"singleton"}';
    const historical = { batchId: 1n, previousStateRoot: ZERO_ROOT,
      newStateRoot: commitState(CONFIG.chainId, CONFIG.vaultAddress, stateSnapshot, stateSalt),
      receiptsRoot: state.receipts[0].leaf, firstTradeId: 1n, tradeCount: 1n,
      stateSalt, stateSnapshot, tradeIds: [1n], publishedTxHash: '0x' + 'a1'.repeat(32) };
    state.batches = [historical]; state.receipts[0].batchId = 1n; state.receipts[0].proof = [];
    engine.db.prepare('UPDATE engine_state SET state=? WHERE id=1').run(JSON.stringify(state, (_key, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item));
    engine.close(); engine = new RubaEngine({ ...CONFIG, dbPath: path });
    assert.equal(engine.flushUnbatchedReceipts(), 0);
    assert.deepEqual(engine.getBatch(1n), historical);
    for (let count = 1; count <= 4; count++) {
      engine.swap(BOB, "USDT", U, 0n);
      assert.deepEqual(engine.getBatch(1n), historical);
      if (count < 4) assert.equal(engine.getBatch(2n), undefined);
    }
    assert.equal(engine.getBatch(2n)!.firstTradeId, 2n);
    assert.equal(engine.getBatch(2n)!.tradeCount, 4n);
    assert.deepEqual(engine.getBatch(2n)!.tradeIds, [2n, 3n, 4n, 5n]);
    assert.equal(engine.getBatch(2n)!.previousStateRoot, historical.newStateRoot);
  } finally { engine.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("missing boundary snapshots fail closed instead of inventing historical batches", () => {
  const engine = fixture();
  try {
    for (let index = 0; index < 5; index++) engine.swap(BOB, "RUBA", R, 0n);
    const row = engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string };
    const state = JSON.parse(row.state, (_key, item) => item && typeof item === 'object' && '$bigint' in item ? BigInt(item.$bigint) : item);
    state.batches = [];
    for (const receipt of state.receipts) { delete receipt.batchId; delete receipt.proof; }
    const encoded = JSON.stringify(state, (_key, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item);
    engine.db.prepare('UPDATE engine_state SET state=? WHERE id=1').run(encoded);
    assert.throws(() => engine.flushUnbatchedReceipts(), /boundary snapshot/);
    assert.throws(() => engine.getBatchProgress(), /boundary snapshot/);
    assert.throws(() => engine.swap(BOB, "USDT", U, 0n), /boundary snapshot/);
    assert.equal((engine.db.prepare('SELECT state FROM engine_state WHERE id=1').get() as { state: string }).state, encoded);
    assert.equal(engine.listPendingBatches().length, 0);
  } finally { engine.close(); }
});

test("getters return copies and cannot mutate balances, tickets, receipts or batches", () => {
  const engine = fixture();
  try {
    const snapshot = engine.snapshot(); snapshot.reserves.USDT = 0n;
    const account = engine.accountSnapshot(BOB); account.balances.USDT = 0n;
    engine.reserveWithdrawal(BOB, "USDT", U, 1_000n, 1n);
    const ticket = engine.getWithdrawal(BOB, 0n)!; ticket.amount = 1_000n * U;
    for (let index = 0; index < 4; index++) engine.swap(BOB, "RUBA", R, 0n);
    const receipt = engine.getReceipt(1n)!; receipt.amountOut = 0n;
    const batch = engine.getBatch(1n)!; batch.receiptsRoot = ZERO_ROOT;
    assert.notEqual(engine.snapshot().reserves.USDT, 0n);
    assert.equal(engine.getWithdrawal(BOB, 0n)!.amount, U);
    assert.notEqual(engine.getReceipt(1n)!.amountOut, 0n);
    assert.notEqual(engine.getBatch(1n)!.receiptsRoot, ZERO_ROOT);
    conserved(engine);
  } finally { engine.close(); }
});

test("ledger, action nonces, reserved payouts and batch outbox survive process restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "ruba-engine-"));
  const path = join(directory, "ledger.sqlite");
  let engine = fixture(path);
  try {
    for (let index = 0; index < 4; index++) engine.executeAction(BOB, BigInt(index), () => engine.swap(BOB, "RUBA", R, 0n));
    const ticket = engine.executeAction(BOB, 4n, () => engine.reserveWithdrawal(BOB, "USDT", 50n * U, 1_000n, 1n));
    const before = engine.snapshot(); const batch = engine.getBatch(1n);
    engine.close();
    engine = new RubaEngine({ ...CONFIG, dbPath: path });
    assert.deepEqual(engine.snapshot(), before);
    assert.equal(engine.getActionNonce(BOB), 5n);
    assert.deepEqual(engine.getPendingWithdrawal(BOB, ticket.nonce), ticket);
    assert.deepEqual(engine.getBatch(1n), batch);
    assert.equal(engine.listPendingBatches().length, 1);
    assert.equal(engine.recordDeposit(1n, ALICE, "RUBA", 2_000n * R), false);
    conserved(engine);
  } finally { engine.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("database cannot be reopened under a different vault or token pair", () => {
  const directory = mkdtempSync(join(tmpdir(), "ruba-domain-"));
  const path = join(directory, "ledger.sqlite");
  const engine = new RubaEngine({ ...CONFIG, dbPath: path }); engine.close();
  try {
    assert.throws(() => new RubaEngine({ ...CONFIG, dbPath: path, chainId: 1n }), /another market/);
    assert.throws(() => new RubaEngine({ ...CONFIG, dbPath: path, vaultAddress: ALICE }), /another market/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("repeated trades in both directions preserve backing and permanently fixed LP supply", () => {
  const engine = fixture();
  try {
    const initialSupply = engine.snapshot().totalSupply;
    const custody = engine.snapshot().custody;
    let previousK = engine.snapshot().reserves.RUBA * engine.snapshot().reserves.USDT;
    for (let step = 1; step <= 80; step++) {
      const token = step % 2 ? "RUBA" : "USDT";
      const amount = BigInt(step % 7 + 1) * (token === "RUBA" ? R : U);
      engine.swap(BOB, token, amount, 0n);
      const snapshot = engine.snapshot();
      const k = snapshot.reserves.RUBA * snapshot.reserves.USDT;
      assert.ok(k >= previousK); previousK = k;
      assert.equal(snapshot.totalSupply, initialSupply);
      assert.deepEqual(snapshot.custody, custody);
      conserved(engine);
    }
    assert.equal(engine.listPendingBatches().length, 20);
  } finally { engine.close(); }
});
