import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Interface, Wallet, keccak256 } from 'ethers';
import { existsSync } from 'node:fs';
import { VAULT_ABI } from '../chain.ts';
import { ZkVaultChain, ZK_VAULT_ABI } from '../zk/chain.ts';
import type { ServerConfig } from '../config.ts';
import type { ZkRubaEngine } from '../zk/engine.ts';
import { SIGNAL } from '../zk/types.ts';
import { Groth16TransitionProver } from '../zk/prover.ts';
import { registrationFixture } from '../../zk/tests/fixtures.ts';

const wallet = new Wallet('0x' + '11'.repeat(32));
const operator = new Wallet('0x' + '22'.repeat(32));
const vault = '0x0000000000000000000000000000000000000001';
const ruba = '0x0000000000000000000000000000000000000002';
const usdt = '0x0000000000000000000000000000000000000003';
const hash = (number: number | bigint) => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
const ZERO_ADDRESS = '0x' + '00'.repeat(20);
const signals = (version = 1n, mode = 0n) => [101n, version, mode, 100n, 200n, 0n, 0n, 1n, mode ? 5n : 1n, mode ? 777n : 0n, 88n, 99n, 109n];

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE indexer_checkpoint (id INTEGER PRIMARY KEY,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL)');
  const config: ServerConfig = {
    rpcUrl: 'http://127.0.0.1:8545', chainId: 31337n, vaultAddress: vault, rubaAddress: ruba, usdtAddress: usdt,
    operatorPrivateKey: operator.privateKey, deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n,
    dbPath: ':memory:', host: '127.0.0.1', port: 3001, syncIntervalMs: 2000,
  };
  const state = {
    version: 0n, confirmedVersion: 0n, root: 100n, cursor: 0n, inboxCount: 0n, capacity: true,
    head: undefined as any, transitions: [] as any[], accepted: 0n, acceptedRoot: 100n,
    proofCalls: 0, signatureEpoch: 1n, applied: [] as any[], logs: [] as any[],
    inbox: new Map<bigint, any>(), receipts: new Map<string, any>(), changed: false,
  };
  const abi = new Interface(VAULT_ABI), zkAbi = new Interface(ZK_VAULT_ABI);
  const engine = {
    db,
    getGenesisStateRoot: () => 100n, getDomain: () => 101n, getPoolKeyCommit: () => 109n,
    listTransitions: () => state.transitions,
    getTransition: (version: bigint) => state.transitions.find((transition) => transition.stateVersion === version),
    getPendingTransition: () => state.head,
    getTransitionForBatch: (batchId: bigint) => state.transitions.find((transition) => transition.tradeBatchId === batchId),
    getAcceptedCheckpoint: () => {
      const accepted = state.transitions.find((transition) => transition.stateVersion === state.accepted);
      const nextTradeId = accepted ? accepted.publicSignals[SIGNAL.newTradeId] : 1n;
      return { stateVersion: state.accepted, root: state.acceptedRoot, inboxCursor: 0n, nextTradeId,
        tradeBatchId: BigInt(state.transitions.filter((transition) => transition.stateVersion <= state.accepted && transition.publicSignals[SIGNAL.mode] === 1n).length) };
    },
    getCurrentInboxCursor: () => state.cursor,
    canApplyInboxRecord: () => state.capacity,
    applyInboxRecord(record: any) { assert.equal(record.eventId, state.cursor + 1n); state.applied.push(record); state.cursor++; },
    getBatchProgress: () => ({ collected: 0, required: 4 as const }),
    markTransitionAccepted(version: bigint, transactionHash: string, blockNumber: number) {
      assert.equal(blockNumber, 10); assert.equal(transactionHash, hash(900 + Number(version)));
      state.accepted = version; state.acceptedRoot = state.transitions.find((transition) => transition.stateVersion === version).publicSignals[SIGNAL.newRoot];
      if (state.head?.stateVersion === version) state.head = undefined;
    },
  } as unknown as ZkRubaEngine;
  const provider = {
    async getBlock(tag: string | number) { const number = tag === 'latest' ? 20 : Number(tag); return { number, timestamp: 1000 + number, hash: hash(number + (state.changed ? 100 : 0)) }; },
    async getLogs(filter: any) { return state.logs.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock && filter.topics.every((topic: string, index: number) => topic === log.topics[index])); },
    async getTransactionReceipt(transactionHash: string) { return state.receipts.get(transactionHash) ?? null; },
  };
  const zkVault = {
    async stateVersion(options?: any) { return options && options.blockTag !== 20 ? state.confirmedVersion : state.version; },
    async transitions(version: bigint) { return state.transitions.find((transition) => transition.stateVersion === version)?.publicSignals; },
    async inboxCursor() { return 0n; }, async nextTradeId() { return 1n; },
    async nextInboxEventId() { return state.inboxCount + 1n; }, async inbox(eventId: bigint) { return state.inbox.get(eventId); },
    async publishZkTransition() { throw new Error('The server must never submit a proof transaction'); },
  };
  const prover = {
    async prove(transition: any) { state.proofCalls++; return { publicSignals: transition.publicSignals, proof: { a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] } }; },
  };
  const chain = Object.assign(Object.create(ZkVaultChain.prototype), {
    config, engine, provider, wallet: operator, abi, zkAbi, zkVault, prover,
    confirmedBlock: () => provider.getBlock(19),
    vault: {
      async stateRoot(options?: any) { return hash(options && options.blockTag !== 20 && state.confirmedVersion < state.version ? 100n : state.root); }, async signerEpoch() { return state.signatureEpoch; }, async operator() { return operator.address; },
      async publishSignedBatch() { throw new Error('Legacy publication is forbidden'); },
    },
  }) as ZkVaultChain;
  function transition(mode = 0n) {
    const empty = { kind: 0n, slot: 0n, owner: 0n, commitment: 0n, eventId: 0n, token: 0n, amount: 0n, reference: 0n, signature: '0x' };
    const value = {
      stateVersion: 1n, tradeBatchId: mode === 1n ? 1n : 0n, publicSignals: signals(1n, mode), witness: {},
      metadata: Array.from({ length: 8 }, () => ({ ...empty })),
      accountDA: Array.from({ length: 8 }, () => ({ kind: 0n, slot: 0n, owner: 0n, newLeaf: 0n, ciphertext: Array(7).fill(0n) })),
      poolDA: { poolHash: 0n, poolCiphertext: Array(6).fill(0n) },
    };
    state.transitions = [value]; state.head = value; return value;
  }
  function publication(value: any, success = true) {
    const batchId = BigInt(state.transitions.filter((transition) => transition.stateVersion <= value.stateVersion && transition.publicSignals[SIGNAL.mode] === 1n).length);
    const encoded = zkAbi.encodeEventLog(zkAbi.getEvent('ZkTransitionPublished')!, [value.stateVersion, batchId, value.publicSignals]);
    const transactionHash = hash(900 + Number(value.stateVersion));
    const log = { address: vault, ...encoded, blockNumber: 10, blockHash: hash(10), transactionHash, index: 0, removed: false };
    state.logs.push(log); state.receipts.set(transactionHash, { status: success ? 1 : 0, blockNumber: 10, blockHash: hash(10), logs: [log] });
    return transactionHash;
  }
  function inboxEvent(eventId: bigint, kind: 2 | 7, reference: bigint, legacyIndex: number) {
    const transactionHash = hash(100n + eventId);
    const message = { kind: BigInt(kind), owner: wallet.address, tokenIndex: 1n, amount: 123n, referenceId: reference };
    state.inbox.set(eventId, message); state.inboxCount = eventId;
    const canonical = { address: vault, ...zkAbi.encodeEventLog(zkAbi.getEvent('CanonicalInboxAppended')!, [eventId, kind, wallet.address, 1n, 123n, reference]), blockNumber: 10, index: legacyIndex + 1, transactionHash, removed: false };
    const legacy = { address: vault, ...(kind === 2
      ? abi.encodeEventLog(abi.getEvent('Deposited')!, [reference, wallet.address, usdt, 123n])
      : abi.encodeEventLog(abi.getEvent('Withdrawn')!, [wallet.address, usdt, 123n, reference, 1n])), index: legacyIndex };
    state.logs.push(canonical); state.receipts.set(transactionHash, { status: 1, blockNumber: 10, blockHash: hash(10), logs: [legacy, canonical] });
  }
  return { db, config, chain, state, zkVault, engine, transition, publication, inboxEvent, close: () => db.close() };
}

