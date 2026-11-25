import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAddress } from 'ethers';
import type { ArbitrageSettings, MarketSettings, ReferencePrices } from './market-types.ts';
import { parsePrice } from './price-math.ts';

const SYMBOLS = ['RUBA', 'USDT', 'WETH', 'WBTC'] as const;
const MAX_UINT = (1n << 256n) - 1n;
export const DEFAULT_REFERENCE_PRICES: ReferencePrices = { RUBA: '1', USDT: '1', WETH: '3000', WBTC: '90000' };
export const DEFAULT_ARBITRAGE_SETTINGS: ArbitrageSettings = { enabled: false, delaySeconds: 30, maxTradeBps: 2000, minDeviationBps: 40 };
export type ControlCommand =
  | { kind: 'prices'; prices: ReferencePrices }
  | { kind: 'arbitrage'; marketId: string; enabled: boolean; delaySeconds: number }
  | { kind: 'monitor'; marketId: string }
  | { kind: 'closeBatch'; marketId: string }
  | { kind: 'rebuildQueue'; marketId: string };
export interface AcceptedHistoryPoint {
  stateVersion: bigint; root: bigint; blockNumber: number; timestamp: bigint;
  blockHash?: string;
  spot: string; target: string; deviationBps: bigint;
  referenceSource?: 'observed-manual' | 'current-manual';
}
export interface MarketSettingsOptions {
  path: string;
  markets: readonly string[];
  binding: { chainId: bigint; defaultVault: string; admin: string; marketsHash?: string };
}

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item);
}
function decode<T>(text: string): T {
  return JSON.parse(text, (_key, item) => item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.$bigint === 'string' ? BigInt(item.$bigint) : item) as T;
}
const clone = <T>(value: T): T => decode<T>(encode(value));
function object(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error(`Invalid ${name} fields`);
  return value as Record<string, unknown>;
}
export function validateReferencePrice(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Prices must be positive canonical decimals with at most 18 decimal places');
  try { parsePrice(value); } catch { throw new Error('Prices must be positive canonical decimals with at most 18 decimal places'); }
  return value;
}
export function validateControlCommand(value: unknown, marketIds: readonly string[]): ControlCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid control command');
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'prices') {
    const command = object(value, ['kind', 'prices'], 'prices command');
    const prices = object(command.prices, SYMBOLS, 'reference prices');
    const parsed = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, validateReferencePrice(prices[symbol])])) as ReferencePrices;
    if (parsed.USDT !== '1') throw new Error('The manual USDT reference price is fixed at 1');
    return { kind, prices: parsed };
  }
  if (kind === 'arbitrage' || kind === 'monitor' || kind === 'closeBatch' || kind === 'rebuildQueue') {
    const command = object(value, kind === 'arbitrage' ? ['kind', 'marketId', 'enabled', 'delaySeconds'] : ['kind', 'marketId'], `${kind} command`);
    if (typeof command.marketId !== 'string' || !marketIds.includes(command.marketId)) throw new Error('Unknown market');
    if (kind === 'monitor' || kind === 'closeBatch' || kind === 'rebuildQueue') return { kind, marketId: command.marketId };
    if (typeof command.enabled !== 'boolean' || typeof command.delaySeconds !== 'number' || !Number.isInteger(command.delaySeconds)
      || command.delaySeconds < 5 || command.delaySeconds > 3600) throw new Error('Arbitrage delay must be an integer from 5 to 3600 seconds');
    return { kind, marketId: command.marketId, enabled: command.enabled, delaySeconds: command.delaySeconds };
  }
  throw new Error('Unknown control command');
}

