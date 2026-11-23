export type FieldInput = bigint | string | number;
export type AccountFields = readonly [FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput];
export type PoolFields = readonly [FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput];
export type AccountPlaintext = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
export type AccountCiphertext = readonly [FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput, FieldInput];
export interface NamedAccount {
  owner: FieldInput; ruba: FieldInput; usdt: FieldInput; shares: FieldInput; spendNonce: FieldInput;
  pendingRuba: FieldInput; pendingUsdt: FieldInput; recoveryKeyCommit: FieldInput; salt: FieldInput;
}
export interface NamedPool {
  reserveRuba: FieldInput; reserveUsdt: FieldInput; totalSupply: FieldInput;
  lockedLiquidity: FieldInput; custodyRuba: FieldInput; custodyUsdt: FieldInput;
}
export interface StateHashInput {
  domain: FieldInput; accountsRoot: FieldInput; poolHash: FieldInput; inboxCursor: FieldInput;
  nextTradeId: FieldInput; poolKeyCommit: FieldInput;
}
export interface OperationHashInput {
  domain: FieldInput; kind: FieldInput; slot: FieldInput; owner: FieldInput; oldSpendNonce: FieldInput;
  params: readonly [FieldInput, FieldInput, FieldInput, FieldInput]; newSalt: FieldInput;
}
export interface ReceiptV2 {
  chainId: FieldInput; vault: FieldInput; tradeId: FieldInput; owner?: FieldInput; account?: FieldInput;
  tokenIn: FieldInput; tokenOut: FieldInput; amountIn: FieldInput; amountOut: FieldInput;
  feeNumerator: FieldInput; feeDenominator: FieldInput; reserveRubaBefore: FieldInput; reserveUsdtBefore: FieldInput;
  reserveRubaAfter: FieldInput; reserveUsdtAfter: FieldInput; salt: FieldInput;
}
export interface AuthRecord {
  kind: FieldInput; slot: FieldInput; owner: FieldInput; commitment: FieldInput;
  eventId: FieldInput; token: FieldInput; amount: FieldInput; reference: FieldInput;
}
export interface DaRecord {
  kind: FieldInput; slot: FieldInput; owner: FieldInput; newLeaf: FieldInput; ciphertext: readonly FieldInput[];
}
export interface OrderedTree {
  root: bigint; leaves: bigint[]; proofs: bigint[][]; levels: bigint[][];
}

export const FIELD: bigint;
export const TAGS: Readonly<{ DOMAIN: bigint; ACCOUNT: bigint; POOL: bigint; STATE: bigint; OP: bigint;
  AUTH: bigint; DA: bigint; RECEIPT: bigint; KEY: bigint; STREAM: bigint }>;
export const ACCOUNT_FIELDS: readonly ['owner', 'ruba', 'usdt', 'shares', 'spendNonce', 'pendingRuba', 'pendingUsdt', 'recoveryKeyCommit', 'salt'];
export const POOL_FIELDS: readonly ['reserveRuba', 'reserveUsdt', 'totalSupply', 'lockedLiquidity', 'custodyRuba', 'custodyUsdt'];
export const ACCOUNT_CIPHERTEXT_FIELDS: readonly ['ruba', 'usdt', 'shares', 'spendNonce', 'pendingRuba', 'pendingUsdt', 'salt'];
export const AUTH_FIELDS: readonly ['kind', 'slot', 'owner', 'commitment', 'eventId', 'token', 'amount', 'reference'];
export const PUBLIC_SIGNAL_FIELDS: readonly ['domain', 'stateVersion', 'mode', 'previousRoot', 'newRoot', 'previousInboxCursor', 'newInboxCursor', 'previousTradeId', 'newTradeId', 'receiptsRoot', 'authDigest', 'daDigest', 'poolKeyCommit'];

export function field(value: FieldInput): bigint;
export function fieldHex(value: FieldInput): string;
export function poseidon2(left: FieldInput, right: FieldInput): bigint;
export const H: typeof poseidon2;
export function fold(tag: FieldInput, values: readonly FieldInput[]): bigint;
export function accountVector(account: AccountFields | NamedAccount): bigint[];
export function poolVector(pool: PoolFields | NamedPool): bigint[];
export function emptyAccount(): bigint[];
export function emptyPool(): bigint[];
export function hashAccount(slot: FieldInput, account: AccountFields | NamedAccount | readonly FieldInput[]): bigint;
export function hashPool(pool: PoolFields | NamedPool | readonly FieldInput[]): bigint;
export function hashState(domain: FieldInput, accountsRoot: FieldInput, poolHash: FieldInput, inboxCursor: FieldInput, nextTradeId: FieldInput, poolKeyCommit: FieldInput): bigint;
export function hashState(input: StateHashInput): bigint;
export const stateHash: typeof hashState;
export function hashDomain(chainId: FieldInput, vault: FieldInput, ruba: FieldInput, usdt: FieldInput, poolKeyCommit: FieldInput): bigint;
export const domainHash: typeof hashDomain;
export function hashOperation(domain: FieldInput, kind: FieldInput, slot: FieldInput, owner: FieldInput, oldSpendNonce: FieldInput, params: readonly FieldInput[], newSalt: FieldInput): bigint;
export function hashOperation(input: OperationHashInput): bigint;
export function hashReceiptV2(receipt: ReceiptV2 | readonly FieldInput[]): bigint;
export function buildAccountTree(accounts?: readonly (AccountFields | NamedAccount | readonly FieldInput[] | undefined)[]): OrderedTree;
export function verifyAccountProof(slot: FieldInput, leaf: FieldInput, proof: readonly FieldInput[], root: FieldInput): boolean;
/** Accepts 1..4 actual receipts; returned tree always has four leaves, zero-padded. */
export function buildReceiptTreeV2(receiptsOrLeaves: readonly (ReceiptV2 | FieldInput)[]): OrderedTree;
export function keyCommit(key: FieldInput): bigint;
export function encrypt(key: FieldInput, nonce: FieldInput, plaintext: readonly FieldInput[]): bigint[];
export function decrypt(key: FieldInput, nonce: FieldInput, ciphertext: readonly FieldInput[]): bigint[];
export function encryptAccount(key: FieldInput, leaf: FieldInput, account: AccountFields | NamedAccount | readonly FieldInput[]): bigint[];
export function decryptAccount(key: FieldInput, leaf: FieldInput, ciphertext: readonly FieldInput[]): bigint[];
export function encryptPool(key: FieldInput, poolHash: FieldInput, pool: PoolFields | NamedPool | readonly FieldInput[]): bigint[];
export function decryptPool(key: FieldInput, poolHash: FieldInput, ciphertext: readonly FieldInput[]): bigint[];
export function hashAuthDigest(domain: FieldInput, stateVersion: FieldInput, records: readonly AuthRecord[]): bigint;
export function hashDaDigest(domain: FieldInput, stateVersion: FieldInput, records: readonly DaRecord[], poolHash: FieldInput, poolCiphertext: readonly FieldInput[]): bigint;
export function randomField(nonzero?: boolean): bigint;