test('ZK publication exposes only its proof-bound calldata without an operator signature or transaction', async () => {
  const f = fixture();
  try {
    f.transition(1n);
    Object.assign(f.chain, { wallet: { address: operator.address, signTypedData() { throw new Error('Proof publication must not require an operator signature'); } } });
    Object.assign(f.chain.vault, { async operator() { throw new Error('Operator rotation is irrelevant'); }, async signerEpoch() { throw new Error('Operator epoch is irrelevant'); } });
    const prepared = await f.chain.getPublicationRequest();
    assert.equal(prepared.status, 'ready');
    const request = prepared.request!;
    assert.equal(request.kind, 'zk');
    if (request.kind !== 'zk') throw new Error('Expected ZK publication');
    assert.equal(request.batch.batchId, 1n); assert.equal(request.batch.tradeCount, 4n);
    assert.equal(request.operations.length, 8); assert.equal(request.operations[0].owner, ZERO_ADDRESS);
    assert.equal(request.authorizationMode, 'proof-only');
    assert.deepEqual(request.authorization, { deadline: 0n, signerEpoch: 0n, signature: '0x' });
    assert.equal('witness' in request, false); assert.equal('poolRecoveryKey' in request, false);
    assert.equal(f.state.proofCalls, 1);
    f.state.signatureEpoch++;
    const refreshed = await f.chain.getPublicationRequest();
    assert.deepEqual(refreshed.request, request, 'Changing the administrator epoch cannot change or gate a valid proof');
  } finally { f.close(); }
});

