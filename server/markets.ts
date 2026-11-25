import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { uint } from './auth.ts';
import { json } from './api.ts';
import { tokenMetadata } from './config.ts';
import type { ArbitrageController, ArbitrageStatus, DemoSymbol, MarketAsset, MarketRuntime, MarketSettings } from './market-types.ts';
import { MarketSettingsStore, validateControlCommand } from './market-settings.ts';
import type { AcceptedHistoryPoint } from './market-settings.ts';
import { deviationBps, formatPrice, spotPrice, targetPrice } from './price-math.ts';
import { hashPool, hashState } from '../zk/crypto.js';
import type { ZkState } from './zk/journal.ts';
import { checkedSignals } from './zk/types.ts';

export const MARKET_CONTROL_TYPES = { ControlAction: [
  { name: 'actionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };
export function marketControlDomain(chainId: bigint, defaultVault: string) {
  return { name: 'RubaMarketControl', version: '1', chainId, verifyingContract: getAddress(defaultVault) };
}
/** Control JSON permits integer delaySeconds; economic signing keeps its stricter serializer. */
export function canonicalControlJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalControlJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid control JSON object');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalControlJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Control JSON accepts only safe integer numbers and JSON values');
}
export function controlActionHash(command: unknown): string { return keccak256(toUtf8Bytes(canonicalControlJson(command))); }
export interface MarketsServerOptions {
  markets: MarketRuntime[];
  adminAddress: string;
  settingsPath: string;
  defaultMarketId?: string;
  network?: { chainId?: bigint | string; name: string; explorerUrl: string };
  arbController?: ArbitrageController;
}
export interface ControlRequest { command: unknown; nonce: string; deadline: string; signature: string }
class MarketHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
interface Descriptor { id: string; label: string; chainId: bigint; vault: string; base: MarketAsset; quote: MarketAsset }
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SYMBOLS = new Set(['RUBA', 'USDT', 'WETH', 'WBTC']);
const STATUSES = new Set(['disabled', 'idle', 'scheduled', 'waiting', 'executing', 'publishing', 'error']);
function databaseIdentity(path: string): string | undefined {
  if (path === ':memory:') return undefined;
  const absolute = resolve(path); return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/** One HTTP surface; each scoped API retains its own ledger, queue, proof cache and Vault. */
export class MarketsServer {
  readonly markets: ReadonlyMap<string, MarketRuntime>;
  readonly defaultMarketId: string;
  readonly adminAddress: string;
  readonly settings: MarketSettingsStore;
  readonly network: { chainId: bigint; name: string; explorerUrl: string };
  private readonly descriptors: Map<string, Descriptor>;
  private arbController?: ArbitrageController;
  private controlQueue: Promise<unknown> = Promise.resolve();
  private server?: Server;
  private stopSync: (() => void)[] = [];
  private stopArbitrage?: () => void;
  private workersStarted = false;
  private closed = false;

  constructor(options: MarketsServerOptions) {
    if (!options.markets.length) throw new Error('At least one market is required');
    const byId = new Map<string, MarketRuntime>(); const descriptors = new Map<string, Descriptor>();
    const vaults = new Set<string>(); const databases = new Set<string>(); const connections = new Set<unknown>();
    const chainId = options.markets[0].config.chainId;
    for (const market of options.markets) {
      if (!ID.test(market.id) || market.id.length > 80 || byId.has(market.id)) throw new Error('Market IDs must be valid and unique');
      if (market.config.chainId !== chainId) throw new Error('All demo markets must use the same chain');
      const vault = getAddress(market.config.vaultAddress);
      if (vaults.has(vault)) throw new Error('A Vault may belong to only one market runtime');
      vaults.add(vault);
      const db = databaseIdentity(market.config.dbPath);
      if ((db && databases.has(db)) || connections.has(market.engine.db)) throw new Error('Each market requires its own SQLite database');
      if (db) databases.add(db); connections.add(market.engine.db);
      if (market.api.engine !== market.engine || market.api.chain !== market.chain || market.chain.engine !== market.engine
        || getAddress(market.engine.config.vaultAddress) !== vault) throw new Error('Market API, chain and engine belong to different runtimes');
      if (market.config.marketId && market.config.marketId !== market.id) throw new Error('Configured market ID differs from its runtime');
      const metadata = tokenMetadata(market.config);
      const base = { ...metadata.RUBA, address: getAddress(market.config.rubaAddress) };
      const quote = { ...metadata.USDT, address: getAddress(market.config.usdtAddress) };
      if (base.address === quote.address || !SYMBOLS.has(base.symbol) || !SYMBOLS.has(quote.symbol)) throw new Error('Market assets must be distinct supported demo tokens');
      byId.set(market.id, market); descriptors.set(market.id, { id: market.id, label: market.label, chainId, vault, base, quote });
    }
    this.defaultMarketId = options.defaultMarketId ?? (byId.has('ruba-usdt') ? 'ruba-usdt' : options.markets[0].id);
    if (!byId.has(this.defaultMarketId)) throw new Error('Default market is not configured');
    const settingsIdentity = databaseIdentity(options.settingsPath);
    if (settingsIdentity && databases.has(settingsIdentity)) throw new Error('The global control database must be separate from market ledgers');
    if (options.network?.chainId !== undefined && BigInt(options.network.chainId) !== chainId) throw new Error('Catalog network differs from market chains');
    this.adminAddress = getAddress(options.adminAddress);
    this.markets = byId; this.descriptors = descriptors;
    this.network = { chainId, name: options.network?.name ?? (chainId === 11155111n ? 'Sepolia' : 'Local Anvil'),
      explorerUrl: options.network?.explorerUrl ?? (chainId === 11155111n ? 'https://sepolia.etherscan.io' : '') };
    const marketsHash = keccak256(toUtf8Bytes(canonicalControlJson([...descriptors.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({ ...entry, chainId: entry.chainId.toString() })))));
    this.settings = new MarketSettingsStore({ path: options.settingsPath, markets: [...byId.keys()],
      binding: { chainId, defaultVault: this.defaultMarket.config.vaultAddress, admin: this.adminAddress, marketsHash } });
    this.arbController = options.arbController;
  }
  private get defaultMarket(): MarketRuntime { return this.markets.get(this.defaultMarketId)!; }
  private market(id: string): MarketRuntime {
    const market = this.markets.get(id); if (!market) throw new MarketHttpError(404, 'Unknown market'); return market;
  }
  getSettings(): MarketSettings { return this.settings.getSettings(); }
  catalog() {
    const settings = this.getSettings();
    return { network: { ...this.network }, defaultMarketId: this.defaultMarketId,
      markets: [...this.descriptors.values()].map((entry) => ({ ...entry, base: { ...entry.base }, quote: { ...entry.quote } })),
      control: { admin: this.adminAddress, domain: marketControlDomain(this.network.chainId, this.defaultMarket.config.vaultAddress),
        types: structuredClone(MARKET_CONTROL_TYPES), nonce: this.settings.getNonce(), revision: settings.revision, prices: settings.prices } };
  }
  private prices(id: string, reserve0: bigint, reserve1: bigint, settings: MarketSettings) {
    const descriptor = this.descriptors.get(id)!;
    const target = targetPrice(settings.prices[descriptor.base.symbol as DemoSymbol], settings.prices[descriptor.quote.symbol as DemoSymbol]);
    if (reserve0 <= 0n || reserve1 <= 0n) return { spot: null, target: formatPrice(target), deviationBps: null };
    const spot = spotPrice(reserve0, reserve1, descriptor.base.decimals, descriptor.quote.decimals);
    return { spot: formatPrice(spot), target: formatPrice(target), deviationBps: deviationBps(spot, target) };
  }
  private historyKey(id: string): string { return `${this.network.chainId}:${this.descriptors.get(id)!.vault}:${id}`; }
  private assertMarketHealthy(market: MarketRuntime): void {
    try { market.chain.assertHealthy(); }
    catch { throw new MarketHttpError(503, 'Market requires reconciliation; its accepted dashboard is unavailable'); }
  }
  private checkedState(market: MarketRuntime, state: ZkState, root: bigint): void {
    const poolHash = hashPool(state.pool);
    if (poolHash !== state.poolHash || root !== state.root || hashState(market.engine.getDomain(), state.accountsRoot, poolHash,
      state.inboxCursor, state.nextTradeId, market.engine.getPoolKeyCommit()) !== root) throw new Error('Accepted pool does not open the confirmed state root');
  }
  private async anchorPoint(market: MarketRuntime, point: { stateVersion: bigint; root: bigint; state: ZkState;
    blockNumber?: number; txHash?: string; publicSignals?: bigint[] }, confirmedNumber: number) {
    if (point.blockNumber === undefined || point.blockNumber > confirmedNumber || !point.txHash || !/^0x[0-9a-fA-F]{64}$/.test(point.txHash)) {
      throw new MarketHttpError(503, 'Accepted checkpoint is waiting for a confirmed publication');
    }
    const header = checkedSignals(await market.chain.zkVault.transitions(point.stateVersion, { blockTag: confirmedNumber }));
    if (header[0] !== market.engine.getDomain() || header[1] !== point.stateVersion || header[4] !== point.root
      || header[6] !== point.state.inboxCursor || header[8] !== point.state.nextTradeId || header[12] !== market.engine.getPoolKeyCommit()
      || (point.publicSignals && !header.every((value, index) => value === point.publicSignals![index]))) {
      throw new MarketHttpError(503, 'Accepted market checkpoint differs from the canonical Vault state');
    }
    const [block, receipt] = await Promise.all([market.chain.provider.getBlock(point.blockNumber), market.chain.provider.getTransactionReceipt(point.txHash)]);
    if (!block?.hash || block.number !== point.blockNumber || !receipt || receipt.status !== 1 || receipt.blockNumber !== block.number
      || receipt.blockHash !== block.hash || !receipt.to || getAddress(receipt.to) !== this.descriptors.get(market.id)!.vault) {
      throw new MarketHttpError(503, 'Accepted publication is no longer canonical; reconcile the market');
    }
    const eventMatches = receipt.logs.some((log) => {
      if (getAddress(log.address) !== this.descriptors.get(market.id)!.vault) return false;
      try {
        const parsed = market.chain.zkAbi.parseLog(log);
        return parsed?.name === 'ZkTransitionPublished' && BigInt(parsed.args.stateVersion) === point.stateVersion
          && checkedSignals(parsed.args.publicSignals).every((value, index) => value === header[index]);
      } catch { return false; }
    });
    if (!eventMatches) throw new MarketHttpError(503, 'Confirmed transaction has no matching ZK transition event');
    return block;
  }
  async dashboard(id: string) {
    const market = this.market(id); const settings = this.getSettings(); const descriptor = this.descriptors.get(id)!;
    this.assertMarketHealthy(market);
    const checkpoint = market.engine.getAcceptedCheckpoint();
    let accepted = null as null | { stateVersion: bigint; root: bigint; blockNumber: bigint; reserve0: bigint; reserve1: bigint;
      spot: string; target: string; deviationBps: bigint;
      history: (Omit<AcceptedHistoryPoint, 'root' | 'blockHash' | 'blockNumber'> & { blockNumber: bigint })[] };
    if (checkpoint.stateVersion > 0n && checkpoint.state.pool[0] > 0n && checkpoint.state.pool[1] > 0n) {
      this.checkedState(market, checkpoint.state, checkpoint.root);
      const confirmed = await market.chain.confirmedBlock();
      const points = market.engine.listTransitions().filter((transition) => transition.status === 'accepted'
        && transition.stateVersion <= checkpoint.stateVersion && transition.endingState.pool[0] > 0n && transition.endingState.pool[1] > 0n).slice(-120);
      const known = new Set(this.settings.getHistory(this.historyKey(id)).map((point) => point.stateVersion.toString()));
      const candidates: { stateVersion: bigint; root: bigint; state: ZkState; blockNumber?: number; txHash?: string; publicSignals?: bigint[] }[] = points.map((transition) => ({ stateVersion: transition.stateVersion, root: transition.newRoot,
        state: transition.endingState, blockNumber: transition.blockNumber, txHash: transition.txHash, publicSignals: transition.publicSignals }));
      if (!candidates.some((point) => point.stateVersion === checkpoint.stateVersion)) candidates.push({ stateVersion: checkpoint.stateVersion,
        root: checkpoint.root, state: checkpoint.state, blockNumber: checkpoint.blockNumber, txHash: checkpoint.txHash, publicSignals: undefined });
      const collected: AcceptedHistoryPoint[] = [];
      for (const point of candidates) {
        if (known.has(point.stateVersion.toString()) && point.stateVersion !== checkpoint.stateVersion) continue;
        this.checkedState(market, point.state, point.root);
        const block = await this.anchorPoint(market, point, confirmed.number);
        const price = this.prices(id, point.state.pool[0], point.state.pool[1], settings);
        collected.push({ stateVersion: point.stateVersion, root: point.root, blockNumber: block.number, blockHash: block.hash!,
          timestamp: BigInt(block.timestamp), spot: price.spot!, target: price.target, deviationBps: price.deviationBps!, referenceSource: 'current-manual' });
      }
      const after = await market.chain.provider.getBlock(confirmed.number);
      this.assertMarketHealthy(market);
      if (after?.hash !== confirmed.hash) throw new MarketHttpError(503, 'Chain changed while reading accepted market history');
      for (const point of collected) this.settings.recordHistory(this.historyKey(id), point);
      const price = this.prices(id, checkpoint.state.pool[0], checkpoint.state.pool[1], settings);
      const history = this.settings.getHistory(this.historyKey(id)).filter((point) => point.stateVersion <= checkpoint.stateVersion)
        .map(({ root: _root, blockHash: _hash, blockNumber, ...point }) => ({ ...point, blockNumber: BigInt(blockNumber) }));
      accepted = { stateVersion: checkpoint.stateVersion, root: checkpoint.root, blockNumber: BigInt(checkpoint.blockNumber!),
        reserve0: checkpoint.state.pool[0], reserve1: checkpoint.state.pool[1], spot: price.spot!, target: price.target,
        deviationBps: price.deviationBps!, history };
    }
    const policy = settings.arbitrage[id];
    const status = this.arbController?.getStatus(id) ?? { status: policy.enabled ? 'idle' : 'disabled', nextRunAt: null };
    const safeStatus: ArbitrageStatus = { status: STATUSES.has(status.status) ? status.status : 'error',
      nextRunAt: typeof status.nextRunAt === 'number' && Number.isSafeInteger(status.nextRunAt) ? status.nextRunAt : null,
      ...(typeof status.error === 'string' ? { error: 'Arbitrage worker failed; retry after synchronization' } : {}),
      ...(typeof status.message === 'string' ? { message: status.message.slice(0, 240) } : {}) };
    return { marketId: id, pair: `${descriptor.base.symbol}/${descriptor.quote.symbol}`, accepted,
      progress: market.engine.getBatchProgress(), referencePrices: settings.prices, settingsRevision: settings.revision,
      arbitrage: { ...policy, ...safeStatus } };
  }
  private monitor(id: string) {
    const market = this.market(id), settings = this.getSettings(), snapshot = market.engine.snapshot();
    this.assertMarketHealthy(market);
    const descriptor = this.descriptors.get(id)!;
    return { marketId: id, pair: `${descriptor.base.symbol}/${descriptor.quote.symbol}`, source: 'private-current', accepted: false,
      stateRoot: market.engine.journal.current().root, reserve0: snapshot.reserves.RUBA, reserve1: snapshot.reserves.USDT,
      ...this.prices(id, snapshot.reserves.RUBA, snapshot.reserves.USDT, settings), progress: market.engine.getBatchProgress(), settingsRevision: settings.revision };
  }
  async control(input: unknown) {
    const run = this.controlQueue.then(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'command,deadline,nonce,signature') throw new MarketHttpError(400, 'Invalid administrator action fields');
      const request = input as ControlRequest;
      const command = validateControlCommand(request.command, [...this.markets.keys()]);
      const nonce = uint(request.nonce, 'nonce'), deadline = uint(request.deadline, 'deadline');
      if (nonce !== this.settings.getNonce()) throw new MarketHttpError(409, 'Invalid control nonce; refresh the catalog before signing');
      const timestamp = await this.defaultMarket.chain.latestTimestamp();
      if (deadline < timestamp || deadline > timestamp + 600n) throw new MarketHttpError(400, 'Administrator action expired or exceeds the 600-second signing window');
      let recovered: string;
      try { recovered = verifyTypedData(marketControlDomain(this.network.chainId, this.defaultMarket.config.vaultAddress), MARKET_CONTROL_TYPES,
        { actionHash: controlActionHash(command), nonce, deadline }, request.signature); }
      catch { throw new MarketHttpError(403, 'Invalid administrator signature'); }
      if (getAddress(recovered) !== this.adminAddress) throw new MarketHttpError(403, 'Unauthorized administrator');
      if (command.kind === 'closeBatch') {
        const market = this.market(command.marketId);
        if (market.config.proofMode !== 'zk') throw new MarketHttpError(400, 'Manual batch closing requires the ZK ledger');
        this.assertMarketHealthy(market);
        const accepted = this.settings.apply(command, nonce);
        // No cross-database transaction is held across sync/proving. The durable
        // nonce prevents replay even if a process stops after accepting the request.
        const result = await market.api.closeBatch();
        return { ...accepted, result: { marketId: command.marketId, ...result } };
      }
      if (command.kind === 'rebuildQueue') {
        const market = this.market(command.marketId);
        if (market.config.proofMode !== 'zk') throw new MarketHttpError(400, 'Queue rebuild requires the ZK ledger');
        this.assertMarketHealthy(market);
        const accepted = this.settings.apply(command, nonce);
        const result = await market.api.rebuildQueue();
        return { ...accepted, result: { marketId: command.marketId, ...result } };
      }
      return this.settings.apply(command, nonce, command.kind === 'monitor' ? () => this.monitor(command.marketId) : undefined);
    });
    this.controlQueue = run.catch(() => undefined); return run;
  }
  setArbitrageController(controller: ArbitrageController): void {
    if (this.arbController || this.workersStarted) throw new Error('Arbitrage controller must be attached once before workers start');
    this.arbController = controller;
  }
  createHttpServer(): Server {
    if (!this.server) {
      this.server = createServer((request, response) => { void this.handle(request, response); });
      this.server.requestTimeout = 10_000; this.server.headersTimeout = 10_000; this.server.maxRequestsPerSocket = 100;
    }
    return this.server;
  }
  startWorkers(): () => void {
    if (this.workersStarted) throw new Error('Market workers are already running');
    this.workersStarted = true;
    this.stopSync = [...this.markets.values()].map((market) => market.api.startWorker());
    this.stopArbitrage = this.arbController?.start();
    return () => this.stopWorkers();
  }
  private stopWorkers(): void {
    for (const stop of this.stopSync.splice(0)) stop();
    this.stopArbitrage?.(); this.stopArbitrage = undefined; this.arbController?.stop(); this.workersStarted = false;
  }
  async start(port = this.defaultMarket.config.port, host = this.defaultMarket.config.host): Promise<Server> {
    const server = this.createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    this.startWorkers(); return server;
  }
  async drain(): Promise<void> {
    await this.controlQueue; await this.arbController?.drain();
    await Promise.all([...this.markets.values()].map((market) => market.api.drain()));
  }
  /** Passed runtimes remain owned by their factory; this closes routing, workers and control DB only. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.stopWorkers();
    if (this.server?.listening) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    await this.drain(); this.settings.close();
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(json(value));
    };
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/markets') { send(200, this.catalog()); return; }
      if (url.pathname === '/admin/action') {
        if (request.method !== 'POST') throw new MarketHttpError(405, 'Use POST for administrator actions');
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new MarketHttpError(415, 'Use application/json');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
          if (size > 32768) throw new MarketHttpError(413, 'Request body exceeds 32 KiB'); chunks.push(buffer); }
        send(200, await this.control(JSON.parse(Buffer.concat(chunks).toString('utf8')))); return;
      }
      if (url.pathname === '/markets' || url.pathname.startsWith('/markets/')) {
        const scoped = /^\/markets\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/.*)?$/.exec(url.pathname);
        if (!scoped) throw new MarketHttpError(404, 'Unknown market');
        const market = this.market(scoped[1]), path = scoped[2] ?? '/';
        if (request.method === 'GET' && path === '/dashboard') { send(200, await this.dashboard(market.id)); return; }
        if (!/^\/(?:config|nonce|actions|publication|disclosure\/batches\/(?:0|[1-9][0-9]*))$/.test(path)) throw new MarketHttpError(404, 'Unknown market route');
        await market.api.handle(request, response, path + url.search); return;
      }
      await this.defaultMarket.api.handle(request, response);
    } catch (error) {
      if (!response.headersSent) {
        const rpcError = error && typeof error === 'object' && ('code' in error || 'info' in error || 'request' in error);
        send(error instanceof MarketHttpError ? error.status : rpcError ? 503 : 400,
          { error: rpcError ? 'Market operation failed; retry after synchronization' : error instanceof Error ? error.message : 'Invalid request' });
      }
    }
  }
}

export { MarketsServer as MarketsApi };
export function createMarketsServer(options: MarketsServerOptions): MarketsServer { return new MarketsServer(options); }
