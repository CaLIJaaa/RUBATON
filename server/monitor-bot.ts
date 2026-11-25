import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { Contract, Interface, getAddress, type Provider, type Signer } from 'ethers';
import type { ZkRubaEngine } from './zk/engine.ts';

export type TokenRole = 'RUBA' | 'USDT';
export type Severity = 'pause' | 'alert' | 'clear' | 'error';

export interface MonitorEvent {
  at: number;
  market: string;
  criterion: 'transfer' | 'sanctions' | 'coverage' | 'root' | 'stuck' | 'price' | 'volume' | 'monitor';
  severity: Severity;
  token?: TokenRole;
  detail: string;
  txHash?: string;
}

export interface MonitorReads {
  marketPaused(): Promise<boolean>;
  withdrawalsPaused(token: TokenRole): Promise<boolean>;
  vaultBalance(token: TokenRole): Promise<bigint>;
  /** True when a transfer from the vault would go through right now. */
  probeTransfer(token: TokenRole, amount: bigint): Promise<boolean>;
  chainRoot(): Promise<bigint>;
  /** Payouts already sent from the vault that the server has not recorded yet. */
  unappliedPayouts(): Promise<Record<TokenRole, bigint>>;
}

export interface MonitorActions {
  pauseMarket(): Promise<string | undefined>;
  pauseWithdrawals(token: TokenRole): Promise<string | undefined>;
}

export interface MonitorLedger {
  custody(): Record<TokenRole, bigint>;
  knownRoots(): bigint[];
  pendingVersions(): bigint[];
  reserves(): Record<TokenRole, bigint>;
  nextTradeId(): bigint;
}

export interface SanctionsList { isListed(address: string): boolean }

export interface MonitorOptions {
  market: string;
  vaultAddress: string;
  tokenAddresses: Record<TokenRole, string>;
  decimals?: Record<TokenRole, number>;
  reads: MonitorReads;
  actions: MonitorActions;
  ledger: MonitorLedger;
  sanctions?: SanctionsList;
  dbPath?: string;
  now?: () => number;
  stuckAfterSeconds?: number;
  priceWindowSeconds?: number;
  priceJump?: number;
  tradesPerWindowLimit?: number;
}

const TOKENS: TokenRole[] = ['RUBA', 'USDT'];

/**
 * Monitor bot. Checks five things every run and pauses by itself only when money
 * can be stuck or missing. Everything it sees goes to its own journal.
 */
export class MonitorBot {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly active = new Map<string, MonitorEvent>();
  private readonly pendingSeen = new Map<bigint, number>();
  private prices: { at: number; price: number; tradeId: bigint }[] = [];
  private running = false;

  constructor(private readonly options: MonitorOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.db = new DatabaseSync(options.dbPath ?? ':memory:');
    this.db.exec(`CREATE TABLE IF NOT EXISTS monitor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, market TEXT NOT NULL, criterion TEXT NOT NULL,
      severity TEXT NOT NULL, token TEXT, detail TEXT NOT NULL, tx_hash TEXT)`);
  }

  events(): MonitorEvent[] {
    return (this.db.prepare('SELECT at, market, criterion, severity, token, detail, tx_hash FROM monitor_events ORDER BY id').all() as {
      at: number; market: string; criterion: MonitorEvent['criterion']; severity: Severity; token: TokenRole | null; detail: string; tx_hash: string | null;
    }[]).map((row) => ({ at: row.at, market: row.market, criterion: row.criterion, severity: row.severity,
      ...(row.token ? { token: row.token } : {}), detail: row.detail, ...(row.tx_hash ? { txHash: row.tx_hash } : {}) }));
  }

  activeIssues(): MonitorEvent[] { return [...this.active.values()]; }

