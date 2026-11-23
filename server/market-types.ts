import type { ServerConfig } from './config.ts';
import type { RubaApi } from './api.ts';
import type { ZkRubaEngine } from './zk/engine.ts';
import type { ZkVaultChain } from './zk/chain.ts';
import type { Signer } from 'ethers';

export const MARKET_IDS = ['ruba-usdt', 'ruba-weth', 'weth-wbtc'] as const;
export type MarketId = typeof MARKET_IDS[number];
export type DemoSymbol = 'RUBA' | 'USDT' | 'WETH' | 'WBTC';
export interface MarketAsset { symbol: string; decimals: number; address: string }
export interface MarketRuntime {
  id: string; label: string; config: ServerConfig; engine: ZkRubaEngine; chain: ZkVaultChain; api: RubaApi;
}
export interface ArbitrageSettings { enabled: boolean; delaySeconds: number; maxTradeBps: number; minDeviationBps: number }
export type ReferencePrices = Record<DemoSymbol, string>;
export interface MarketSettings {
  revision: bigint; prices: ReferencePrices; arbitrage: Record<string, ArbitrageSettings>;
}
export interface TransactionQueue { run<T>(operation: () => Promise<T>): Promise<T> }
export interface ArbitrageDependencies {
  markets: MarketRuntime[]; botSigner: Signer; transactionSigner: Signer;
  settings: () => MarketSettings; transactionQueue: TransactionQueue; now?: () => number;
}
export interface ArbitrageStatus {
  status: 'disabled' | 'idle' | 'scheduled' | 'waiting' | 'executing' | 'publishing' | 'error';
  nextRunAt: number | null; error?: string; message?: string;
}
export interface ArbitrageController {
  getStatus(marketId: string): ArbitrageStatus;
  runOnce(nowMs?: number): Promise<void>;
  start(intervalMs?: number): () => void;
  stop(): void;
  drain(): Promise<void>;
}
