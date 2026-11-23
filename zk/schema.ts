import { buildAccountTree, hashPool, encryptPool } from './crypto.js';
/** Authoritative wire/witness schema for the bounded local RUBA ZK v2 circuit. */
export const ACCOUNT_COUNT = 16;
export const ACCOUNT_DEPTH = 4;
export const MAX_OPERATIONS = 8;
export const PUBLIC_SIGNAL_NAMES = [
  'domain', 'stateVersion', 'mode', 'previousRoot', 'newRoot',
  'previousInboxCursor', 'newInboxCursor', 'previousTradeId', 'newTradeId',
  'receiptsRoot', 'authDigest', 'daDigest', 'poolKeyCommit',
] as const;
export type PublicSignalName = typeof PUBLIC_SIGNAL_NAMES[number];
export type Numeric = bigint | string | number;
export type Fields4 = [bigint, bigint, bigint, bigint];
export type Fields6 = [bigint, bigint, bigint, bigint, bigint, bigint];
export type Fields7 = [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
export type Fields9 = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
export enum OperationKind {
  NOP = 0, REGISTER = 1, DEPOSIT = 2, SWAP = 3, ADD_LP = 4,
  REMOVE_LP = 5, RESERVE_WITHDRAWAL = 6, SETTLE_WITHDRAWAL = 7, REFUND_WITHDRAWAL = 8,
}
export interface PublicationMetadata {
  kind: Numeric; slot: Numeric; owner: Numeric; commitment: Numeric;
  eventId: Numeric; token: Numeric; amount: Numeric; reference: Numeric; signature: string;
}
export interface DaRecord {
  kind: Numeric; slot: Numeric; owner: Numeric; newLeaf: Numeric; ciphertext: Numeric[];
}
export interface PoolDa { poolHash: Numeric; poolCiphertext: Numeric[] }
export interface ZkState {
  accounts: Fields9[]; pool: Fields6; inboxCursor: bigint; nextTradeId: bigint; root: bigint;
}
export interface ZkOperationRecord {
  kind: number; slot: number; owner: bigint; params: Fields4;
  oldAccount: Fields9; newAccount: Fields9; path: Fields4;
  oldPool: Fields6; newPool: Fields6; recoveryKey: bigint;
  metadata: PublicationMetadata; da: DaRecord; receiptSalt: bigint;
  beforeState?: ZkState; afterState?: ZkState; receipt?: unknown;
}
export interface TransitionPublicSignals {
  domain: Numeric; stateVersion: Numeric; mode: Numeric; previousRoot: Numeric; newRoot: Numeric;
  previousInboxCursor: Numeric; newInboxCursor: Numeric; previousTradeId: Numeric; newTradeId: Numeric;
  receiptsRoot: Numeric; authDigest: Numeric; daDigest: Numeric; poolKeyCommit: Numeric;
}
export interface TransitionWitness extends Record<PublicSignalName, string> {
  chainId: string; vault: string; ruba: string; usdt: string;
  startingAccountsRoot: string;
  pools: string[][];
  oldAccounts: string[][]; newAccounts: string[][]; accountPaths: string[][];
  params: string[][]; recoveryKeys: string[]; metadata: string[][];
  newLeaves: string[]; accountCiphertexts: string[][];
  poolRecoveryKey: string; finalPoolHash: string; poolCiphertext: string[];
  receiptSalts: string[];
  /** [swapOut,addQuote,addMintRuba,addMintUsdt,removeRuba,removeUsdt]. */
  quotients: string[][]; remainders: string[][]; sqrtFloors: string[]; addDirections: string[];
}
export interface BuildWitnessInput {
  chainId: Numeric; vault: Numeric; ruba: Numeric; usdt: Numeric; domain: Numeric;
  poolKeyCommit: Numeric; poolRecoveryKey: Numeric; stateVersion: Numeric; mode: Numeric;
  startingState: ZkState; endingState: ZkState; operations: ZkOperationRecord[];
  publicSignals: TransitionPublicSignals | Numeric[];
  poolDa?: PoolDa;
}

export function publicSignals(value: TransitionPublicSignals): string[] {
  return PUBLIC_SIGNAL_NAMES.map((name) => BigInt(value[name]).toString());
}

const ZERO_ACCOUNT = () => Array<bigint>(9).fill(0n) as Fields9;
const decimal = (values: Numeric[]) => values.map((value) => BigInt(value).toString());

function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Negative square root');
  if (value < 2n) return value;
  let x = value; let next = (x + 1n) / 2n;
  while (next < x) { x = next; next = (x + value / x) / 2n; }
  return x;
}