/** Global policy/nonce storage. It never contains market balances, witnesses or keys. */
export class MarketSettingsStore {
  readonly db: DatabaseSync;
  readonly marketIds: string[];
  constructor(options: MarketSettingsOptions) {
    this.marketIds = [...options.markets].sort();
    if (!this.marketIds.length || new Set(this.marketIds).size !== this.marketIds.length) throw new Error('Settings require distinct market IDs');
    const path = options.path === ':memory:' ? options.path : resolve(options.path);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS market_control (id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,nonce TEXT NOT NULL,settings TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS market_control_audit (nonce TEXT PRIMARY KEY,command TEXT NOT NULL,revision TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS market_history (market_key TEXT NOT NULL,state_version TEXT NOT NULL,point TEXT NOT NULL,PRIMARY KEY(market_key,state_version))`);
      const binding = encode({ version: 1, chainId: options.binding.chainId, defaultVault: getAddress(options.binding.defaultVault),
        admin: getAddress(options.binding.admin), markets: this.marketIds, marketsHash: options.binding.marketsHash ?? null });
      const row = this.db.prepare('SELECT binding FROM market_control WHERE id=1').get() as { binding: string } | undefined;
      if (row && row.binding !== binding) throw new Error('Control database belongs to another deployment, admin or market catalog');
      if (!row) {
        const settings: MarketSettings = { revision: 0n, prices: { ...DEFAULT_REFERENCE_PRICES },
          arbitrage: Object.fromEntries(this.marketIds.map((id) => [id, { ...DEFAULT_ARBITRAGE_SETTINGS }])) };
        this.db.prepare('INSERT INTO market_control VALUES(1,?,?,?)').run(binding, '0', encode(settings));
      }
      this.getSettings(); this.getNonce();
    } catch (error) { this.db.close(); throw error; }
  }
  getNonce(): bigint {
    const row = this.db.prepare('SELECT nonce FROM market_control WHERE id=1').get() as { nonce: string };
    if (!/^(0|[1-9][0-9]*)$/.test(row.nonce) || BigInt(row.nonce) > MAX_UINT) throw new Error('Invalid persisted control nonce');
    return BigInt(row.nonce);
  }
  getSettings(): MarketSettings {
    const row = this.db.prepare('SELECT settings FROM market_control WHERE id=1').get() as { settings: string };
    const settings = decode<MarketSettings>(row.settings);
    if (typeof settings.revision !== 'bigint' || settings.revision < 0n || settings.revision > MAX_UINT) throw new Error('Invalid persisted settings revision');
    validateControlCommand({ kind: 'prices', prices: settings.prices }, this.marketIds);
    if (Object.keys(settings.arbitrage).sort().join(',') !== this.marketIds.join(',')) throw new Error('Persisted arbitrage markets differ from this catalog');
    for (const id of this.marketIds) {
      const policy = settings.arbitrage[id];
      validateControlCommand({ kind: 'arbitrage', marketId: id, enabled: policy.enabled, delaySeconds: policy.delaySeconds }, this.marketIds);
      if (policy.maxTradeBps !== 2000 || policy.minDeviationBps !== 40) throw new Error('Persisted arbitrage limits are unsupported');
    }
    return settings;
  }
  apply(commandInput: unknown, expectedNonce: bigint, monitor?: () => unknown): { result: unknown; nonce: bigint; revision: bigint } {
    const command = validateControlCommand(commandInput, this.marketIds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const nonce = this.getNonce(); const settings = this.getSettings();
      if (expectedNonce !== nonce || nonce === MAX_UINT) throw new Error('Invalid control nonce; refresh the catalog before signing');
      let result: unknown;
      if (command.kind === 'closeBatch' || command.kind === 'rebuildQueue') {
        // Persist the one-shot administrator authorization before asynchronous
        // market sealing/proving. A retry uses a fresh control nonce.
        result = { marketId: command.marketId };
      } else if (command.kind === 'monitor') {
        if (!monitor) throw new Error('Monitor callback is required');
        result = monitor();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Control transactions must be synchronous');
      } else {
        if (settings.revision === MAX_UINT) throw new Error('Settings revision is exhausted');
        settings.revision++;
        if (command.kind === 'prices') settings.prices = command.prices;
        else settings.arbitrage[command.marketId] = { ...settings.arbitrage[command.marketId], enabled: command.enabled, delaySeconds: command.delaySeconds };
        result = clone(settings);
      }
      this.db.prepare('UPDATE market_control SET nonce=?,settings=? WHERE id=1').run((nonce + 1n).toString(), encode(settings));
      this.db.prepare('INSERT INTO market_control_audit VALUES(?,?,?)').run(nonce.toString(), encode(command), settings.revision.toString());
      const response = clone({ result, nonce: nonce + 1n, revision: settings.revision });
      this.db.exec('COMMIT'); return response;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getHistory(key: string): AcceptedHistoryPoint[] {
    return (this.db.prepare('SELECT point FROM market_history WHERE market_key=? ORDER BY length(state_version),state_version').all(key) as { point: string }[])
      .map((row) => decode<AcceptedHistoryPoint>(row.point));
  }
  recordHistory(key: string, point: AcceptedHistoryPoint): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT point FROM market_history WHERE market_key=? AND state_version=?').get(key, point.stateVersion.toString()) as { point: string } | undefined;
      if (existing) {
        const previous = decode<AcceptedHistoryPoint>(existing.point);
        if (previous.root !== point.root || (previous.blockHash && point.blockHash && previous.blockHash !== point.blockHash)) throw new Error('Accepted history root or block changed; reconcile the market');
      } else this.db.prepare('INSERT INTO market_history VALUES(?,?,?)').run(key, point.stateVersion.toString(), encode(point));
      this.db.prepare('DELETE FROM market_history WHERE market_key=? AND rowid NOT IN (SELECT rowid FROM market_history WHERE market_key=? ORDER BY length(state_version) DESC,state_version DESC LIMIT 120)').run(key, key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
