import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { getAddress, verifyTypedData } from 'ethers';
import { RubaEngine, sqrt } from '../engine.ts';
import type { State } from '../engine.ts';
import type { EngineConfig, ReceiptBatch, Token, TradeReceipt, WithdrawalRecord } from '../types.ts';
import { ZK_OPERATION_TYPES, zkOperationDomain } from '../auth.ts';
import { buildWitness } from '../../zk/schema.ts';
import { buildAccountTree, buildReceiptTreeV2, domainHash, encryptAccount, encryptPool, field, fieldHex,
  hashAccount, hashAuthDigest, hashDaDigest, hashOperation, hashPool, hashReceiptV2, hashState, keyCommit, randomField } from '../../zk/crypto.js';
import { PROVEN_WITHDRAWAL_MODE, ZkJournal, cloneZk, encodeZk } from './journal.ts';
import type { AcceptedCheckpoint, AccountDA, AccountFields, OperationMetadata, OperationParams, PoolFields,
  PreparedProvenWithdrawal, ProvenWithdrawalData, ZkOperationRecord, ZkState, ZkTransition } from './journal.ts';

const USER_KINDS = new Set([1, 3, 4, 5, 6]);
const MAX96 = (1n << 96n) - 1n;
const MAX64 = (1n << 64n) - 1n;
const ZERO_ACCOUNT = (): AccountFields => [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
const ZERO_POOL = (): PoolFields => [0n, 0n, 0n, 0n, 0n, 0n];
const zeroMetadata = (): OperationMetadata => ({ kind: 0n, slot: 0n, owner: 0n, commitment: 0n, eventId: 0n, token: 0n, amount: 0n, reference: 0n, signature: '0x' });
const zeroDA = (): AccountDA => ({ kind: 0n, slot: 0n, owner: 0n, newLeaf: 0n, ciphertext: Array<bigint>(7).fill(0n) });
const same = isDeepStrictEqual;

export interface ZkAuthorization { account: string; commitment: bigint | string; nonce: bigint | string; salt: bigint | string; signature: string }
export interface CanonicalInboxRecord {
  eventId: bigint; kind: 2 | 7; owner: string; token: Token; amount: bigint; reference: bigint;
  legacyEventId: string; transactionHash?: string; blockNumber?: number;
}
export interface PreparedAuthorization {
  kind: number; slot: number; owner: bigint; nonce: bigint; spendNonce: bigint;
  params: OperationParams; salt: bigint; commitment: bigint;
}

/** Refuse legacy journals before the base constructor can create or modify anything. */
function checkDatabase(config: EngineConfig): EngineConfig {
  if (config.dbPath === ':memory:' || !existsSync(config.dbPath)) return config;
  const db = new DatabaseSync(config.dbPath);
  try {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_state'").get();
    const zk = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='zk_meta'").get();
    if (existing && !zk) throw new Error('Legacy database has no authenticated ZK transition history; use a fresh ZK database and genesis');
    if (existing && zk) {
      const mode = db.prepare("SELECT value FROM zk_meta WHERE key='withdrawalMode'").get() as { value: string } | undefined;
      if (mode?.value !== PROVEN_WITHDRAWAL_MODE) throw new Error('Existing ZK database uses the old withdrawal mode; use a fresh proven-reservation-v1 database and Vault, without automatic migration');
    }
  } finally { db.close(); }
  return config;
}

/** Economic operations reuse the V2 ledger and atomically append real circuit witness data. */
export class ZkRubaEngine extends RubaEngine {
  readonly journal: ZkJournal;
  readonly poolRecoveryKey: bigint;
  readonly poolKeyCommit: bigint;
  readonly domain: bigint;
  private authorization: (ZkAuthorization & { used: boolean }) | undefined;
  private bridge: CanonicalInboxRecord | undefined;
  private savepointSequence = 0;

  constructor(config: EngineConfig, poolRecoveryKey?: bigint) {
    super(checkDatabase(config));
    this.journal = new ZkJournal(this.db);
    try {
      const stored = this.journal.getMeta('poolRecoveryKey');
      this.poolRecoveryKey = field(poolRecoveryKey ?? (stored === undefined ? 0n : BigInt(stored)));
      if (this.poolRecoveryKey === 0n) throw new Error('A nonzero pool recovery key is required for ZK genesis');
      if (stored !== undefined && BigInt(stored) !== this.poolRecoveryKey) throw new Error('Pool recovery key differs from the persisted ZK domain');
      this.poolKeyCommit = keyCommit(this.poolRecoveryKey);
      this.domain = domainHash(config.chainId, BigInt(config.vaultAddress), BigInt(config.rubaAddress), BigInt(config.usdtAddress), this.poolKeyCommit);
      if (!this.journal.getMeta('schema')) {
        const state = this.read();
        if (state.receipts.length || state.batches.length || state.nextTradeId !== 1n || Object.keys(state.balances).length || Object.keys(state.deposits).length) {
          throw new Error('Existing ledger cannot be converted into a trusted ZK genesis');
        }
        const genesis = this.makeState(Array.from({ length: 16 }, ZERO_ACCOUNT), ZERO_POOL(), 0n, 1n);
        this.db.exec('BEGIN IMMEDIATE');
        try { this.journal.initialize(genesis, this.poolRecoveryKey); this.db.exec('COMMIT'); }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      if (this.journal.getMeta('schema') !== '2') throw new Error('Unsupported ZK journal schema');
      if (this.journal.getMeta('withdrawalMode') !== PROVEN_WITHDRAWAL_MODE) throw new Error('Unsupported ZK withdrawal mode; a fresh proven-reservation-v1 database is required');
      this.validateJournal();
      this.assertLedgerMatches(this.journal.current());
    } catch (error) { this.db.close(); throw error; }
  }

  getDomain(): bigint { return this.domain; }
  getPoolKeyCommit(): bigint { return this.poolKeyCommit; }
  getGenesisStateRoot(): bigint { return this.makeState(Array.from({ length: 16 }, ZERO_ACCOUNT), ZERO_POOL(), 0n, 1n).root; }
  getCurrentInboxCursor(): bigint { return this.journal.current().inboxCursor; }
  getAcceptedCheckpoint(): AcceptedCheckpoint { return this.journal.checkpoint(); }
  getWithdrawalMode(): typeof PROVEN_WITHDRAWAL_MODE { return PROVEN_WITHDRAWAL_MODE; }

  /** Nested ledger rollback must include the SQL witness/outbox writes as well as the JS state. */
  protected override mutate<T>(callback: (state: State) => T): T {
    if (!this.activeState) return super.mutate(callback);
    const name = `zk_nested_${++this.savepointSequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = super.mutate(callback);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }

  private makeState(accounts: AccountFields[], pool: PoolFields, inboxCursor: bigint, nextTradeId: bigint): ZkState {
    const accountsRoot = buildAccountTree(accounts).root;
    const poolHash = hashPool(pool);
    return { accounts, pool, inboxCursor, nextTradeId, accountsRoot, poolHash,
      root: hashState(this.domain, accountsRoot, poolHash, inboxCursor, nextTradeId, this.poolKeyCommit) };
  }
  private slotFor(account: string, state = this.journal.current()): number {
    const owner = BigInt(getAddress(account));
    return state.accounts.findIndex((leaf) => leaf[0] === owner);
  }
  private freeSlot(state = this.journal.current()): number {
    const slot = state.accounts.findIndex((leaf) => leaf[0] === 0n);
    if (slot === -1) throw new Error('The local ZK MVP supports at most 16 registered accounts');
    return slot;
  }
  getZkAccount(account: string) {
    const current = this.journal.current();
    const found = this.slotFor(account, current);
    const slot = found === -1 ? this.freeSlot(current) : found;
    const tree = buildAccountTree(current.accounts);
    const accepted = this.journal.checkpoint();
    const leaf = current.accounts[slot];
    return { account: cloneZk(leaf), slot, registered: found !== -1, nonce: leaf[4], spendNonce: leaf[4],
      withdrawalNonce: leaf[4], withdrawalMode: PROVEN_WITHDRAWAL_MODE,
      path: tree.proofs[slot], leaf: tree.leaves[slot], domain: this.domain, accountsRoot: tree.root,
      poolHash: current.poolHash, inboxCursor: current.inboxCursor, nextTradeId: current.nextTradeId,
      poolKeyCommit: this.poolKeyCommit, stateRoot: current.root,
      provenWithdrawals: this.getProvenWithdrawals(account),
      stateVersion: this.journal.transitions().at(-1)?.stateVersion ?? 0n,
      status: current.root === accepted.root ? 'accepted' as const : 'pending' as const,
      accepted: { stateVersion: accepted.stateVersion, stateRoot: accepted.root, root: accepted.root,
        inboxCursor: accepted.inboxCursor, nextTradeId: accepted.nextTradeId, blockNumber: accepted.blockNumber, txHash: accepted.txHash } };
  }

  prepareAuthorization(account: string, operation: object, salt: bigint | string): PreparedAuthorization {
    const op = operation as Record<string, unknown>;
    const owner = BigInt(getAddress(account));
    const current = this.journal.current();
    const nextSalt = field(salt);
    let slot = this.slotFor(account, current);
    let kind: number;
    let params: OperationParams;
    const value = (key: string) => BigInt(op[key] as string | bigint);
    const token = (key: string) => {
      if (op[key] !== 'RUBA' && op[key] !== 'USDT') throw new Error('Unknown token');
      return op[key] === 'RUBA' ? 0n : 1n;
    };
    if (op.kind === 'zkRegister') {
      if (slot !== -1) throw new Error('Account is already registered');
      slot = Number(value('slot'));
      if (!Number.isSafeInteger(slot) || slot < 0 || slot >= 16 || slot !== this.freeSlot(current)) throw new Error('Registration slot is no longer available');
      kind = 1; params = [keyCommit(field(value('recoveryKey'))), 0n, 0n, 0n];
    } else {
      if (slot === -1) throw new Error('Register the ZK account before using the ledger');
      switch (op.kind) {
        case 'swap': kind = 3; params = [token('tokenIn'), value('amountIn'), value('minOut'), 0n]; break;
        case 'addLiquidity': kind = 4; params = [value('rubaDesired'), value('usdtDesired'), value('rubaMin'), value('usdtMin')]; break;
        case 'removeLiquidity': kind = 5; params = [value('shares'), value('rubaMin'), value('usdtMin'), 0n]; break;
        case 'withdraw': kind = 6; params = [token('token'), value('amount'), current.accounts[slot][4], 0n]; break;
        default: throw new Error('This operation does not require a private economic authorization');
      }
    }
    const nonce = current.accounts[slot][4];
    if (nextSalt === 0n || nextSalt === current.accounts[slot][8]) throw new Error('A fresh nonzero account salt is required');
    const commitment = hashOperation(this.domain, kind, slot, owner, nonce, params, nextSalt);
    return { kind, slot, owner, nonce, spendNonce: nonce, params, salt: nextSalt, commitment };
  }

  withZkAuthorization<T>(authorization: ZkAuthorization, callback: () => T): T {
    if (this.authorization) throw new Error('Nested ZK authorizations are not allowed');
    return this.mutate(() => {
      const before = this.journal.operations().length;
      this.authorization = { ...authorization, account: getAddress(authorization.account), used: false };
      try {
        const result = callback();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('ZK ledger transactions must be synchronous');
        if (!this.authorization.used || this.journal.operations().length !== before + 1) throw new Error('A private authorization must execute exactly one economic operation');
        return result;
      } finally { this.authorization = undefined; }
    });
  }
  private operationDomain() { return zkOperationDomain(this.config.chainId, this.config.vaultAddress); }
  private checkAuthorization(kind: number, slot: number, owner: bigint, oldNonce: bigint, params: OperationParams, salt: bigint): string {
    const auth = this.authorization;
    const commitment = hashOperation(this.domain, kind, slot, owner, oldNonce, params, salt);
    if (!auth || auth.used || BigInt(auth.account) !== owner || field(auth.commitment) !== commitment || BigInt(auth.nonce) !== oldNonce) throw new Error('Missing, replayed or mismatched private-operation authorization');
    if (verifyTypedData(this.operationDomain(), ZK_OPERATION_TYPES, { commitment }, auth.signature) !== getAddress(auth.account)) throw new Error('Invalid private-operation owner signature');
    auth.used = true;
    return auth.signature;
  }

  registerZkAccount(account: string, recoveryKey: bigint | string, slot: number | bigint | string) {
    const key = field(recoveryKey);
    if (key === 0n) throw new Error('Recovery key must be nonzero');
    const owner = getAddress(account);
    const requestedSlot = Number(slot);
    const current = this.journal.current();
    if (this.slotFor(owner, current) !== -1 || requestedSlot !== this.freeSlot(current)) throw new Error('Registration owner or slot is already occupied');
    this.economic(1, owner, [keyCommit(key), 0n, 0n, 0n], () => undefined, { slot: requestedSlot, recoveryKey: key });
    return this.getZkAccount(owner);
  }

  override recordDeposit(depositId: bigint, account: string, token: Token, amount: bigint): boolean {
    if (!this.bridge || this.bridge.kind !== 2 || this.bridge.reference !== depositId) throw new Error('ZK deposits require a canonical Vault inbox record');
    return this.economic(2, account, [token === 'RUBA' ? 0n : 1n, amount, this.bridge.eventId, depositId],
      () => super.recordDeposit(depositId, account, token, amount));
  }
  override swap(account: string, tokenIn: Token, amountIn: bigint, minOut: bigint): TradeReceipt {
    return this.economic(3, account, [tokenIn === 'RUBA' ? 0n : 1n, amountIn, minOut, 0n], () => super.swap(account, tokenIn, amountIn, minOut));
  }
  override addLiquidity(account: string, rubaDesired: bigint, usdtDesired: bigint, rubaMin = 0n, usdtMin = 0n) {
    return this.economic(4, account, [rubaDesired, usdtDesired, rubaMin, usdtMin], () => super.addLiquidity(account, rubaDesired, usdtDesired, rubaMin, usdtMin));
  }
  override removeLiquidity(account: string, shares: bigint, rubaMin = 0n, usdtMin = 0n) {
    return this.economic(5, account, [shares, rubaMin, usdtMin, 0n], () => super.removeLiquidity(account, shares, rubaMin, usdtMin));
  }
  override reserveWithdrawal(account: string, token: Token, amount: bigint, deadline: bigint, signerEpoch: bigint): WithdrawalRecord {
    if (deadline !== MAX64 || signerEpoch !== 0n) throw new Error('Proven withdrawal claims are perpetual and require deadline=uint64.max and signerEpoch=0');
    const owner = getAddress(account);
    const state = this.journal.current();
    const slot = this.slotFor(owner, state);
    if (slot === -1) throw new Error('Register the ZK account before using the ledger');
    const nonce = state.accounts[slot][4];
    return this.economic(6, owner, [token === 'RUBA' ? 0n : 1n, amount, nonce, 0n], () => {
      if (this.getWithdrawal(owner, nonce)) throw new Error('The proven withdrawal spend nonce is already reserved');
      this.read().withdrawalNonces[owner] = nonce;
      return super.reserveWithdrawal(owner, token, amount, deadline, signerEpoch);
    });
  }
  override settleWithdrawal(account: string, nonce: bigint, token: Token, amount: bigint, eventId: string): boolean {
    if (!this.bridge || this.bridge.kind !== 7 || this.bridge.reference !== nonce) throw new Error('ZK settlements require a canonical Vault inbox record');
    return this.economic(7, account, [token === 'RUBA' ? 0n : 1n, amount, this.bridge.eventId, nonce], () => super.settleWithdrawal(account, nonce, token, amount, eventId));
  }
  override expireWithdrawal(_account: string, _nonce: bigint, _evidence: { finalizedTimestamp: bigint; nonceUsed: boolean }): never {
    throw new Error('Withdrawal expiry and REFUND are disabled: proven withdrawal claims remain redeemable indefinitely');
  }

  canApplyInboxRecord(record?: CanonicalInboxRecord): boolean {
    if (record && this.slotFor(record.owner) === -1) return false;
    const unassigned = this.journal.operations(true);
    const firstSwap = unassigned.findIndex((op) => op.kind === 3);
    return firstSwap === -1 || unassigned.slice(firstSwap).filter((op) => op.kind !== 3).length < 4;
  }
  applyInboxRecord(record: CanonicalInboxRecord): boolean {
    return this.mutate(() => {
      const current = this.journal.current();
      if (record.eventId <= current.inboxCursor) {
        const previous = this.journal.operations().find((op) => op.metadata.eventId === record.eventId);
        if (!previous || previous.kind !== record.kind || previous.owner !== BigInt(getAddress(record.owner))
          || previous.metadata.token !== (record.token === 'RUBA' ? 0n : 1n) || previous.metadata.amount !== record.amount || previous.metadata.reference !== record.reference) throw new Error('Conflicting canonical inbox replay');
        return false;
      }
      if (record.eventId !== current.inboxCursor + 1n) throw new Error('Canonical inbox records must be applied in exact sequential order');
      if (!this.canApplyInboxRecord(record)) throw new Error('ZK operation capacity reached; publish the pending transition or finish its four swaps');
      if (this.bridge) throw new Error('Nested bridge application is not allowed');
      this.bridge = record;
      try {
        return record.kind === 2
          ? this.recordDeposit(record.reference, record.owner, record.token, record.amount)
          : this.settleWithdrawal(record.owner, record.reference, record.token, record.amount, record.legacyEventId);
      } finally { this.bridge = undefined; }
    });
  }

  private economic<T>(kind: number, account: string, params: OperationParams, callback: () => T, registration?: { slot: number; recoveryKey: bigint }): T {
    if (kind === 8) throw new Error('REFUND is disabled in proven-reservation-v1');
    return this.mutate((ledger) => {
      const before = this.journal.current();
      this.assertLedgerMatches(before);
      const slot = registration?.slot ?? this.slotFor(account, before);
      if (slot < 0) throw new Error('Register the ZK account before using the ledger');
      const owner = BigInt(getAddress(account));
      const oldAccount = before.accounts[slot];
      const tail = this.journal.operations(true);
      const firstSwap = tail.findIndex((op) => op.kind === 3);
      const closesPacket = kind === 5 || kind === 6;
      // An exit immediately seals this tail, so it may use the slot otherwise
      // reserved for a fourth swap. It must still fit the physical circuit bound.
      if (closesPacket && firstSwap !== -1 && tail.length - firstSwap >= 8) this.sealReady(ledger, true, true);
      else if (!closesPacket && kind !== 3 && firstSwap !== -1 && tail.slice(firstSwap).filter((op) => op.kind !== 3).length >= 4) throw new Error('ZK auxiliary operation capacity reached; close the pending packet first');
      const salt = USER_KINDS.has(kind) ? field(this.authorization?.salt ?? 0n) : randomField();
      if (salt === 0n || salt === oldAccount[8]) throw new Error('A fresh nonzero account salt is required');
      for (const [index, value] of params.entries()) {
        if (kind === 1 && index === 0) field(value);
        else if (value < 0n || value > MAX96) throw new Error('Operation parameter exceeds the 96-bit local ZK bound');
      }
      const signature = USER_KINDS.has(kind) ? this.checkAuthorization(kind, slot, owner, oldAccount[4], params, salt) : '0x';
      const commitment = hashOperation(this.domain, kind, slot, owner, oldAccount[4], params, salt);
      const result = callback();
      const accounts = cloneZk(before.accounts);
      const key = registration?.recoveryKey ?? this.journal.getKey(slot);
      if (key === undefined) throw new Error('Account recovery key is missing; restore the authenticated checkpoint');
      if (registration) this.journal.setKey(slot, key);
      const balances = ledger.balances[getAddress(account)] ?? { RUBA: 0n, USDT: 0n };
      const pending = { RUBA: 0n, USDT: 0n };
      for (const withdrawal of Object.values(ledger.withdrawals)) if (withdrawal.account === getAddress(account) && withdrawal.status === 'pending') pending[withdrawal.token] += withdrawal.amount;
      const newAccount: AccountFields = [owner, balances.RUBA, balances.USDT, ledger.shares[getAddress(account)] ?? 0n,
        oldAccount[4] + (USER_KINDS.has(kind) ? 1n : 0n), pending.RUBA, pending.USDT,
        registration ? keyCommit(key) : oldAccount[7], salt];
      accounts[slot] = newAccount;
      const after = this.makeState(accounts, [ledger.reserves.RUBA, ledger.reserves.USDT, ledger.totalSupply,
        ledger.lockedLiquidity, ledger.custody.RUBA, ledger.custody.USDT], before.inboxCursor + (kind === 2 || kind === 7 ? 1n : 0n), ledger.nextTradeId);
      this.assertBoundsAndConservation(after);
      const path = buildAccountTree(before.accounts).proofs[slot];
      const newLeaf = hashAccount(slot, newAccount);
      const metadata: OperationMetadata = { kind: BigInt(kind), slot: BigInt(slot), owner, commitment,
        eventId: this.bridge?.eventId ?? 0n, token: this.bridge ? params[0] : 0n,
        amount: this.bridge ? params[1] : 0n, reference: this.bridge?.reference ?? 0n, signature };
      const da: AccountDA = { kind: BigInt(kind), slot: BigInt(slot), owner, newLeaf, ciphertext: encryptAccount(key, newLeaf, newAccount) };
      let receipt: TradeReceipt | undefined;
      if (kind === 3) {
        receipt = ledger.receipts.at(-1)!;
        receipt.salt = fieldHex(salt);
        receipt.leaf = fieldHex(hashReceiptV2(receipt));
        Object.assign(receipt, { version: 2, schemaVersion: 2 });
      }
      const record: Omit<ZkOperationRecord, 'seq'> = { kind, slot, owner, params, oldAccount: cloneZk(oldAccount), newAccount,
        path, oldPool: before.pool, newPool: after.pool, recoveryKey: key, metadata, da,
        receiptSalt: kind === 3 ? salt : 0n, receipt: receipt ? cloneZk(receipt) : undefined, beforeState: before, afterState: after,
        ledgerAfter: cloneZk(ledger) };
      if (kind === 6) record.provenWithdrawal = { withdrawal: { account: getAddress(account), token: this.tokenAddress(params[0] === 0n ? 'RUBA' : 'USDT'),
        amount: params[1], nonce: params[2], spendNonce: oldAccount[4], salt }, commitment };
      this.validateOperation(record);
      this.journal.append(record);
      if (closesPacket && this.journal.operations(true).some((op) => op.kind === 3)) this.sealReady(ledger, true, true);
      else if (kind === 3 && this.journal.operations(true).filter((op) => op.kind === 3).length === 4) this.sealReady(ledger, true);
      return result;
    });
  }

  /** V2 receipt batching is performed after the atomic ZK operation record is available. */
  protected override enqueueBatch(_state: State, _receipts: TradeReceipt[]): void {}

  private sealReady(ledger: State, all: boolean, allowPartial = false): void {
    do {
      const pending = this.journal.operations(true);
      if (!pending.length) return;
      const firstSwap = pending.findIndex((op) => op.kind === 3);
      let operations: ZkOperationRecord[];
      let mode: 0 | 1;
      if (firstSwap === -1 || firstSwap > 0) {
        operations = pending.slice(0, Math.min(8, firstSwap === -1 ? pending.length : firstSwap)); mode = 0;
      } else {
        const swapCount = pending.filter((op) => op.kind === 3).length;
        if (swapCount < 1 || swapCount > 4) throw new Error('ZK trade packets require one to four swaps');
        if (!allowPartial && swapCount < 4) return;
        operations = pending; mode = 1;
      }
      if (operations.length > 8) throw new Error('ZK transition exceeds its eight-operation circuit bound');
      const previous = this.journal.transitions().at(-1);
      const stateVersion = (previous?.stateVersion ?? 0n) + 1n;
      const startingState = operations[0].beforeState;
      const endingState = operations.at(-1)!.afterState;
      if (startingState.root !== (previous?.newRoot ?? this.getGenesisStateRoot())) throw new Error('ZK transition does not extend the previous immutable boundary');
      const metadata = operations.map((op) => op.metadata);
      const accountDA = operations.map((op) => op.da);
      while (metadata.length < 8) metadata.push(zeroMetadata());
      while (accountDA.length < 8) accountDA.push(zeroDA());
      const swaps = operations.filter((op) => op.kind === 3);
      const tree = mode === 1 ? buildReceiptTreeV2(swaps.map((op) => op.receipt!.leaf)) : undefined;
      const receiptsRoot = tree?.root ?? 0n;
      const authDigest = hashAuthDigest(this.domain, stateVersion, metadata);
      const poolDA = { poolHash: endingState.poolHash, poolCiphertext: encryptPool(this.poolRecoveryKey, endingState.poolHash, endingState.pool) };
      const daDigest = hashDaDigest(this.domain, stateVersion, accountDA, poolDA.poolHash, poolDA.poolCiphertext);
      const publicSignals = [this.domain, stateVersion, BigInt(mode), startingState.root, endingState.root,
        startingState.inboxCursor, endingState.inboxCursor, startingState.nextTradeId, endingState.nextTradeId,
        receiptsRoot, authDigest, daDigest, this.poolKeyCommit];
      const tradeBatchId = mode === 1 ? BigInt(ledger.batches.length + 1) : undefined;
      const witness = buildWitness({ chainId: this.config.chainId, vault: BigInt(this.config.vaultAddress),
        ruba: BigInt(this.config.rubaAddress), usdt: BigInt(this.config.usdtAddress), domain: this.domain,
        poolKeyCommit: this.poolKeyCommit, poolRecoveryKey: this.poolRecoveryKey, stateVersion, mode,
        startingState, endingState, operations: operations.map((op) => ({ ...op, path: op.path as [bigint, bigint, bigint, bigint] })), publicSignals, poolDa: poolDA });
      const transition: ZkTransition = { stateVersion, mode, previousRoot: startingState.root, newRoot: endingState.root,
        previousInboxCursor: startingState.inboxCursor, newInboxCursor: endingState.inboxCursor,
        previousTradeId: startingState.nextTradeId, newTradeId: endingState.nextTradeId, receiptsRoot, authDigest, daDigest,
        publicSignals, metadata, accountDA, poolDA, witness: witness as unknown as Record<string, unknown>, operations,
        startingState, endingState, firstSeq: operations[0].seq, lastSeq: operations.at(-1)!.seq, tradeBatchId, status: 'pending' };
      this.journal.seal(transition);
      if (tradeBatchId !== undefined) {
        const batch: ReceiptBatch = { batchId: tradeBatchId, previousStateRoot: fieldHex(startingState.root), newStateRoot: fieldHex(endingState.root),
          receiptsRoot: fieldHex(receiptsRoot), firstTradeId: startingState.nextTradeId, tradeCount: BigInt(swaps.length),
          stateSalt: fieldHex(0n), stateSnapshot: encodeZk(endingState), tradeIds: swaps.map((op) => op.receipt!.tradeId) };
        Object.assign(batch, { version: 2, stateVersion });
        swaps.forEach((op, index) => {
          const stored = ledger.receipts.find((item) => item.tradeId === op.receipt!.tradeId)!;
          stored.batchId = tradeBatchId; stored.proof = tree!.proofs[index].map(fieldHex);
        });
        ledger.batches.push(batch);
      }
      if (!all) return;
    } while (true);
  }
  /** Explicitly close the current draft without requiring a fourth swap.
   * HTTP administrator authorization belongs to the serialized API caller.
   * Empty/repeated requests never create another economic transition.
   */
  closePendingBatch(): ZkTransition | undefined {
    return this.mutate((ledger) => {
      this.sealReady(ledger, true, true);
      return this.journal.transitions().find((transition) => transition.status === 'pending');
    });
  }
  getPendingTransition(): ZkTransition | undefined {
    return this.mutate((ledger) => {
      const existing = this.journal.transitions().find((transition) => transition.status === 'pending');
      if (existing) return existing;
      this.sealReady(ledger, false);
      return this.journal.transitions().find((transition) => transition.status === 'pending');
    });
  }
  listTransitions(): ZkTransition[] { return this.journal.transitions(); }
  getTransition(version: bigint): ZkTransition | undefined { return this.journal.transition(version); }
  getTransitionForBatch(batchId: bigint): ZkTransition | undefined { return this.journal.transitions().find((transition) => transition.tradeBatchId === batchId); }
  markTransitionAccepted(version: bigint, txHash: string, blockNumber: number): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('Invalid confirmed transition transaction');
    this.mutate(() => {
      const transition = this.journal.accept(version, txHash, blockNumber);
      if (transition.tradeBatchId !== undefined) this.markBatchPublished(transition.tradeBatchId, txHash);
    });
  }

  getProvenWithdrawal(record: WithdrawalRecord): PreparedProvenWithdrawal;
  getProvenWithdrawal(account: string, nonce: bigint): PreparedProvenWithdrawal;
  getProvenWithdrawal(recordOrAccount: WithdrawalRecord | string, nonce?: bigint): PreparedProvenWithdrawal {
    const account = getAddress(typeof recordOrAccount === 'string' ? recordOrAccount : recordOrAccount.account);
    const requestNonce = typeof recordOrAccount === 'string' ? nonce : recordOrAccount.nonce;
    if (typeof requestNonce !== 'bigint' || requestNonce < 0n || requestNonce > MAX64) throw new Error('Invalid proven withdrawal nonce');
    const request = this.getWithdrawal(account, requestNonce);
    if (!request || (typeof recordOrAccount !== 'string' && !same(recordOrAccount, request))) throw new Error('Withdrawal request differs from the durable reservation');
    const matches = this.journal.operations().filter((op) => op.kind === 6 && op.owner === BigInt(account) && op.params[2] === requestNonce);
    if (matches.length !== 1) throw new Error('Withdrawal has no unique proven kind6 reservation');
    const operation = matches[0];
    this.validateOperation(operation);
    const opening = operation.provenWithdrawal!;
    if (opening.withdrawal.token !== request.tokenAddress || opening.withdrawal.amount !== request.amount
      || request.deadline !== MAX64 || request.signerEpoch !== 0n) throw new Error('Proven withdrawal opening differs from the actual withdrawal request');
    const transition = this.journal.transitionForOperation(operation.seq);
    if (transition && (!same(transition.operations.find((op) => op.seq === operation.seq), operation)
      || transition.publicSignals[1] !== transition.stateVersion)) throw new Error('Proven withdrawal differs from its frozen transition');
    return { ...cloneZk(opening), stateVersion: transition?.stateVersion ?? null };
  }

  getProvenWithdrawals(account: string): PreparedProvenWithdrawal[] {
    return this.accountSnapshot(account).withdrawals.filter((record) => record.status === 'pending').map((record) => this.getProvenWithdrawal(record));
  }

  getRecoveryBundle(account: string) {
    const state = this.getZkAccount(account);
    if (!state.registered) throw new Error('ZK account is not registered');
    const key = this.journal.getKey(state.slot)!;
    const checkpoint = this.journal.checkpoint();
    const acceptedTree = buildAccountTree(checkpoint.state.accounts);
    return { version: 2, withdrawalMode: PROVEN_WITHDRAWAL_MODE, chainId: this.config.chainId, vault: this.config.vaultAddress, ruba: this.config.rubaAddress,
      usdt: this.config.usdtAddress, domain: this.domain, poolKeyCommit: this.poolKeyCommit,
      slot: state.slot, owner: getAddress(account), recoveryKey: key, recoveryKeyCommit: keyCommit(key),
      current: state, accepted: { ...checkpoint, account: checkpoint.state.accounts[state.slot], path: acceptedTree.proofs[state.slot],
        accountsRoot: acceptedTree.root, poolHash: checkpoint.state.poolHash, state: undefined },
      pendingAuthorizations: this.journal.operations().filter((op) => op.owner === BigInt(account) && op.seq > checkpoint.journalSeq)
        .map((op) => ({ metadata: op.metadata, params: op.params, newSalt: op.newAccount[8] })),
      withdrawals: this.accountSnapshot(account).withdrawals, provenWithdrawals: this.getProvenWithdrawals(account) };
  }

  private assertBoundsAndConservation(state: ZkState): void {
    for (const value of state.pool) if (value < 0n || value > MAX96) throw new Error('Pool value exceeds the 96-bit local ZK bound');
    if (state.inboxCursor < 0n || state.inboxCursor > MAX64 || state.nextTradeId < 1n || state.nextTradeId > MAX64) throw new Error('ZK counter exceeds its 64-bit bound');
    let ruba = state.pool[0]; let usdt = state.pool[1]; let shares = state.pool[3];
    const owners = new Set<bigint>();
    for (const account of state.accounts) {
      for (const index of [1, 2, 3, 5, 6]) if (account[index] < 0n || account[index] > MAX96) throw new Error('Account value exceeds the 96-bit local ZK bound');
      if (account[4] < 0n || account[4] > MAX64) throw new Error('Spend nonce exceeds its 64-bit bound');
      field(account[7]); field(account[8]);
      if (account[0] === 0n) { if (account.some((value) => value !== 0n)) throw new Error('Unused account must be exactly empty'); }
      else { if (account[0] < 0n || account[0] >= 1n << 160n || owners.has(account[0])) throw new Error('Account owners must be unique immutable addresses'); owners.add(account[0]); }
      ruba += account[1] + account[5]; usdt += account[2] + account[6]; shares += account[3];
    }
    if (ruba !== state.pool[4] || usdt !== state.pool[5] || shares !== state.pool[2]) throw new Error('ZK balances, pending claims and LP shares do not conserve custody');
  }
  private assertLedgerMatches(state: ZkState, ledger = this.read()): void {
    const pool: PoolFields = [ledger.reserves.RUBA, ledger.reserves.USDT, ledger.totalSupply, ledger.lockedLiquidity, ledger.custody.RUBA, ledger.custody.USDT];
    if (!same(pool, state.pool) || ledger.nextTradeId !== state.nextTradeId) throw new Error('Ledger differs from authenticated ZK journal; restore/reconcile the database');
    for (const [owner, balances] of Object.entries(ledger.balances)) {
      const slot = this.slotFor(owner, state);
      if (slot === -1 && (balances.RUBA || balances.USDT)) throw new Error('Unregistered ledger balance is outside the ZK state');
    }
    for (const account of state.accounts) if (account[0] !== 0n) {
      const owner = getAddress('0x' + account[0].toString(16).padStart(40, '0'));
      const balances = ledger.balances[owner] ?? { RUBA: 0n, USDT: 0n };
      const pending = { RUBA: 0n, USDT: 0n };
      for (const withdrawal of Object.values(ledger.withdrawals)) if (withdrawal.account === owner && withdrawal.status === 'pending') pending[withdrawal.token] += withdrawal.amount;
      if (!same([balances.RUBA, balances.USDT, ledger.shares[owner] ?? 0n, pending.RUBA, pending.USDT], [account[1], account[2], account[3], account[5], account[6]])) throw new Error('User ledger differs from the authenticated account tree');
    }
  }

  private validateOperation(op: Omit<ZkOperationRecord, 'seq'>): void {
    if (op.kind === 8) throw new Error('REFUND history is forbidden in proven-reservation-v1; restore with a fresh compatible database');
    if (!same(op.beforeState, this.makeState(op.beforeState.accounts, op.beforeState.pool, op.beforeState.inboxCursor, op.beforeState.nextTradeId))) throw new Error('Stored starting state does not open its previous root');
    const expected = cloneZk(op.beforeState);
    if (!same(op.oldPool, op.beforeState.pool) || !same(op.newPool, op.afterState.pool)) throw new Error('Stored pool witness differs from its state snapshots');
    const account = expected.accounts[op.slot];
    if (!same(account, op.oldAccount) || account[0] !== (op.kind === 1 ? 0n : op.owner)) throw new Error('Operation owner or old membership differs');
    const [p0, p1, p2, p3] = op.params;
    const pool = expected.pool;
    const token = Number(p0);
    const nonce = account[4];
    if (op.newAccount[8] === 0n || op.newAccount[8] === account[8]) throw new Error('Stored account salt was reused');
    if (op.metadata.kind !== BigInt(op.kind) || op.metadata.slot !== BigInt(op.slot) || op.metadata.owner !== op.owner
      || op.da.kind !== BigInt(op.kind) || op.da.slot !== BigInt(op.slot) || op.da.owner !== op.owner) throw new Error('Stored operation metadata differs from its account');
    const positive = (value: bigint) => { if (value <= 0n) throw new Error('Economic amount must be positive'); };
    switch (op.kind) {
      case 1:
        if (account.some((value) => value !== 0n)) throw new Error('Registration overwrites an occupied leaf');
        account[0] = op.owner; account[7] = p0; break;
      case 2:
        if (token !== 0 && token !== 1) throw new Error('Invalid bridge token'); positive(p1);
        account[1 + token] += p1; pool[4 + token] += p1; expected.inboxCursor++; break;
      case 3: {
        if (token !== 0 && token !== 1) throw new Error('Invalid swap token'); positive(p1);
        const other = 1 - token;
        if (pool[token] <= 0n || pool[other] <= 0n) throw new Error('Insufficient pool liquidity');
        const out = p1 * 997n * pool[other] / (pool[token] * 1000n + p1 * 997n);
        if (out <= 0n || out < p2) throw new Error('Swap output or slippage is invalid');
        account[1 + token] -= p1; account[1 + other] += out; pool[token] += p1; pool[other] -= out; expected.nextTradeId++; break;
      }
      case 4: {
        positive(p0); positive(p1);
        let ruba = p0; let usdt = p1; let shares: bigint;
        if (pool[2] === 0n) { shares = sqrt(ruba * usdt) - 1000n; pool[3] = 1000n; pool[2] = 1000n; }
        else { const quote = p0 * pool[1] / pool[0]; if (quote <= p1) usdt = quote; else ruba = p1 * pool[0] / pool[1];
          const a = ruba * pool[2] / pool[0]; const b = usdt * pool[2] / pool[1]; shares = a < b ? a : b; }
        if (ruba <= 0n || usdt <= 0n || shares <= 0n || ruba < p2 || usdt < p3) throw new Error('Invalid liquidity mint');
        account[1] -= ruba; account[2] -= usdt; account[3] += shares; pool[0] += ruba; pool[1] += usdt; pool[2] += shares; break;
      }
      case 5: {
        positive(p0); if (pool[2] <= 0n) throw new Error('Invalid LP supply');
        const ruba = p0 * pool[0] / pool[2]; const usdt = p0 * pool[1] / pool[2];
        if (ruba <= 0n || usdt <= 0n || ruba < p1 || usdt < p2) throw new Error('Invalid liquidity redemption');
        account[3] -= p0; account[1] += ruba; account[2] += usdt; pool[0] -= ruba; pool[1] -= usdt; pool[2] -= p0; break;
      }
      case 6:
        if (token !== 0 && token !== 1) throw new Error('Invalid withdrawal token'); positive(p1);
        if (p2 !== nonce || p3 !== 0n) throw new Error('Proven withdrawal nonce must equal the old account spend nonce');
        account[1 + token] -= p1; account[5 + token] += p1; break;
      case 7:
        if (token !== 0 && token !== 1) throw new Error('Invalid settlement token'); positive(p1);
        account[5 + token] -= p1; pool[4 + token] -= p1; expected.inboxCursor++; break;
      default: throw new Error('Unknown economic operation kind');
    }
    if (USER_KINDS.has(op.kind)) account[4]++;
    account[8] = op.newAccount[8];
    const rebuilt = this.makeState(expected.accounts, expected.pool, expected.inboxCursor, expected.nextTradeId);
    this.assertBoundsAndConservation(rebuilt);
    if (!same(rebuilt, op.afterState) || !same(account, op.newAccount)) throw new Error('Economic transition differs from its deterministic witness');
    if (!op.ledgerAfter) throw new Error('Economic operation has no durable ledger snapshot');
    this.assertLedgerMatches(op.afterState, op.ledgerAfter);
    if (!same(buildAccountTree(op.beforeState.accounts).proofs[op.slot], op.path)) throw new Error('Invalid stored account membership path');
    if (keyCommit(op.recoveryKey) !== account[7] || hashAccount(op.slot, account) !== op.da.newLeaf
      || !same(encryptAccount(op.recoveryKey, op.da.newLeaf, account), op.da.ciphertext)) throw new Error('Recovery key or encrypted DA differs from the account state');
    const commitment = hashOperation(this.domain, op.kind, op.slot, op.owner, nonce, op.params, account[8]);
    if (commitment !== op.metadata.commitment) throw new Error('Operation commitment differs from the witness');
    if (op.kind === 6) {
      const expectedOpening: ProvenWithdrawalData = { withdrawal: {
        account: getAddress('0x' + op.owner.toString(16).padStart(40, '0')), token: this.tokenAddress(token === 0 ? 'RUBA' : 'USDT'),
        amount: p1, nonce: p2, spendNonce: nonce, salt: account[8],
      }, commitment };
      const request = op.ledgerAfter?.withdrawals[`${expectedOpening.withdrawal.account}:${p2}`];
      if (!same(op.provenWithdrawal, expectedOpening) || !request || request.account !== expectedOpening.withdrawal.account
        || request.token !== (token === 0 ? 'RUBA' : 'USDT') || request.tokenAddress !== expectedOpening.withdrawal.token || request.amount !== p1 || request.nonce !== p2
        || request.deadline !== MAX64 || request.signerEpoch !== 0n || request.status !== 'pending') throw new Error('Stored proven withdrawal opening differs from its actual kind6 reservation');
    } else if (op.provenWithdrawal !== undefined) throw new Error('Only kind6 operations may contain proven withdrawal openings');
    if (USER_KINDS.has(op.kind) && BigInt(verifyTypedData(this.operationDomain(), ZK_OPERATION_TYPES, { commitment }, op.metadata.signature)) !== op.owner) throw new Error('Invalid stored user authorization');
    if (op.kind !== 2 && op.kind !== 7 && [op.metadata.eventId, op.metadata.token, op.metadata.amount, op.metadata.reference].some((value) => value !== 0n)) throw new Error('Private operation exposes unbound bridge metadata');
    if ((op.kind === 2 || op.kind === 7) && (op.metadata.eventId !== op.beforeState.inboxCursor + 1n || p2 !== op.metadata.eventId
      || p0 !== op.metadata.token || p1 !== op.metadata.amount || p3 !== op.metadata.reference)) throw new Error('Stored operation differs from the canonical inbox');
    if (op.kind === 3) {
      const receipt = op.receipt;
      const tokenIn = this.tokenAddress(p0 === 0n ? 'RUBA' : 'USDT');
      const tokenOut = this.tokenAddress(p0 === 0n ? 'USDT' : 'RUBA');
      if (!receipt || receipt.chainId !== this.config.chainId || BigInt(receipt.vault) !== BigInt(this.config.vaultAddress)
        || BigInt(receipt.account) !== op.owner || receipt.tradeId !== op.beforeState.nextTradeId
        || receipt.tokenIn !== tokenIn || receipt.tokenOut !== tokenOut || receipt.amountIn !== p1
        || receipt.amountOut !== op.beforeState.pool[Number(1n - p0)] - op.afterState.pool[Number(1n - p0)]
        || receipt.feeNumerator !== p1 * 3n || receipt.feeDenominator !== 1000n
        || !same([receipt.reserveRubaBefore, receipt.reserveUsdtBefore, receipt.reserveRubaAfter, receipt.reserveUsdtAfter],
          [op.beforeState.pool[0], op.beforeState.pool[1], op.afterState.pool[0], op.afterState.pool[1]])
        || BigInt(receipt.salt) !== op.receiptSalt || fieldHex(hashReceiptV2(receipt)) !== receipt.leaf) throw new Error('Stored receipt differs from its actual swap');
    }
  }
  private validateJournal(): void {
    const genesis = this.getGenesisStateRoot();
    if (BigInt(this.journal.getMeta('genesis') ?? -1) !== genesis) throw new Error('Persisted ZK genesis differs from the pinned domain');
    let root = genesis; let seq = 0;
    const records = this.journal.operations();
    for (const op of records) {
      if (op.seq !== ++seq || op.beforeState.root !== root) throw new Error('ZK operation journal is missing or reordered');
      this.validateOperation(op); root = op.afterState.root;
    }
    const current = this.journal.current();
    if (current.root !== root || !same(current, this.makeState(current.accounts, current.pool, current.inboxCursor, current.nextTradeId))) throw new Error('Current ZK snapshot differs from its operation journal');
    const checkpoint = this.journal.checkpoint();
    for (const [slot, account] of current.accounts.entries()) if (account[0] !== 0n) {
      const key = this.journal.getKey(slot);
      if (key === undefined || keyCommit(key) !== account[7]) throw new Error('Stored recovery key does not open the immutable account commitment');
    }
    let version = 0n; let transitionRoot = genesis; let lastSeq = 0; let tradeBatchId = 0n;
    let lastAccepted = 0n; let acceptedTradeBatches = 0n;
    for (const transition of this.journal.transitions()) {
      if (transition.stateVersion !== ++version || transition.previousRoot !== transitionRoot) throw new Error('ZK transition chain has a gap or altered root');
      if (transition.firstSeq !== lastSeq + 1 || transition.lastSeq < transition.firstSeq || transition.lastSeq - transition.firstSeq >= 8) throw new Error('ZK transition journal boundaries overlap or contain a gap');
      const operations = records.slice(transition.firstSeq - 1, transition.lastSeq);
      if (!same(operations, transition.operations) || !same(transition.startingState, operations[0]?.beforeState)
        || !same(transition.endingState, operations.at(-1)?.afterState)) throw new Error('Frozen transition differs from its original operation journal');
      const swaps = operations.filter((op) => op.kind === 3);
      if ((transition.mode !== 0 && transition.mode !== 1)
        || (transition.mode === 0 ? swaps.length !== 0 : swaps.length < 1 || swaps.length > 4)) throw new Error('Frozen transition has an invalid swap count');
      const metadata = operations.map((op) => op.metadata); const da = operations.map((op) => op.da);
      while (metadata.length < 8) metadata.push(zeroMetadata());
      while (da.length < 8) da.push(zeroDA());
      const ending = operations.at(-1)!.afterState;
      const starting = operations[0].beforeState;
      const receiptsRoot = transition.mode === 1 ? buildReceiptTreeV2(swaps.map((op) => op.receipt!.leaf)).root : 0n;
      const poolDA = { poolHash: ending.poolHash, poolCiphertext: encryptPool(this.poolRecoveryKey, ending.poolHash, ending.pool) };
      const authDigest = hashAuthDigest(this.domain, version, metadata);
      const daDigest = hashDaDigest(this.domain, version, da, poolDA.poolHash, poolDA.poolCiphertext);
      const publicSignals = [this.domain, version, BigInt(transition.mode), starting.root, ending.root, starting.inboxCursor,
        ending.inboxCursor, starting.nextTradeId, ending.nextTradeId, receiptsRoot, authDigest, daDigest, this.poolKeyCommit];
      if (!same(transition.metadata, metadata) || !same(transition.accountDA, da) || !same(transition.poolDA, poolDA)
        || !same(transition.publicSignals, publicSignals) || transition.newRoot !== ending.root || transition.receiptsRoot !== receiptsRoot
        || transition.previousInboxCursor !== starting.inboxCursor || transition.newInboxCursor !== ending.inboxCursor
        || transition.previousTradeId !== starting.nextTradeId || transition.newTradeId !== ending.nextTradeId
        || transition.authDigest !== authDigest || transition.daDigest !== daDigest) throw new Error('Frozen transition public commitments or encrypted DA were altered');
      const expectedWitness = buildWitness({ chainId: this.config.chainId, vault: BigInt(this.config.vaultAddress), ruba: BigInt(this.config.rubaAddress),
        usdt: BigInt(this.config.usdtAddress), domain: this.domain, poolKeyCommit: this.poolKeyCommit, poolRecoveryKey: this.poolRecoveryKey,
        stateVersion: version, mode: transition.mode, startingState: starting, endingState: ending,
        operations: operations.map((op) => ({ ...op, path: op.path as [bigint, bigint, bigint, bigint] })), publicSignals, poolDa: poolDA });
      if (!same(transition.witness, expectedWitness)) throw new Error('Frozen circuit witness differs from the authenticated operation journal');
      const assigned = this.db.prepare('SELECT seq,transition_version FROM zk_operations WHERE seq>=? AND seq<=? ORDER BY seq').all(transition.firstSeq, transition.lastSeq) as { seq: number; transition_version: string | null }[];
      if (assigned.some((row) => row.transition_version !== version.toString())) throw new Error('Operation-to-transition assignments were altered');
      if (transition.mode === 1) { tradeBatchId++; if (transition.tradeBatchId !== tradeBatchId) throw new Error('Trade batch IDs are not sequential'); }
      else if (transition.tradeBatchId !== undefined) throw new Error('Control transition cannot create a trade batch');
      transitionRoot = transition.newRoot;
      lastSeq = transition.lastSeq;
      if (transition.status === 'accepted') {
        if (transition.stateVersion !== lastAccepted + 1n || transition.stateVersion > checkpoint.stateVersion) throw new Error('Accepted checkpoint is behind or skips its transition journal');
        lastAccepted = transition.stateVersion;
        if (transition.mode === 1) acceptedTradeBatches++;
      }
    }
    const acceptedTransition = checkpoint.stateVersion === 0n ? undefined : this.journal.transition(checkpoint.stateVersion);
    if (checkpoint.stateVersion !== lastAccepted || checkpoint.root !== (acceptedTransition?.newRoot ?? genesis)
      || checkpoint.journalSeq !== (acceptedTransition?.lastSeq ?? 0) || checkpoint.state.root !== checkpoint.root
      || checkpoint.tradeBatchId !== acceptedTradeBatches || checkpoint.inboxCursor !== checkpoint.state.inboxCursor
      || checkpoint.nextTradeId !== checkpoint.state.nextTradeId || checkpoint.txHash !== acceptedTransition?.txHash
      || checkpoint.blockNumber !== acceptedTransition?.blockNumber
      || !same(checkpoint.state, this.makeState(checkpoint.state.accounts, checkpoint.state.pool, checkpoint.state.inboxCursor, checkpoint.state.nextTradeId))) throw new Error('Accepted checkpoint differs from its immutable transition');
    const leftoverAssignments = this.db.prepare('SELECT transition_version FROM zk_operations WHERE seq>?').all(lastSeq) as { transition_version: string | null }[];
    if (leftoverAssignments.some((row) => row.transition_version !== null)) throw new Error('Unsealed operation has an unknown transition assignment');
    const swaps = records.filter((record) => record.kind === 3);
    const receipts = this.read().receipts;
    if (receipts.length !== swaps.length) throw new Error('Receipt history differs from the ZK swap journal');
    receipts.forEach((receipt, index) => {
      const { batchId: _batch, proof: _proof, ...privateReceipt } = receipt;
      if (!same(privateReceipt, swaps[index].receipt)) throw new Error('Stored receipt was altered after its economic transition');
    });
    const ledger = this.read();
    const reservations = records.filter((record) => record.kind === 6);
    const expectedNonces: Record<string, bigint> = {};
    if (reservations.length !== Object.keys(ledger.withdrawals).length) throw new Error('Withdrawal records differ from the durable proven reservation history');
    for (const operation of reservations) {
      const opening = operation.provenWithdrawal!.withdrawal;
      const key = `${opening.account}:${opening.nonce}`;
      const original = operation.ledgerAfter!.withdrawals[key];
      const settlements = records.filter((record) => record.kind === 7 && record.owner === operation.owner && record.params[3] === opening.nonce);
      if (settlements.length > 1) throw new Error('A proven withdrawal has duplicate canonical settlements');
      const expected = settlements[0]?.ledgerAfter?.withdrawals[key] ?? original;
      if (!same(ledger.withdrawals[key], expected) || expected.status !== (settlements.length ? 'settled' : 'pending')) throw new Error('Withdrawal status differs from its canonical settlement history');
      if (settlements.length && (settlements[0].params[0] !== operation.params[0] || settlements[0].params[1] !== opening.amount
        || !expected.settlementEventId)) throw new Error('Canonical settlement differs from its proven reservation');
      expectedNonces[opening.account] = opening.nonce + 1n;
    }
    if (!same(ledger.withdrawalNonces, expectedNonces)) throw new Error('Withdrawal nonce cache differs from its proven spend-nonce history');
  }
}