/** Circuit hints are checked by integer bounds/remainder constraints, never trusted outputs. */
function arithmeticHints(operation: ZkOperationRecord) {
  const q = Array<bigint>(6).fill(0n); const r = Array<bigint>(6).fill(0n);
  let root = 0n; let direction = 0n;
  const [p0, p1] = operation.params;
  const [rx, ry, supply] = operation.oldPool;
  const divide = (index: number, numerator: bigint, denominator: bigint) => {
    if (denominator <= 0n) throw new Error('Invalid circuit division denominator');
    q[index] = numerator / denominator; r[index] = numerator % denominator;
  };
  if (operation.kind === OperationKind.SWAP) {
    const reserveIn = p0 === 0n ? rx : ry; const reserveOut = p0 === 0n ? ry : rx;
    divide(0, p1 * 997n * reserveOut, reserveIn * 1000n + p1 * 997n);
  } else if (operation.kind === OperationKind.ADD_LP) {
    if (supply === 0n) root = sqrt(p0 * p1);
    else {
      const quoteUsdt = p0 * ry / rx;
      direction = quoteUsdt <= p1 ? 1n : 0n;
      let usedRuba: bigint; let usedUsdt: bigint;
      if (direction === 1n) { divide(1, p0 * ry, rx); usedRuba = p0; usedUsdt = q[1]; }
      else { divide(1, p1 * rx, ry); usedRuba = q[1]; usedUsdt = p1; }
      divide(2, usedRuba * supply, rx); divide(3, usedUsdt * supply, ry);
    }
  } else if (operation.kind === OperationKind.REMOVE_LP) {
    divide(4, p0 * rx, supply); divide(5, p0 * ry, supply);
  }
  return { q: decimal(q), r: decimal(r), root: root.toString(), direction: direction.toString() };
}

/** Arrays use exactly eight padded slots; input operation order is never changed. */
export function buildWitness(input: BuildWitnessInput): TransitionWitness {
  if (input.operations.length < 1 || input.operations.length > MAX_OPERATIONS) throw new Error('Transition requires 1..8 operations');
  if (input.startingState.accounts.length !== ACCOUNT_COUNT || input.endingState.accounts.length !== ACCOUNT_COUNT) throw new Error('Expected 16 account slots');
  const suppliedSignals = input.publicSignals;
  const signals = Array.isArray(suppliedSignals)
    ? Object.fromEntries(PUBLIC_SIGNAL_NAMES.map((name, i) => [name, suppliedSignals[i]])) as unknown as TransitionPublicSignals
    : suppliedSignals;
  const value = Object.fromEntries(PUBLIC_SIGNAL_NAMES.map((name) => [name, BigInt(signals[name]).toString()])) as unknown as TransitionWitness;
  Object.assign(value, {
    chainId: BigInt(input.chainId).toString(), vault: BigInt(input.vault).toString(),
    ruba: BigInt(input.ruba).toString(), usdt: BigInt(input.usdt).toString(),
    startingAccountsRoot: buildAccountTree(input.startingState.accounts).root.toString(),
    pools: [decimal(input.startingState.pool)], oldAccounts: [], newAccounts: [], accountPaths: [], params: [],
    recoveryKeys: [], metadata: [], newLeaves: [], accountCiphertexts: [], receiptSalts: [],
    quotients: [], remainders: [], sqrtFloors: [], addDirections: [],
  });
  for (let index = 0; index < MAX_OPERATIONS; ++index) {
    const op = input.operations[index];
    if (op) {
      const hint = arithmeticHints(op);
      value.pools.push(decimal(op.newPool));
      value.oldAccounts.push(decimal(op.oldAccount)); value.newAccounts.push(decimal(op.newAccount));
      value.accountPaths.push(decimal(op.path)); value.params.push(decimal(op.params));
      value.recoveryKeys.push(op.recoveryKey.toString());
      value.metadata.push(decimal([op.metadata.kind, op.metadata.slot, op.metadata.owner, op.metadata.commitment,
        op.metadata.eventId, op.metadata.token, op.metadata.amount, op.metadata.reference]));
      value.newLeaves.push(BigInt(op.da.newLeaf).toString()); value.accountCiphertexts.push(decimal(op.da.ciphertext));
      value.receiptSalts.push(op.receiptSalt.toString());
      value.quotients.push(hint.q); value.remainders.push(hint.r);
      value.sqrtFloors.push(hint.root); value.addDirections.push(hint.direction);
    } else {
      value.pools.push(decimal(input.endingState.pool));
      value.oldAccounts.push(decimal(ZERO_ACCOUNT())); value.newAccounts.push(decimal(ZERO_ACCOUNT()));
      value.accountPaths.push(decimal([0n, 0n, 0n, 0n])); value.params.push(decimal([0n, 0n, 0n, 0n]));
      value.recoveryKeys.push('0'); value.metadata.push(Array<string>(8).fill('0'));
      value.newLeaves.push('0'); value.accountCiphertexts.push(Array<string>(7).fill('0')); value.receiptSalts.push('0');
      value.quotients.push(Array<string>(6).fill('0')); value.remainders.push(Array<string>(6).fill('0'));
      value.sqrtFloors.push('0'); value.addDirections.push('0');
    }
  }
  value.poolRecoveryKey = BigInt(input.poolRecoveryKey).toString();
  value.finalPoolHash = hashPool(input.endingState.pool).toString();
  value.poolCiphertext = decimal(input.poolDa?.poolCiphertext
    ?? encryptPool(BigInt(input.poolRecoveryKey), BigInt(value.finalPoolHash), input.endingState.pool));
  return value;
}
