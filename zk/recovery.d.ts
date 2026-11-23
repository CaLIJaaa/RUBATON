import type { FieldInput, AuthRecord, DaRecord, PUBLIC_SIGNAL_FIELDS } from './crypto.js';

export const BACKUP_FORMAT: 'ruba-zk-account-backup';
export const BACKUP_VERSION: 2;
export const PROVEN_WITHDRAWAL_MODE: 'proven-reservation-v1';
export const RECOVERY_VAULT_ABI: readonly string[];

export interface RecoveryConfig {
  chainId: FieldInput; vault: FieldInput; ruba: FieldInput; usdt: FieldInput; poolKeyCommit: FieldInput;
  domain?: FieldInput; genesisStateRoot?: FieldInput;
  withdrawalMode?: 'legacy' | 'proven-reservation-v1';
}
export interface ChainCheckpoint {
  /** Must come from an independent canonical RPC read/event, never from uploaded JSON. */
  source: 'contract'; chainId: FieldInput; vault: FieldInput; stateVersion: FieldInput;
  stateRoot?: FieldInput; root?: FieldInput;
  blockNumber: FieldInput; blockHash: string; transactionHash: string; logIndex?: FieldInput; tradeBatchId?: FieldInput;
}
export interface RecoveryAnchor extends ChainCheckpoint {
  chainId: bigint; vault: bigint; stateVersion: bigint; stateRoot: bigint;
  blockNumber: bigint; logIndex: bigint; tradeBatchId?: bigint;
}
export type RecoveryPublicSignals = { [K in typeof PUBLIC_SIGNAL_FIELDS[number]]: FieldInput };
export type RecoveryMetadata = Omit<AuthRecord, 'reference'> & { signature?: string } &
  ({ reference: FieldInput; referenceId?: FieldInput } | { reference?: undefined; referenceId: FieldInput });
export interface AcceptedDaUpdate {
  publicSignals?: readonly FieldInput[] | RecoveryPublicSignals;
  signals?: readonly FieldInput[] | RecoveryPublicSignals;
  metadata?: readonly RecoveryMetadata[];
  operations?: readonly RecoveryMetadata[];
  da?: readonly DaRecord[]; accountDA?: readonly DaRecord[];
  pool?: { poolHash: FieldInput; poolCiphertext: readonly FieldInput[] };
  poolDA?: { poolHash: FieldInput; poolCiphertext: readonly FieldInput[] };
}
export interface RecoveryState {
  config: { chainId: bigint; vault: bigint; ruba: bigint; usdt: bigint; poolKeyCommit: bigint };
  withdrawalMode: 'legacy' | 'proven-reservation-v1';
  domain: bigint; root: bigint; accountsRoot: bigint; poolHash: bigint; poolCiphertext: bigint[] | null;
  inboxCursor: bigint; nextTradeId: bigint; stateVersion: bigint; tradeBatchId: bigint;
  leaves: bigint[]; owners: bigint[]; latestDa: (DaRecord | null)[]; anchor: RecoveryAnchor | null;
  scannedThrough?: { blockNumber: bigint; blockHash: string };
}
export interface OwnerRecoveryCredentials {
  owner: FieldInput; slot: FieldInput; recoveryKey: FieldInput; keyCommit?: FieldInput;
  /** Archival only. This module never signs or submits pending authorizations. */
  pendingAuthorizations?: unknown[];
  withdrawalClaims?: readonly WithdrawalClaimOpening[];
  recoverSigner?: WithdrawalSignatureRecovery;
}
export interface RecoveredOwnerAccount {
  owner: bigint; slot: number; recoveryKey: bigint; keyCommit: bigint;
  account: bigint[]; leaf: bigint; path: bigint[]; root: bigint; accountsRoot: bigint; poolHash: bigint;
  inboxCursor: bigint; nextTradeId: bigint; poolKeyCommit: bigint; domain: bigint; stateVersion: bigint;
  anchor: RecoveryAnchor | null; status: 'chain-anchored' | 'snapshot-only';
}
export interface AccountBackup {
  format: 'ruba-zk-account-backup'; version: 2;
  chainId: string; vault: string; ruba: string; usdt: string; owner: string; slot: string;
  recoveryKey: string; keyCommit: string; account: string[]; leaf: string; path: string[];
  domain: string; root: string; accountsRoot: string; poolHash: string;
  inboxCursor: string; nextTradeId: string; poolKeyCommit: string; stateVersion: string;
  anchor: null | { source: 'contract'; chainId: string; vault: string; stateVersion: string; stateRoot: string;
    blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; tradeBatchId?: string };
  pendingAuthorizations: unknown[];
  withdrawalClaims: WithdrawalClaimOpening[];
}
export interface WithdrawalClaimOpening {
  chainId: string; vault: string; domain: string; slot: string; commitment: string;
  withdrawal: { account: string; token: string; amount: string; nonce: string; spendNonce: string; salt: string };
  /** Optional while an opening is saved before requesting its owner's signature. */
  signature?: string;
  /** Archival hint only; actual acceptance/version/spent flags must be read from the Vault. */
  stateVersion: string | null;
}
export interface WithdrawalClaimContext {
  chainId: FieldInput; vault: FieldInput; domain: FieldInput; slot: FieldInput; owner: FieldInput;
  ruba: FieldInput; usdt: FieldInput;
}
export type WithdrawalSignatureRecovery = (domain: { name: string; version: string; chainId: bigint; verifyingContract: string },
  types: Record<string, { name: string; type: string }[]>, value: { commitment: bigint }, signature: string) => FieldInput;
