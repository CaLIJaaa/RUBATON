import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { acquireTenderlyLock, prepareTenderly } from '../scripts/tenderly.ts';
import { parseTenderlySettings } from '../scripts/tenderly-config.ts';
import type { TenderlySettings } from '../scripts/tenderly-config.ts';
import type { ServerConfig } from './config.ts';
import { getStaticResponse } from './static.ts';
import { json } from './api.ts';

interface SetupInput {
  rpcUrl: string;
  publicRpcUrl?: string;
  testWalletAddress: string;
  seedRuba?: string;
  seedUsdt?: string;
  walletRuba?: string;
  walletUsdt?: string;
  walletEth?: string;
}

export interface SetupMarket {
  config: Pick<ServerConfig, 'chainId' | 'vaultAddress' | 'rubaAddress' | 'usdtAddress'>;
  api: {
    createHttpServer(): Server;
    publicConfig(): Record<string, unknown>;
    startWorker(): () => void;
    drain(): Promise<void>;
  };
  close(): void;
}

export interface TenderlySetupOptions {
  port: number;
  root?: string;
  prepare?: (settings: TenderlySettings, log: (line: string) => void) => Promise<SetupMarket>;
  acquireLock?: (directory: string) => Promise<() => Promise<void>>;
  readSaved?: () => Promise<unknown>;
  writeSaved?: (input: SetupInput) => Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const fields = new Set(['rpcUrl', 'publicRpcUrl', 'testWalletAddress', 'seedRuba', 'seedUsdt', 'walletRuba', 'walletUsdt', 'walletEth']);

function validateInput(value: unknown): SetupInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Нужен объект настроек.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.has(key))) throw new HttpError(400, 'Неизвестное поле настроек.');
  if (typeof input.rpcUrl !== 'string' || typeof input.testWalletAddress !== 'string') {
    throw new HttpError(400, 'Заполните Admin RPC и адрес кошелька.');
  }
  for (const [key, field] of Object.entries(input)) {
    if (typeof field !== 'string' || field.length > 2_048) throw new HttpError(400, `Некорректное поле ${key}.`);
  }
  return input as unknown as SetupInput;
}

/** Keep endpoint credentials and signing material out of status responses. */
function publicMessage(value: unknown): string {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[RPC скрыт]')
    .replace(/\b(?:0x)?[a-f0-9]{64}\b/gi, '[секрет скрыт]')
    .slice(0, 1_000);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'Используйте application/json.');
  if (Number(request.headers['content-length'] ?? 0) > 16_384) throw new HttpError(413, 'Настройки слишком велики.');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > 16_384) throw new HttpError(413, 'Настройки слишком велики.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Некорректный JSON настроек.'); }
}

