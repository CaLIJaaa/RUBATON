import type { DatabaseSync } from 'node:sqlite';
import type { TradeReceipt } from '../types.ts';
import type { State } from '../engine.ts';

export const PROVEN_WITHDRAWAL_MODE = 'proven-reservation-v1' as const;
export interface ProvenWithdrawalOpening {
  account: string;
  token: string;
  amount: bigint;
  nonce: bigint;
  spendNonce: bigint;
  salt: bigint;
}
export interface ProvenWithdrawalData {
  withdrawal: ProvenWithdrawalOpening;
  commitment: bigint;
}
export interface PreparedProvenWithdrawal extends ProvenWithdrawalData {
  stateVersion: bigint | null;
}

export type AccountFields = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
export type PoolFields = [bigint, bigint, bigint, bigint, bigint, bigint];
export type OperationParams = [bigint, bigint, bigint, bigint];
export interface ZkState {
  accounts: AccountFields[];
  pool: PoolFields;
  inboxCursor: bigint;
  nextTradeId: bigint;
  accountsRoot: bigint;
  poolHash: bigint;
  root: bigint;
}
export interface OperationMetadata {
  kind: bigint; slot: bigint; owner: bigint; commitment: bigint;
  eventId: bigint; token: bigint; amount: bigint; reference: bigint; signature: string;
}
export interface AccountDA {
  kind: bigint; slot: bigint; owner: bigint; newLeaf: bigint; ciphertext: bigint[];
}
export interface ZkOperationRecord {
  seq: number;
  kind: number;
  slot: number;
  owner: bigint;
  params: OperationParams;
  oldAccount: AccountFields;
  newAccount: AccountFields;
  path: bigint[];
  oldPool: PoolFields;
  newPool: PoolFields;
  recoveryKey: bigint;
  metadata: OperationMetadata;
  da: AccountDA;
  receiptSalt: bigint;
  receipt?: TradeReceipt;
  beforeState: ZkState;
  afterState: ZkState;
  /** Private operational claim details retained for deterministic full-server recovery. */
  ledgerAfter?: State;
  /** The exact opening authorized by this actual kind6 mutation, saved before HTTP responds. */
  provenWithdrawal?: ProvenWithdrawalData;
}
export interface ZkTransition {
  stateVersion: bigint;
  mode: 0 | 1;
  previousRoot: bigint;
  newRoot: bigint;
  previousInboxCursor: bigint;
  newInboxCursor: bigint;
  previousTradeId: bigint;
  newTradeId: bigint;
  receiptsRoot: bigint;
  authDigest: bigint;
  daDigest: bigint;
  publicSignals: bigint[];
  metadata: OperationMetadata[];
  accountDA: AccountDA[];
  poolDA: { poolHash: bigint; poolCiphertext: bigint[] };
  witness: Record<string, unknown>;
  operations: ZkOperationRecord[];
  startingState: ZkState;
  endingState: ZkState;
  firstSeq: number;
  lastSeq: number;
  tradeBatchId?: bigint;
  status: 'pending' | 'accepted';
  txHash?: string;
  blockNumber?: number;
}
export interface AcceptedCheckpoint {
  stateVersion: bigint;
  root: bigint;
  inboxCursor: bigint;
  nextTradeId: bigint;
  tradeBatchId: bigint;
  journalSeq: number;
  state: ZkState;
  txHash?: string;
  blockNumber?: number;
}

export function encodeZk(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item);
}
export function decodeZk<T>(value: string): T {
  return JSON.parse(value, (_key, item) => item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.$bigint === 'string' ? BigInt(item.$bigint) : item) as T;
}
export function cloneZk<T>(value: T): T { return decodeZk<T>(encodeZk(value)); }

