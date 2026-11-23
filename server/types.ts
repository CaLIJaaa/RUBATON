import type { ZkSignedPublication } from "./zk/types.ts";

export type Token = "RUBA" | "USDT";
export type TokenAmounts = Record<Token, bigint>;

export interface EngineConfig {
  dbPath: string;
  chainId: bigint;
  vaultAddress: string;
  rubaAddress: string;
  usdtAddress: string;
}

export interface TradeReceipt {
  version?: 1 | 2;
  chainId: bigint;
  vault: string;
  tradeId: bigint;
  account: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Exact nominal fee as a rational number of input-token atomic units. */
  feeNumerator: bigint;
  feeDenominator: bigint;
  reserveRubaBefore: bigint;
  reserveUsdtBefore: bigint;
  reserveRubaAfter: bigint;
  reserveUsdtAfter: bigint;
  salt: string;
  leaf: string;
  batchId?: bigint;
  proof?: string[];
}

export interface ReceiptBatch {
  version?: 1 | 2;
  stateVersion?: bigint;
  batchId: bigint;
  previousStateRoot: string;
  newStateRoot: string;
  receiptsRoot: string;
  firstTradeId: bigint;
  tradeCount: bigint;
  /** Private preimage material; never submit it to Ethereum. */
  stateSalt: string;
  stateSnapshot: string;
  tradeIds: bigint[];
  publishedTxHash?: string;
}

export type BatchCommitment = Pick<ReceiptBatch, "batchId" | "previousStateRoot" | "newStateRoot" | "receiptsRoot" | "firstTradeId" | "tradeCount">;

/** Public authorization; the user's wallet submits it and pays publication gas. */
export interface SignedBatchPublication {
  kind?: 'legacy';
  chainId: bigint;
  vault: string;
  batch: BatchCommitment;
  deadline: bigint;
  signerEpoch: bigint;
  signature: string;
}

export interface PublicationPreparation {
  status: "ready" | "waiting" | "idle" | "proving";
  request: SignedBatchPublication | ZkSignedPublication | null;
  progress: { collected: number; required: 4 };
}

/** Only public commitments; never expose the private batch snapshot or salt. */
export interface PublicReceiptBatch {
  chainId: bigint;
  vault: string;
  batch: Pick<ReceiptBatch, "batchId" | "previousStateRoot" | "newStateRoot" | "receiptsRoot" | "firstTradeId" | "tradeCount" | "publishedTxHash">;
  status: "pending" | "published";
  source: "server" | "contract";
  submittedTxHash?: string;
  blockNumber?: number;
}

export interface WithdrawalRecord {
  account: string;
  token: Token;
  tokenAddress: string;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  signerEpoch: bigint;
  status: "pending" | "settled" | "expired";
  settlementEventId?: string;
}

export interface ProvenWithdrawal {
  account: string;
  token: string;
  amount: bigint;
  nonce: bigint;
  spendNonce: bigint;
  salt: bigint;
}

export interface LegacyWithdrawalTicket {
  withdrawal: { account: string; token: string; amount: bigint; nonce: bigint; deadline: bigint; signerEpoch: bigint };
  signature: string;
}

/** Private owner-bound opening of an immutable, proof-reserved payout. No operator signature. */
export interface ProvenWithdrawalTicket {
  kind: 'zk-withdrawal';
  chainId: bigint;
  vault: string;
  withdrawal: ProvenWithdrawal;
  commitment: bigint;
  stateVersion: bigint | null;
}

export type WithdrawalTicket = LegacyWithdrawalTicket | ProvenWithdrawalTicket;

export interface AccountSnapshot {
  account: string;
  balances: TokenAmounts;
  lpShares: bigint;
  actionNonce: bigint;
  withdrawals: WithdrawalRecord[];
}