  private log(event: Omit<MonitorEvent, 'at' | 'market'>): MonitorEvent {
    const full: MonitorEvent = { at: this.now(), market: this.options.market, ...event };
    this.db.prepare('INSERT INTO monitor_events (at, market, criterion, severity, token, detail, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(full.at, full.market, full.criterion, full.severity, full.token ?? null, full.detail, full.txHash ?? null);
    return full;
  }

  /** Logs an issue once while it lasts and a clear record when it goes away. */
  private raise(key: string, event: Omit<MonitorEvent, 'at' | 'market'>): boolean {
    if (this.active.has(key)) return false;
    this.active.set(key, this.log(event));
    return true;
  }

  private resolve(key: string, detail: string): void {
    const issue = this.active.get(key);
    if (!issue) return;
    this.active.delete(key);
    this.log({ criterion: issue.criterion, severity: 'clear', ...(issue.token ? { token: issue.token } : {}), detail });
  }

  async check(): Promise<MonitorEvent[]> {
    if (this.running) return [];
    this.running = true;
    const before = this.events().length;
    try {
      await this.guard('transfer', () => this.checkTransfers());
      await this.guard('sanctions', async () => this.checkSanctions());
      await this.guard('coverage', () => this.checkCoverage());
      await this.guard('root', () => this.checkRoots());
      await this.guard('price', async () => this.checkPrice());
    } finally { this.running = false; }
    return this.events().slice(before);
  }

  private async guard(criterion: MonitorEvent['criterion'], run: () => Promise<void>) {
    try { await run(); this.resolve(`error:${criterion}`, 'Проверка снова работает'); }
    catch (error) { this.raise(`error:${criterion}`, { criterion: 'monitor', severity: 'error', detail: `Проверка «${criterion}» не выполнена: ${message(error)}` }); }
  }

  private async checkTransfers() {
    const { reads, actions } = this.options;
    for (const token of TOKENS) {
      const balance = await reads.vaultBalance(token);
      const ok = await reads.probeTransfer(token, balance > 0n ? 1n : 0n);
      const key = `transfer:${token}`;
      if (ok) { this.resolve(key, `Пробный перевод ${token} из Vault снова проходит. Возобновление решают две роли паузы.`); continue; }
      if (this.active.has(key)) continue;
      const hashes: string[] = [];
      if (!await reads.withdrawalsPaused(token)) { const hash = await actions.pauseWithdrawals(token); if (hash) hashes.push(hash); }
      if (!await reads.marketPaused()) { const hash = await actions.pauseMarket(); if (hash) hashes.push(hash); }
      this.raise(key, { criterion: 'transfer', severity: 'pause', token,
        detail: `Пробный перевод ${token} из Vault не проходит. Поставлены пауза вывода ${token} и пауза рынка.`, ...(hashes.length ? { txHash: hashes.join(',') } : {}) });
    }
  }

  private checkSanctions() {
    const list = this.options.sanctions;
    if (!list) return;
    const watched: [string, string][] = [['Vault', this.options.vaultAddress],
      ...TOKENS.map((token) => [`токен ${token}`, this.options.tokenAddresses[token]] as [string, string])];
    for (const [label, address] of watched) {
      const key = `sanctions:${address.toLowerCase()}`;
      if (list.isListed(address)) this.raise(key, { criterion: 'sanctions', severity: 'alert', detail: `${label} ${getAddress(address)} в санкционном списке. Переводы пока идут, решение за человеком.` });
      else this.resolve(key, `${label} больше нет в санкционном списке`);
    }
  }

  private async checkCoverage() {
    const { reads, actions, ledger } = this.options;
    const custody = ledger.custody();
    const paid = await reads.unappliedPayouts();
    for (const token of TOKENS) {
      const obligation = custody[token] - paid[token];
      const balance = await reads.vaultBalance(token);
      const key = `coverage:${token}`;
      if (balance >= obligation) { this.resolve(key, `Баланс ${token} в Vault снова покрывает обязательства`); continue; }
      if (this.active.has(key)) continue;
      const hash = await reads.marketPaused() ? undefined : await actions.pauseMarket();
      this.raise(key, { criterion: 'coverage', severity: 'pause', token,
        detail: `В Vault ${balance} ${token}, обязательства ${obligation}. Не хватает ${obligation - balance}. Поставлена пауза рынка.`, ...(hash ? { txHash: hash } : {}) });
    }
  }

  private async checkRoots() {
    const { reads, ledger } = this.options;
    const root = await reads.chainRoot();
    if (ledger.knownRoots().includes(root)) this.resolve('root', 'Корень в контракте снова совпадает с сервером');
    else this.raise('root', { criterion: 'root', severity: 'alert', detail: `Корня ${root.toString(16).slice(0, 12)}… из контракта нет на сервере. Проверьте, кто опубликовал переход.` });

    const now = this.now();
    const pending = new Set(ledger.pendingVersions());
    for (const version of [...this.pendingSeen.keys()]) if (!pending.has(version)) this.pendingSeen.delete(version);
    for (const version of pending) if (!this.pendingSeen.has(version)) this.pendingSeen.set(version, now);
    const oldest = Math.min(...[...this.pendingSeen.values()], now);
    const limit = this.options.stuckAfterSeconds ?? 900;
    if (pending.size && now - oldest >= limit) {
      this.raise('stuck', { criterion: 'stuck', severity: 'alert', detail: `Переход ждёт публикации больше ${Math.floor((now - oldest) / 60)} мин. Очередь операций стоит.` });
    } else this.resolve('stuck', 'Очередь переходов снова движется');
  }

  private checkPrice() {
    const { ledger } = this.options;
    const reserves = ledger.reserves();
    if (reserves.RUBA === 0n || reserves.USDT === 0n) return;
    const decimals = this.options.decimals ?? { RUBA: 18, USDT: 6 };
    const price = Number(reserves.USDT) / 10 ** decimals.USDT / (Number(reserves.RUBA) / 10 ** decimals.RUBA);
    const now = this.now();
    const window = this.options.priceWindowSeconds ?? 600;
    this.prices = this.prices.filter((point) => now - point.at <= window);
    this.prices.push({ at: now, price, tradeId: ledger.nextTradeId() });
    const reference = this.prices[0];
    const jump = Math.abs(price / reference.price - 1);
    const limit = this.options.priceJump ?? 0.2;
    if (jump > limit) this.raise('price', { criterion: 'price', severity: 'alert', detail: `Цена пула сдвинулась на ${(jump * 100).toFixed(1)}% за ${Math.round((now - reference.at) / 60)} мин.` });
    else this.resolve('price', 'Цена пула вернулась в допустимый коридор');
    const trades = Number(ledger.nextTradeId() - reference.tradeId);
    const tradeLimit = this.options.tradesPerWindowLimit ?? 40;
    if (trades > tradeLimit) this.raise('volume', { criterion: 'volume', severity: 'alert', detail: `За окно прошло ${trades} свопов, порог ${tradeLimit}.` });
    else this.resolve('volume', 'Число свопов вернулось к обычному');
  }

  close(): void { this.db.close(); }
}

function message(error: unknown): string {
  if (error && typeof error === 'object' && ('code' in error || 'info' in error)) return 'ошибка RPC';
  return error instanceof Error ? error.message : String(error);
}

export class FileSanctionsList implements SanctionsList {
  private readonly listed: Set<string>;
  constructor(path: string) {
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const values: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.addresses) ? raw.addresses : [];
    this.listed = new Set(values.map((value) => getAddress(String(value)).toLowerCase()));
  }
  isListed(address: string): boolean { return this.listed.has(address.toLowerCase()); }
}

