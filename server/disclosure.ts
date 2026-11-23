import type { ReceiptBatch, TradeReceipt } from './types.ts';

/** An explicit allowlist: ReceiptBatch also contains private state preimages. */
export function publicReceiptBatch(batch: ReceiptBatch) {
  return {
    ...(batch.version === 2 ? { version: 2, stateVersion: batch.stateVersion } : {}),
    batchId: batch.batchId,
    previousStateRoot: batch.previousStateRoot,
    newStateRoot: batch.newStateRoot,
    receiptsRoot: batch.receiptsRoot,
    firstTradeId: batch.firstTradeId,
    tradeCount: batch.tradeCount,
    ...(batch.publishedTxHash ? { publishedTxHash: batch.publishedTxHash } : {}),
  };
}

export function disclosureBundle(
  receipt: TradeReceipt,
  batch: ReceiptBatch,
  tokens: { RUBA: { address: string; decimals: number; symbol?: string }; USDT: { address: string; decimals: number; symbol?: string } },
) {
  return {
    format: 'ruba-trade-disclosure',
    version: receipt.version === 2 || batch.version === 2 ? 2 : 1,
    receipt,
    batch: publicReceiptBatch(batch),
    tokens: Object.fromEntries(['RUBA', 'USDT'].map((key) => {
      const token = tokens[key as keyof typeof tokens];
      return [key, { address: token.address, decimals: token.decimals, ...(token.symbol === undefined ? {} : { symbol: token.symbol }) }];
    })) as typeof tokens,
  };
}