test('ZK control proof uses the common state chain but cannot be retrieved as a trade receipt batch', async () => {
  const f = fixture();
  try {
    f.transition();
    const prepared = await f.chain.getPublicationRequest();
    assert.equal(prepared.request!.batch.batchId, 0n); assert.equal(prepared.request!.batch.tradeCount, 0n);
    assert.equal(await f.chain.getDisclosureBatch(1n), undefined);
    f.state.root = 999n;
    await assert.rejects(f.chain.getPublicationRequest(), /genesis differs|does not continue/);
  } finally { f.close(); }
});

for (const count of [1n, 2n, 3n, 4n]) test(`ZK partial batch with ${count} swaps preserves actual counts through publication, acceptance and disclosure`, async () => {
  const f = fixture();
  try {
    const transition = f.transition(1n);
    transition.publicSignals[SIGNAL.newTradeId] = 1n + count;
    const prepared = await f.chain.getPublicationRequest();
    assert.equal(prepared.request!.batch.tradeCount, count);
    assert.equal((await f.chain.getDisclosureBatch(1n))!.batch.tradeCount, count);
    f.publication(transition);
    f.state.version = 1n; f.state.confirmedVersion = 1n; f.state.root = 200n;
    await f.chain.publishPendingBatches();
    // A second observation also validates the persisted checkpoint's batch ID.
    await f.chain.publishPendingBatches();
    assert.equal(f.state.accepted, 1n);
    const disclosed = await f.chain.getDisclosureBatch(1n);
    assert.equal(disclosed!.status, 'published');
    assert.equal(disclosed!.batch.batchId, 1n);
    assert.equal(disclosed!.batch.tradeCount, count);
  } finally { f.close(); }
});

for (const count of [0n, 5n]) test(`ZK publication refuses a trade transition with ${count} swaps before proving`, async () => {
  const f = fixture();
  try {
    const transition = f.transition(1n);
    transition.publicSignals[SIGNAL.newTradeId] = 1n + count;
    await assert.rejects(f.chain.getPublicationRequest(), /invalid transition mode\/trade/);
    assert.equal(f.state.proofCalls, 0);
  } finally { f.close(); }
});

test('ZK canonical inbox consumes a sequential confirmed prefix and preserves original bridge event identifiers', async () => {
  const f = fixture();
  try {
    f.inboxEvent(1n, 2, 9n, 4);
    f.inboxEvent(2n, 7, 12n, 7);
    f.state.capacity = false;
    await f.chain.sync();
    assert.equal(f.state.cursor, 0n, 'backpressure must not silently consume or discard bridge events');
    f.state.capacity = true;
    await f.chain.sync();
    assert.equal(f.state.cursor, 2n);
    assert.equal(f.state.applied[0].reference, 9n);
    assert.equal(f.state.applied[0].legacyEventId, '9');
    assert.equal(f.state.applied[1].legacyEventId, `31337:${vault}:${hash(102)}:7`);
    await f.chain.sync();
    assert.equal(f.state.applied.length, 2, 'replaying indexer reads cannot credit the same canonical inbox twice');
    f.state.changed = true;
    await assert.rejects(f.chain.sync(), /reorganization/);
  } finally { f.close(); }
});