const TOKEN_ABI = ['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)'];
const VAULT_ABI = [
  'function marketPaused() view returns(bool)', 'function withdrawalsPaused(address) view returns(bool)',
  'function setMarketPaused(bool)', 'function setTokenWithdrawalsPaused(address,bool)',
  'function stateRoot() view returns(bytes32)', 'function nextInboxEventId() view returns(uint256)',
  'function inbox(uint256) view returns(uint256 kind,address owner,uint256 tokenIndex,uint256 amount,uint256 referenceId)',
];

export interface ChainMonitorOptions {
  market: string;
  provider: Provider;
  signer: Signer;
  vaultAddress: string;
  tokenAddresses: Record<TokenRole, string>;
  decimals?: Record<TokenRole, number>;
  engine: ZkRubaEngine;
  sanctionsFile?: string;
  dbPath?: string;
  stuckAfterSeconds?: number;
}

/** Wires the bot to a live vault. The signer must be the owner or one of the pause roles. */
export function createChainMonitor(options: ChainMonitorOptions): MonitorBot {
  const vault = new Contract(options.vaultAddress, VAULT_ABI, options.signer);
  const token = (role: TokenRole) => new Contract(options.tokenAddresses[role], TOKEN_ABI, options.provider);
  const transfer = new Interface(TOKEN_ABI);
  const engine = options.engine;
  const send = async (call: () => Promise<{ hash: string; wait(): Promise<unknown> }>) => {
    const transaction = await call();
    await transaction.wait();
    return transaction.hash;
  };
  return new MonitorBot({
    market: options.market, vaultAddress: options.vaultAddress, tokenAddresses: options.tokenAddresses, decimals: options.decimals,
    dbPath: options.dbPath, stuckAfterSeconds: options.stuckAfterSeconds,
    sanctions: options.sanctionsFile ? new FileSanctionsList(options.sanctionsFile) : undefined,
    reads: {
      marketPaused: () => vault.marketPaused(),
      withdrawalsPaused: (role) => vault.withdrawalsPaused(options.tokenAddresses[role]),
      vaultBalance: async (role) => BigInt(await token(role).balanceOf(options.vaultAddress)),
      async probeTransfer(role, amount) {
        const data = transfer.encodeFunctionData('transfer', [await options.signer.getAddress(), amount]);
        try {
          const result = await options.provider.call({ from: options.vaultAddress, to: options.tokenAddresses[role], data });
          return result === '0x' || BigInt(result) !== 0n;
        } catch (error) {
          if ((error as { code?: string })?.code === 'CALL_EXCEPTION') return false;
          throw error;
        }
      },
      chainRoot: async () => BigInt(await vault.stateRoot()),
      async unappliedPayouts() {
        const out: Record<TokenRole, bigint> = { RUBA: 0n, USDT: 0n };
        const next = BigInt(await vault.nextInboxEventId());
        for (let id = engine.journal.current().inboxCursor + 1n; id < next; id++) {
          const message = await vault.inbox(id);
          if (BigInt(message.kind) === 7n) out[BigInt(message.tokenIndex) === 0n ? 'RUBA' : 'USDT'] += BigInt(message.amount);
        }
        return out;
      },
    },
    actions: {
      pauseMarket: () => send(() => vault.setMarketPaused(true)),
      pauseWithdrawals: (role) => send(() => vault.setTokenWithdrawalsPaused(options.tokenAddresses[role], true)),
    },
    ledger: {
      custody: () => { const pool = engine.journal.current().pool; return { RUBA: pool[4], USDT: pool[5] }; },
      reserves: () => { const pool = engine.journal.current().pool; return { RUBA: pool[0], USDT: pool[1] }; },
      nextTradeId: () => engine.journal.current().nextTradeId,
      knownRoots: () => [engine.getAcceptedCheckpoint().root, ...engine.listTransitions().map((transition) => transition.newRoot)],
      pendingVersions: () => engine.listTransitions().filter((transition) => transition.status === 'pending').map((transition) => transition.stateVersion),
    },
  });
}

/** Runs every bot on a timer, about once per Ethereum block by default. Returns a stop function. */
export function startMonitorLoop(bots: MonitorBot[], intervalMs = 12_000, onEvent: (event: MonitorEvent) => void = () => {}): () => void {
  const timer = setInterval(() => {
    for (const bot of bots) void bot.check().then((events) => events.forEach(onEvent)).catch(() => {});
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