/** All writes run inside the engine's economic SQLite transaction. No in-memory write cache. */
export class ZkJournal {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS zk_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS zk_current (id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS zk_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS zk_keys (slot INTEGER PRIMARY KEY,recovery_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS zk_operations (seq INTEGER PRIMARY KEY AUTOINCREMENT,record TEXT NOT NULL,transition_version TEXT);
      CREATE TABLE IF NOT EXISTS zk_transitions (version INTEGER PRIMARY KEY,record TEXT NOT NULL)`);
  }
  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM zk_meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO zk_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  initialize(state: ZkState, poolRecoveryKey: bigint): void {
    this.setMeta('schema', '2'); this.setMeta('poolRecoveryKey', poolRecoveryKey.toString());
    this.setMeta('withdrawalMode', PROVEN_WITHDRAWAL_MODE);
    this.setMeta('genesis', state.root.toString());
    this.db.prepare('INSERT INTO zk_current VALUES(1,?)').run(encodeZk(state));
    const checkpoint: AcceptedCheckpoint = { stateVersion: 0n, root: state.root, inboxCursor: 0n, nextTradeId: 1n,
      tradeBatchId: 0n, journalSeq: 0, state: cloneZk(state) };
    this.db.prepare('INSERT INTO zk_checkpoint VALUES(1,?)').run(encodeZk(checkpoint));
  }
  current(): ZkState {
    const row = this.db.prepare('SELECT state FROM zk_current WHERE id=1').get() as { state: string };
    if (!row) throw new Error('ZK journal has no current state');
    return decodeZk<ZkState>(row.state);
  }
  checkpoint(): AcceptedCheckpoint {
    const row = this.db.prepare('SELECT record FROM zk_checkpoint WHERE id=1').get() as { record: string };
    if (!row) throw new Error('ZK journal has no accepted checkpoint');
    return decodeZk<AcceptedCheckpoint>(row.record);
  }
  setKey(slot: number, key: bigint): void {
    if (this.getKey(slot) !== undefined) throw new Error('Account recovery key is immutable');
    this.db.prepare('INSERT INTO zk_keys VALUES(?,?)').run(slot, key.toString());
  }
  getKey(slot: number): bigint | undefined {
    const row = this.db.prepare('SELECT recovery_key FROM zk_keys WHERE slot=?').get(slot) as { recovery_key: string } | undefined;
    return row ? BigInt(row.recovery_key) : undefined;
  }
  append(record: Omit<ZkOperationRecord, 'seq'>): ZkOperationRecord {
    const result = this.db.prepare('INSERT INTO zk_operations(record) VALUES(?)').run(encodeZk(record));
    const stored = { ...record, seq: Number(result.lastInsertRowid) };
    this.db.prepare('UPDATE zk_operations SET record=? WHERE seq=?').run(encodeZk(stored), stored.seq);
    this.db.prepare('UPDATE zk_current SET state=? WHERE id=1').run(encodeZk(record.afterState));
    return stored;
  }
  operations(unassigned = false): ZkOperationRecord[] {
    const query = `SELECT record FROM zk_operations${unassigned ? ' WHERE transition_version IS NULL' : ''} ORDER BY seq`;
    return (this.db.prepare(query).all() as { record: string }[]).map((row) => decodeZk<ZkOperationRecord>(row.record));
  }
  transitions(): ZkTransition[] {
    return (this.db.prepare('SELECT record FROM zk_transitions ORDER BY version').all() as { record: string }[]).map((row) => decodeZk<ZkTransition>(row.record));
  }
  transition(version: bigint): ZkTransition | undefined {
    const row = this.db.prepare('SELECT record FROM zk_transitions WHERE version=?').get(version.toString()) as { record: string } | undefined;
    return row ? decodeZk<ZkTransition>(row.record) : undefined;
  }
  transitionForOperation(seq: number): ZkTransition | undefined {
    const row = this.db.prepare('SELECT transition_version FROM zk_operations WHERE seq=?').get(seq) as { transition_version: string | null } | undefined;
    if (!row) throw new Error('Unknown economic operation');
    if (row.transition_version === null) return undefined;
    const transition = this.transition(BigInt(row.transition_version));
    if (!transition || !transition.operations.some((operation) => operation.seq === seq)) throw new Error('Withdrawal operation has an invalid sealed transition');
    return transition;
  }
  seal(transition: ZkTransition): void {
    this.db.prepare('INSERT INTO zk_transitions VALUES(?,?)').run(transition.stateVersion.toString(), encodeZk(transition));
    for (const op of transition.operations) {
      const result = this.db.prepare('UPDATE zk_operations SET transition_version=? WHERE seq=? AND transition_version IS NULL').run(transition.stateVersion.toString(), op.seq);
      if (Number(result.changes) !== 1) throw new Error('Transition overlaps an already sealed operation');
    }
  }
  /** Drop every unpublished operation and transition. Runs only inside the engine's queue rebuild transaction. */
  rewind(checkpoint: AcceptedCheckpoint, removed: readonly ZkOperationRecord[]): void {
    for (const op of removed) if (op.kind === 1) this.db.prepare('DELETE FROM zk_keys WHERE slot=?').run(op.slot);
    this.db.prepare('DELETE FROM zk_operations WHERE seq>?').run(checkpoint.journalSeq);
    this.db.prepare('DELETE FROM zk_transitions WHERE version>?').run(Number(checkpoint.stateVersion));
    this.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='zk_operations'").run(checkpoint.journalSeq);
    this.db.prepare('UPDATE zk_current SET state=? WHERE id=1').run(encodeZk(checkpoint.state));
    const proofCache = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='zk_proof_cache'").get();
    if (proofCache) this.db.prepare('DELETE FROM zk_proof_cache WHERE CAST(state_version AS INTEGER)>?').run(Number(checkpoint.stateVersion));
  }
  accept(version: bigint, txHash: string, blockNumber: number): ZkTransition {
    const transition = this.transition(version);
    if (!transition) throw new Error('Unknown ZK transition');
    if (transition.status === 'accepted') {
      if (transition.txHash !== txHash || transition.blockNumber !== blockNumber) throw new Error('Conflicting accepted transition');
      return transition;
    }
    const before = this.checkpoint();
    if (version !== before.stateVersion + 1n || transition.previousRoot !== before.root) throw new Error('Accepted transitions must extend the confirmed checkpoint');
    transition.status = 'accepted'; transition.txHash = txHash; transition.blockNumber = blockNumber;
    const checkpoint: AcceptedCheckpoint = { stateVersion: version, root: transition.newRoot, inboxCursor: transition.newInboxCursor,
      nextTradeId: transition.newTradeId, tradeBatchId: transition.tradeBatchId ?? before.tradeBatchId,
      journalSeq: transition.lastSeq, state: cloneZk(transition.endingState), txHash, blockNumber };
    this.db.prepare('UPDATE zk_transitions SET record=? WHERE version=?').run(encodeZk(transition), version.toString());
    this.db.prepare('UPDATE zk_checkpoint SET record=? WHERE id=1').run(encodeZk(checkpoint));
    return transition;
  }
}