test('ZK canonical inbox refuses invented bridge preimages without matching original vault logs', async () => {
  const f = fixture();
  try {
    f.inboxEvent(1n, 2, 9n, 0);
    f.state.receipts.get(hash(101)).logs.shift();
    await assert.rejects(f.chain.sync(), /no matching original/);
    assert.equal(f.state.cursor, 0n);
  } finally { f.close(); }
});

test('ZK observer waits for finality and accepts only the real successful matching publication event', async () => {
  const f = fixture();
  try {
    const value = f.transition(1n);
    f.state.version = 1n; f.state.root = 200n;
    f.publication(value);
    assert.equal((await f.chain.getPublicationRequest()).status, 'waiting');
    assert.equal(f.state.accepted, 0n);
    f.state.confirmedVersion = 1n;
    await f.chain.publishPendingBatches();
    assert.equal(f.state.accepted, 1n);
    const disclosed = await f.chain.getDisclosureBatch(1n);
    assert.equal(disclosed?.status, 'published');
    assert.equal(disclosed?.batch.publishedTxHash, hash(901));
    assert.equal((disclosed as any).schemaVersion, 2);
    assert.equal((await f.chain.getPublicationRequest()).status, 'idle');
  } finally { f.close(); }
});

test('ZK observer refuses a published root without a durable matching journal and never reseeds genesis', async () => {
  const f = fixture();
  try {
    f.state.version = 1n; f.state.confirmedVersion = 1n; f.state.root = 200n;
    await assert.rejects(f.chain.publishPendingBatches(), /no matching server journal/);
    assert.equal(f.state.accepted, 0n);
    await assert.rejects(f.chain.getPublicationRequest(), /restore the database/);
  } finally { f.close(); }
});

test('ZK observer validates a confirmed snapshot while a newer root is still unconfirmed', async () => {
  const f = fixture();
  try {
    const value = f.transition(1n); f.publication(value);
    f.state.version = 1n; f.state.root = 200n;
    const version = f.zkVault.stateVersion.bind(f.zkVault), root = f.chain.vault.stateRoot.bind(f.chain.vault);
    f.zkVault.stateVersion = async (options?: any) => { assert.ok(options, 'A moving latest version must not be mixed with historical roots'); return version(options); };
    Object.assign(f.chain.vault, { stateRoot: async (options?: any) => { assert.ok(options); return root(options); } });
    await f.chain.publishPendingBatches();
    assert.equal(f.state.accepted, 0n); f.chain.assertHealthy();
    f.state.confirmedVersion = 1n;
    await f.chain.publishPendingBatches(); assert.equal(f.state.accepted, 1n);
  } finally { f.close(); }
});

test('direct publication preparation and canonical inbox sync share one observer queue', async () => {
  const f = fixture();
  try {
    f.transition();
    let release!: () => void, started!: () => void, inboxReads = 0;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const proving = new Promise<void>((resolve) => { started = resolve; });
    const original = f.chain.prover.prove.bind(f.chain.prover);
    Object.assign(f.chain.prover, { prove: async (transition: any) => { started(); await blocked; return original(transition); } });
    f.zkVault.nextInboxEventId = async () => { inboxReads++; return 1n; };
    const publication = f.chain.getPublicationRequest(); await proving;
    const sync = f.chain.sync(); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inboxReads, 0, 'Sync must not interleave mutable journal reads with a direct publication');
    release(); await publication; await sync; assert.equal(inboxReads, 1);
  } finally { f.close(); }
});