export function createTenderlySetupServer(options: TenderlySetupOptions) {
  const root = options.root ?? process.cwd();
  const savedPath = join(root, 'data', 'tenderly-ui.json');
  const prepare = options.prepare ?? prepareTenderly;
  const acquireLock = options.acquireLock ?? acquireTenderlyLock;
  const token = randomBytes(32).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const logs: string[] = [];
  let phase: 'idle' | 'running' | 'ready' | 'error' = 'idle';
  let error: string | undefined;
  let active: {
    market: SetupMarket;
    delegate: Server;
    stopWorker: () => void;
    release: () => Promise<void>;
    settings: TenderlySettings;
    inflight: Set<Promise<void>>;
  } | undefined;
  let closing = false;
  let job: Promise<void> | undefined;
  let savedInput: SetupInput | undefined;
  const busy = () => phase === 'running' || closing;

  const readSaved = options.readSaved ?? (async () => {
    try { return JSON.parse(await readFile(savedPath, 'utf8')); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || cause instanceof SyntaxError) return;
      throw cause;
    }
  });
  const savedLoaded = readSaved().then((value) => {
    if (value === undefined) return;
    try { savedInput = validateInput(value); } catch { /* A malformed saved file is not a runnable setup. */ }
  }).catch(() => { /* The UI remains available even when an old settings file cannot be read. */ });
  const writeSaved = options.writeSaved ?? (async (input: SetupInput) => {
    await mkdir(dirname(savedPath), { recursive: true, mode: 0o700 });
    const temporary = `${savedPath}.tmp`;
    await writeFile(temporary, JSON.stringify(input) + '\n', { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, savedPath);
  });

  function append(line: string) {
    logs.push(publicMessage(line));
    if (logs.length > 100) logs.splice(0, logs.length - 100);
  }
  function settingsFor(input: SetupInput): TenderlySettings {
    return parseTenderlySettings(input.rpcUrl, {
      TEST_WALLET_ADDRESS: input.testWalletAddress,
      TENDERLY_PUBLIC_RPC_URL: input.publicRpcUrl,
      TENDERLY_SEED_RUBA: input.seedRuba,
      TENDERLY_SEED_USDT: input.seedUsdt,
      TENDERLY_WALLET_RUBA: input.walletRuba,
      TENDERLY_WALLET_USDT: input.walletUsdt,
      TENDERLY_WALLET_ETH: input.walletEth,
      PORT: String(options.port),
    }, root);
  }
  function status() {
    return {
      phase, logs: [...logs], ...(error ? { error } : {}), csrfToken: token, canResume: Boolean(savedInput),
      ...(active ? { active: {
        chainId: active.market.config.chainId.toString(),
        vaultAddress: active.market.config.vaultAddress,
        rubaAddress: active.market.config.rubaAddress,
        usdtAddress: active.market.config.usdtAddress,
        testWalletAddress: active.settings.testWalletAddress,
        ...(active.settings.publicRpcUrl ? { publicRpcUrl: active.settings.publicRpcUrl } : {}),
      } } : {}),
    };
  }
  async function stopActive() {
    const previous = active;
    active = undefined;
    if (!previous) return;
    previous.stopWorker();
    try {
      await Promise.all(previous.inflight);
      await previous.market.api.drain();
    }
    finally {
      try { previous.market.close(); }
      finally { await previous.release(); }
    }
  }
  async function runSetup(input: SetupInput, settings: TenderlySettings) {
    let release: (() => Promise<void>) | undefined;
    let market: SetupMarket | undefined;
    try {
      await stopActive();
      append('Проверка форка и подготовка контрактов…');
      release = await acquireLock(settings.stateDirectory);
      market = await prepare(settings, append);
      if (closing) { append('Настройка завершена; интерфейс останавливается.'); return; }
      await writeSaved(input);
      savedInput = input;
      active = { market, delegate: market.api.createHttpServer(), stopWorker: market.api.startWorker(), release, settings, inflight: new Set() };
      market = undefined;
      release = undefined;
      phase = 'ready';
      append('Готово. Можно открыть обмен и подключить кошелёк.');
    } catch (cause) {
      phase = 'error';
      error = publicMessage(cause instanceof Error ? cause.message : 'Не удалось подготовить Tenderly.');
      append(error);
    } finally {
      try { market?.close(); await release?.(); }
      catch { phase = 'error'; error = 'Не удалось завершить предыдущую настройку. Перезапустите интерфейс.'; append(error); }
    }
  }
  function authorize(request: IncomingMessage) {
    if (request.headers.origin !== `http://${request.headers.host}`) throw new HttpError(403, 'Настройка доступна только с этой страницы.');
    const supplied = request.headers['x-ruba-setup-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new HttpError(403, 'Обновите страницу настройки.');
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (code: number, value: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(json(value));
    };
    try {
      if (!allowedHosts.has(request.headers.host ?? '')) throw new HttpError(403, 'Нужен локальный адрес интерфейса.');
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/setup/status') {
        if (request.method !== 'GET') throw new HttpError(405, 'Используйте GET.');
        await savedLoaded;
        send(200, status());
        return;
      }
      if (pathname === '/setup/start' || pathname === '/setup/resume') {
        if (request.method !== 'POST') throw new HttpError(405, 'Используйте POST.');
        authorize(request);
        if (busy()) throw new HttpError(409, 'Настройка уже выполняется. Дождитесь завершения.');
        const body = await readBody(request);
        await savedLoaded;
        let input: SetupInput;
        if (pathname === '/setup/resume') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HttpError(400, 'Для продолжения не нужны новые поля.');
          if (!savedInput) throw new HttpError(400, 'Сохранённого форка нет. Заполните форму.');
          input = savedInput;
        } else input = validateInput(body);
        let settings: TenderlySettings;
        try { settings = settingsFor(input); }
        catch (cause) { throw new HttpError(400, publicMessage((cause as Error).message)); }
        // Two requests can arrive while both bodies are still being read.
        if (busy()) throw new HttpError(409, 'Настройка уже выполняется. Дождитесь завершения.');
        phase = 'running';
        error = undefined;
        logs.length = 0;
        send(202, { phase });
        job = runSetup(input, settings);
        return;
      }
      if (pathname.startsWith('/setup/')) throw new HttpError(404, 'Страница не найдена.');
      if (!active && (pathname === '/' || pathname === '/index.html')) {
        response.writeHead(302, { location: '/setup', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const asset = await getStaticResponse(pathname, request.method ?? 'GET');
      if (asset) {
        response.writeHead(asset.status, asset.headers);
        response.end(asset.body);
        return;
      }
      if (active && pathname === '/config' && request.method === 'GET') {
        send(200, { ...active.market.api.publicConfig(), setupAvailable: true });
        return;
      }
      if (active) {
        const current = active;
        let resolve!: () => void;
        const finished = new Promise<void>((done) => { resolve = done; });
        const finish = () => { current.inflight.delete(finished); resolve(); };
        current.inflight.add(finished);
        response.once('finish', finish);
        response.once('close', finish);
        current.delegate.emit('request', request, response);
        return;
      }
      throw new HttpError(503, 'Сначала подготовьте Tenderly на странице /setup.');
    } catch (cause) {
      send(cause instanceof HttpError ? cause.status : 500,
        { error: cause instanceof HttpError ? cause.message : 'Не удалось обработать запрос настройки.' });
    }
  }
  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  let closePromise: Promise<void> | undefined;
  return {
    server, handle, status,
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true;
        await job;
        await stopActive();
        if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
      })();
    },
  };
}