export interface ClaimValidationOptions { recoverSigner?: WithdrawalSignatureRecovery }
export interface InspectedWithdrawalClaim {
  claim: WithdrawalClaimOpening; source: 'contract'; status: 'unpublished' | 'claimable' | 'spent' | 'nonce-used';
  accepted: boolean; spent: boolean; nonceUsed: boolean; stateVersion: bigint | null;
}
export interface WithdrawalClaimInspection {
  claims: InspectedWithdrawalClaim[]; checkedAt: { blockNumber: bigint; blockHash: string };
}
export type ExpectedBackupDeployment = Partial<Pick<RecoveryConfig, 'chainId' | 'vault' | 'ruba' | 'usdt'>> & { owner?: FieldInput };
export interface ImportedAccountBackup extends AccountBackup { status: 'snapshot-only'; current: false }
export interface BackupInspection {
  backup: ImportedAccountBackup;
  status: 'snapshot-only' | 'historical' | 'not-accepted' | 'chain-anchored'; current: boolean;
}
export interface RecoveryLog {
  address: string; blockNumber: FieldInput; blockHash: string; transactionHash: string;
  data: string; topics: readonly string[]; index?: FieldInput; logIndex?: FieldInput; removed?: boolean;
}
export interface RecoveryProvider {
  getNetwork(): Promise<{ chainId: FieldInput }>;
  getBlock(blockTag: string | number): Promise<{ number: FieldInput; hash: string | null } | null>;
  call(request: { to: string; data: string; blockTag: string }): Promise<string>;
  getLogs(filter: { address: string; topics: string[]; fromBlock: string; toBlock: string }): Promise<readonly RecoveryLog[]>;
  getTransaction(hash: string): Promise<{ to: string | null; hash: string; data: string; value?: FieldInput } | null>;
  getTransactionReceipt(hash: string): Promise<{ status: number | bigint | null; hash?: string; transactionHash?: string;
    blockNumber: FieldInput; blockHash: string; logs: readonly RecoveryLog[] } | null>;
}
/** Structurally matches an ethers v6 Interface created from the pinned RECOVERY_VAULT_ABI. */
export interface RecoveryContractInterface {
  getFunction(key: string): { format(format: 'sighash'): string } | null;
  getEvent(key: string): { format(format: 'sighash'): string; topicHash: string } | null;
  encodeFunctionData(name: string, args?: readonly unknown[]): string;
  decodeFunctionResult(name: string, data: string): ArrayLike<unknown>;
  parseLog(log: { topics: readonly string[]; data: string }): { name: string; args: ArrayLike<unknown> } | null;
  parseTransaction(tx: { data: string; value: FieldInput }): { signature: string; args: ArrayLike<unknown> } | null;
}
export interface RecoveryScanOptions {
  contractInterface: RecoveryContractInterface; fromBlock?: FieldInput; toBlock?: string | number;
  blockRange?: FieldInput;
  expected?: Partial<Pick<RecoveryConfig, 'chainId' | 'vault' | 'ruba' | 'usdt' | 'poolKeyCommit' | 'domain' | 'withdrawalMode'>>;
}
export interface WithdrawalClaimInspectionOptions extends ClaimValidationOptions {
  contractInterface: RecoveryContractInterface; claims: readonly WithdrawalClaimOpening[];
  context: WithdrawalClaimContext; toBlock?: string | number;
}

export function createRecoveryState(config: RecoveryConfig): RecoveryState;
export function applyAcceptedUpdate(state: RecoveryState, update: AcceptedDaUpdate, chainCheckpoint: ChainCheckpoint): RecoveryState;
export function recoverOwnedAccount(state: RecoveryState, credentials: OwnerRecoveryCredentials): RecoveredOwnerAccount;
export function recoverPool(state: RecoveryState, poolRecoveryKey: FieldInput): bigint[];
export function buildAccountBackup(state: RecoveryState, credentials: OwnerRecoveryCredentials): AccountBackup;
export function parseAccountBackup(input: unknown, expected?: ExpectedBackupDeployment, options?: ClaimValidationOptions): ImportedAccountBackup;
export function inspectAccountBackup(input: unknown, checkpoint?: Pick<ChainCheckpoint, 'source' | 'chainId' | 'vault' | 'stateVersion' | 'stateRoot' | 'root'>,
  expected?: ExpectedBackupDeployment, options?: ClaimValidationOptions): BackupInspection;
export function scanAcceptedUpdates(provider: RecoveryProvider, vault: FieldInput, options: RecoveryScanOptions): Promise<RecoveryState>;
export function validateWithdrawalClaims(input: unknown, context: WithdrawalClaimContext, options?: ClaimValidationOptions): WithdrawalClaimOpening[];
export function inspectWithdrawalClaims(provider: RecoveryProvider, vault: FieldInput, options: WithdrawalClaimInspectionOptions): Promise<WithdrawalClaimInspection>;