test('inconsistent RPC inbox snapshots retry without crediting an absent record or poisoning the journal', async () => {
  const f = fixture();
  try {
    f.inboxEvent(1n, 2, 9n, 0);
    const original = f.zkVault.inbox.bind(f.zkVault); let reads = 0;
    f.zkVault.inbox = async (eventId: bigint) => ++reads === 1 ? { kind: 0n } : original(eventId);
    await f.chain.sync(); assert.equal(reads, 2); assert.equal(f.state.applied.length, 1); f.chain.assertHealthy();
    f.state.cursor = 0n; f.state.applied.length = 0; reads = 0;
    f.zkVault.inbox = async () => { reads++; return { kind: 0n }; };
    await assert.rejects(f.chain.sync(), /RPC snapshot is inconsistent/);
    assert.equal(reads, 3); assert.equal(f.state.applied.length, 0); f.chain.assertHealthy();
    f.zkVault.inbox = original;
    await f.chain.sync(); assert.equal(f.state.applied.length, 1);
  } finally { f.close(); }
});

test('ZK observer anchors an accepted checkpoint to its own confirmed header and finality', async () => {
  for (const tamper of ['root', 'finality'] as const) {
    const f = fixture();
    try {
      f.transition(1n);
      f.state.version = 1n; f.state.root = 200n; f.state.accepted = 1n;
      f.state.acceptedRoot = tamper === 'root' ? 999n : 200n;
      f.state.confirmedVersion = tamper === 'finality' ? 0n : 1n;
      await assert.rejects(f.chain.publishPendingBatches(), tamper === 'root' ? /checkpoint differs/ : /ahead of confirmed/);
    } finally { f.close(); }
  }
});

test('ZK control transitions after a trade retain the global trade-batch counter in their event', async () => {
  const f = fixture();
  try {
    const trade = f.transition(1n);
    const control = structuredClone(trade);
    control.stateVersion = 2n; control.tradeBatchId = undefined as any;
    control.publicSignals = [101n, 2n, 0n, 200n, 300n, 0n, 0n, 5n, 5n, 0n, 88n, 99n, 109n];
    f.state.transitions.push(control); f.state.head = control;
    f.publication(trade); f.publication(control);
    f.state.version = 2n; f.state.confirmedVersion = 2n; f.state.root = 300n;
    await f.chain.publishPendingBatches();
    assert.equal(f.state.accepted, 2n);
    assert.equal(f.engine.getAcceptedCheckpoint().tradeBatchId, 1n);
    assert.equal((await f.chain.getDisclosureBatch(1n))?.status, 'published');
  } finally { f.close(); }
});

test('ZK startup refuses legacy proof capabilities and unpinned verifier bytecode before ledger changes', async () => {
  const f = fixture();
  try {
    const provider = {
      ...f.chain.provider,
      async getNetwork() { return { chainId: 31337n }; },
      async getCode() { return '0x1234'; },
    };
    Object.assign(f.chain, {
      provider,
      prover: { initialize: () => ({ verifierRuntimeCodeHash: hash(999) }) },
      zkVault: { async proofMode() { return 'legacy'; }, async ZK_VERSION() { return 1n; } },
    });
    await assert.rejects(f.chain.initialize(), /legacy fallback is disabled/);
    assert.equal(f.state.applied.length, 0);
    Object.assign(f.chain, { zkVault: {
      async proofMode() { return 'groth16-bn254-v2'; }, async ZK_VERSION() { return 2n; },
      async withdrawalMode() { return 'proven-reservation-v1'; },
      async verifier() { return ruba; }, async poseidon2() { return usdt; },
      async verifierCodeHash() { return keccak256('0x1234'); }, async poseidonCodeHash() { return keccak256('0x1234'); },
      async domain() { return 101n; }, async poolKeyCommit() { return 109n; }, async genesisStateRoot() { return hash(100); },
    }, vault: { async ruba() { return ruba; }, async usdt() { return usdt; }, async operator() { return operator.address; } } });
    await assert.rejects(f.chain.initialize(), /verifier bytecode differs/);
    assert.equal(f.db.prepare('SELECT * FROM indexer_checkpoint').get(), undefined);
  } finally { f.close(); }
});

test('ZK startup refuses an old operator-authorized v2 withdrawal capability', async () => {
  const f = fixture();
  try {
    Object.assign(f.chain, {
      provider: { async getNetwork() { return { chainId: 31337n }; }, async getCode() { return '0x1234'; } },
      prover: { initialize: () => ({}) },
      zkVault: { async proofMode() { return 'groth16-bn254-v2'; }, async ZK_VERSION() { return 2n; }, async withdrawalMode() { return 'operator-signed-v2'; } },
    });
    await assert.rejects(f.chain.initialize(), /withdrawalMode=proven-reservation-v1/);
    assert.equal(f.db.prepare('SELECT * FROM indexer_checkpoint').get(), undefined);
  } finally { f.close(); }
});

test('ZK withdrawal opening is unsigned, non-expiring and independent of operator rotation', async () => {
  const f = fixture();
  try {
    Object.assign(f.chain.vault, {
      async withdrawalsPaused() { return false; },
      async operator() { throw new Error('No operator gate'); }, async signerEpoch() { throw new Error('No epoch gate'); },
    });
    assert.deepEqual(await f.chain.withdrawalContext('USDT'), { deadline: (1n << 64n) - 1n, signerEpoch: 0n });
    const record = { account: wallet.address, token: 'USDT' as const, tokenAddress: usdt, amount: 123n, nonce: 5n, deadline: (1n << 64n) - 1n, signerEpoch: 0n, status: 'pending' as const };
    Object.assign(f.engine, { getProvenWithdrawal(input: unknown) {
      assert.deepEqual({ ...(input as object), status: 'pending' }, record);
      return { withdrawal: { account: wallet.address, token: usdt, amount: 123n, nonce: 5n, spendNonce: 5n, salt: 77n }, commitment: 456n, stateVersion: null };
    } });
    const ticket = await f.chain.signWithdrawal(record);
    assert.equal(ticket.kind, 'zk-withdrawal');
    assert.equal(ticket.withdrawal.nonce, ticket.withdrawal.spendNonce);
    assert.equal(ticket.stateVersion, null);
    assert.equal('signature' in ticket, false);
    const settled = await f.chain.signWithdrawal({ ...record, status: 'settled' });
    assert.deepEqual(settled, ticket, 'A settled reservation exposes the same owner-bound opening for an on-chain spent check');
    await assert.rejects(f.chain.signWithdrawal({ ...record, status: 'expired' }), /proven reservation/);
    await assert.rejects(f.chain.expiryContext(wallet.address, 5n), /do not expire/);
    await assert.rejects(f.chain.expireWithdrawal(wallet.address, 5n), /cannot be refunded/);
    Object.assign(f.chain.vault, { async withdrawalsPaused() { return true; } });
    await assert.rejects(f.chain.withdrawalContext('USDT'), /paused/);
  } finally { f.close(); }
});

test('real Groth16 prover generates, verifies and immutably caches a registration proof', {
  skip: !existsSync('zk/artifacts/manifest.json') || !existsSync('zk/artifacts/transition_final.zkey'),
  timeout: 240_000,
}, async () => {
  const db = new DatabaseSync(':memory:');
  let prover: Groth16TransitionProver | undefined;
  let restarted: Groth16TransitionProver | undefined;
  try {
    const fixture = registrationFixture();
    const transition = { stateVersion: 1n, publicSignals: fixture.publicSignals, witness: fixture.witness };
    prover = new Groth16TransitionProver(db);
    const generated = await prover.prove(transition);
    assert.deepEqual(generated.publicSignals, fixture.publicSignals.map(BigInt));
    assert.equal(generated.proof.a.length, 2); assert.equal(generated.proof.b.length, 2);
    restarted = new Groth16TransitionProver(db);
    assert.deepEqual(await restarted.prove(transition), generated);
    await prover.close();
    assert.deepEqual(await restarted.prove(transition), generated, 'Closing one market must not terminate a curve still used by another prover');
    const forged = structuredClone(transition);
    forged.witness.newAccounts[0][0] = (BigInt(forged.witness.newAccounts[0][0]) + 1n).toString();
    await assert.rejects(restarted.prove(forged), /Immutable ZK transition witness/);
    const cached = db.prepare('SELECT * FROM zk_proof_cache WHERE state_version=?').get('1') as { proof_json: string; witness_hash: string };
    assert.equal(cached.witness_hash.length, 64);
    const tampered = JSON.parse(cached.proof_json);
    tampered.pi_a[0] = '0';
    db.prepare('UPDATE zk_proof_cache SET proof_json=? WHERE state_version=?').run(JSON.stringify(tampered), '1');
    await assert.rejects(restarted.prove(transition), /proof|curve|point/i);
  } finally { await restarted?.close(); await prover?.close(); db.close(); }
});
