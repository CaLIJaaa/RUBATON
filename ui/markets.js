import { getAddress, keccak256, toUtf8Bytes } from 'ethers';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/;
const CONTROL_TYPES = { ControlAction: [{ name: 'actionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
let controlQueue = Promise.resolve();

/** Settings have a bounded integer delay; economic requests keep their stricter serializer. */
export function canonicalControlJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalControlJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalControlJson(value[key])}`).join(',')}}`;
  throw new Error('Некорректное значение подписанной команды.');
}

async function json(fetchImpl, path, init = {}, timeoutMs = 20_000) {
  let response;
  try { response = await fetchImpl(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { if (init.method === 'POST') throw Object.assign(new Error('Ответ на команду неизвестен. Обновите настройки перед повторением.'), { uncertain: true }); throw error; }
  let body;
  try { body = await response.json(); }
  catch { throw Object.assign(new Error('Некорректный ответ сервера рынков.'), { uncertain: init.method === 'POST' }); }
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Не удалось загрузить рынок.'), { status: response.status, uncertain: init.method === 'POST' && response.status >= 500 });
  return body;
}

function uint(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) throw new Error('Некорректный номер настройки.');
  return BigInt(value);
}

function asset(value) {
  if (!value || !SYMBOL.test(value.symbol) || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 18) throw new Error('Некорректные метаданные актива.');
  return { symbol: value.symbol, decimals: value.decimals, address: getAddress(value.address) };
}

export async function loadMarkets(fetchImpl = globalThis.fetch.bind(globalThis)) {
  let catalog;
  try { catalog = await json(fetchImpl, '/markets'); }
  catch (error) { if (error.status === 404) return null; throw error; }
  if (!catalog || !Array.isArray(catalog.markets) || !catalog.markets.length || !catalog.network || !ID.test(catalog.defaultMarketId)) throw new Error('Некорректный каталог рынков.');
  const chainId = uint(String(catalog.network.chainId));
  if (!chainId) throw new Error('Неизвестная сеть рынков.');
  const ids = new Set(); const vaults = new Set();
  const markets = catalog.markets.map((market) => {
    if (!ID.test(market.id) || ids.has(market.id) || BigInt(market.chainId) !== chainId) throw new Error('Некорректный идентификатор или сеть рынка.');
    const vault = getAddress(market.vault); const base = asset(market.base); const quote = asset(market.quote);
    if (vaults.has(vault) || base.address === quote.address) throw new Error('У каждого рынка должен быть отдельный Vault и разные токены.');
    ids.add(market.id); vaults.add(vault);
    return { ...market, vault, base, quote };
  });
  if (!ids.has(catalog.defaultMarketId) || !catalog.control) throw new Error('В каталоге отсутствует основной рынок или управление.');
  getAddress(catalog.control.admin); uint(catalog.control.nonce); uint(catalog.control.revision);
  return { ...catalog, markets };
}

export function scopedMarketFetch(marketId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (!ID.test(marketId)) throw new Error('Некорректный рынок.');
  return (path, init) => {
    if (typeof path !== 'string' || !/^\/(?:config|nonce(?:\?[^#]*)?|actions|publication|dashboard|disclosure\/batches\/[1-9][0-9]*)$/.test(path)) throw new Error('Запрос выходит за границы выбранного рынка.');
    return fetchImpl(`/markets/${marketId}${path}`, init);
  };
}

export async function loadDashboard(marketId, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const body = await json(scopedMarketFetch(marketId, fetchImpl), '/dashboard');
  if (body?.marketId !== marketId || !body.progress || !Number.isInteger(body.progress.collected) || body.progress.required !== 4) throw new Error('Получено состояние другого рынка.');
  if (body.accepted !== null) {
    if (!body.accepted || !Array.isArray(body.accepted.history) || body.accepted.history.length > 120) throw new Error('Некорректная история принятых состояний.');
    uint(body.accepted.stateVersion);
    for (const item of [body.accepted, ...body.accepted.history]) { price(item.spot); price(item.target); if (!/^-?(0|[1-9][0-9]*)$/.test(String(item.deviationBps))) throw new Error('Некорректное отклонение цены.'); }
  }
  return body;
}

export function price(value) {
  if (typeof value !== 'string' || value.length > 96 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) throw new Error('Введите положительную цену с точностью до 18 знаков.');
  const [whole, fraction = ''] = value.split('.');
  const fixed = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (fixed <= 0n) throw new Error('Цена должна быть больше нуля.');
  return fixed;
}

function decimal(value, decimals = 18) {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (value / scale).toString() + (fraction ? `.${fraction}` : '');
}

export function poolSpot(reserve0, reserve1, decimals0, decimals1) {
  const r0 = BigInt(reserve0), r1 = BigInt(reserve1);
  if (r0 <= 0n || r1 <= 0n) return null;
  if (![decimals0, decimals1].every((value) => Number.isInteger(value) && value >= 0 && value <= 18)) throw new Error('Некорректная точность рынка.');
  return decimal(r1 * 10n ** BigInt(decimals0 + 18) / (r0 * 10n ** BigInt(decimals1)));
}

/** Number is used only for bounded SVG coordinates, never monetary calculations. */
export function chartPoints(history, extraValues = []) {
  const series = history.slice(-120);
  const values = [...series.flatMap((item) => [price(item.spot), price(item.target)]), ...extraValues.map(price)];
  if (!values.length) return { spot: '', target: '', y: () => 0 };
  let low = values.reduce((a, b) => a < b ? a : b), high = values.reduce((a, b) => a > b ? a : b);
  if (low === high) { const padding = low / 100n || 1n; low = low > padding ? low - padding : 0n; high += padding; }
  const y = (text) => 172 - Number((price(text) - low) * 144_000n / (high - low)) / 1000;
  const line = (field) => series.map((item, i) => `${28 + (series.length < 2 ? 272 : i * 544 / (series.length - 1))},${y(item[field])}`).join(' ');
  return { spot: line('spot'), target: line('target'), y };
}

const MOSCOW = 'Europe/Moscow';
const DATE_LIMIT_SECONDS = 8_640_000_000_000;
const DAY_SECONDS = 86_400;
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
  DAY_SECONDS, 2 * DAY_SECONDS, 7 * DAY_SECONDS, 14 * DAY_SECONDS, 30 * DAY_SECONDS, 90 * DAY_SECONDS, 180 * DAY_SECONDS];
const chartDate = new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, day: '2-digit', month: '2-digit', year: 'numeric' });
const chartDay = new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, day: '2-digit', month: '2-digit' });
const chartMinute = new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const chartSecond = new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const chartOffset = new Intl.DateTimeFormat('en', { timeZone: MOSCOW, timeZoneName: 'longOffset' });

function chartTimestamp(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,12})$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 && value <= DATE_LIMIT_SECONDS ? value : null;
}

export function formatChartTimestamp(value) {
  const timestamp = chartTimestamp(value);
  if (timestamp === null) return '—';
  const date = new Date(timestamp * 1000);
  return `${chartDate.format(date)}, ${chartSecond.format(date)} МСК`;
}

export function compactChartPrice(value) {
  const exact = price(value);
  const placesToRound = Math.max(0, exact.toString().length - 6);
  const step = 10n ** BigInt(placesToRound);
  const rounded = (exact + step / 2n) / step * step;
  return `${rounded === exact ? '' : '≈ '}${decimal(rounded).replace('.', ',')}`;
}

function moscowOffset(timestamp) {
  const date = new Date(timestamp * 1000);
  const zone = chartOffset.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? '';
  const parts = /^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/.exec(zone);
  if (!parts) return 0;
  const seconds = Number(parts[2]) * 3600 + Number(parts[3]) * 60 + Number(parts[4] ?? 0);
  return parts[1] === '+' ? seconds : -seconds;
}

function chartTimeTicks(start, end, count, x) {
  const desiredStep = (end - start) / (count - 1);
  const year = 365 * DAY_SECONDS;
  const upperIndex = TIME_STEPS.findIndex((value) => value >= desiredStep);
  const upper = TIME_STEPS[upperIndex] ?? Math.ceil(desiredStep / year) * year;
  const lower = upperIndex > 0 ? TIME_STEPS[upperIndex - 1] : upper;
  const step = desiredStep - lower < upper - desiredStep ? lower : upper;
  const offset = moscowOffset(start);
  const firstTick = Math.ceil((start + offset) / step) * step - offset;
  const crossesDay = chartDate.format(start * 1000) !== chartDate.format(end * 1000);
  const timeFormat = step < 60 ? chartSecond : chartMinute;
  const ticks = [];
  for (let timestamp = firstTick; timestamp <= end; timestamp += step) {
    const date = timestamp * 1000;
    const label = step >= DAY_SECONDS ? chartDate.format(date)
      : crossesDay ? `${chartDay.format(date)} ${timeFormat.format(date)}` : timeFormat.format(date);
    ticks.push({ timestamp, label, x: x(timestamp) });
  }
  return ticks;
}

function orderedChartHistory(history) {
  const stateVersion = (item) => {
    const value = String(item.stateVersion ?? '');
    return /^(0|[1-9][0-9]{0,77})$/.test(value) ? BigInt(value) : null;
  };
  return history.slice(-120).flatMap((item) => {
    const timestamp = chartTimestamp(item?.timestamp);
    return timestamp === null ? [] : [{ item, timestamp, version: stateVersion(item) }];
  }).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.version === b.version) return 0;
    return b.version === null || (a.version !== null && a.version < b.version) ? -1 : 1;
  });
}

function chartPriceBounds(values, tickCount) {
  const min = values.reduce((a, b) => a < b ? a : b);
  const max = values.reduce((a, b) => a > b ? a : b);
  const padding = (min === max ? min / 100n : (max - min) / 20n) || 1n;
  const paddedLow = min > padding ? min - padding : 0n;
  const paddedHigh = max + padding;
  const intervals = BigInt(tickCount - 1);
  const ideal = (paddedHigh - paddedLow + intervals - 1n) / intervals;
  const magnitude = 10n ** BigInt(ideal.toString().length - 1);
  const step = [1n, 2n, 5n, 10n].map((factor) => factor * magnitude).find((size) => size >= ideal);
  const low = paddedLow / step * step;
  const high = (paddedHigh + step - 1n) / step * step;
  return { low, high, step };
}

function stepPath(points, ordinate) {
  if (points.length === 0) return '';
  const svgNumber = (value) => Number(value.toFixed(3));
  const [first, ...remaining] = points;
  return `M ${svgNumber(first.x)} ${svgNumber(first[ordinate])}${remaining.map((point) =>
    ` H ${svgNumber(point.x)} V ${svgNumber(point[ordinate])}`).join('')}`;
}

/** Plot confirmed block times; prices stay in fixed-point units up to projection. */
export function timeChartScale(history, { left = 88, right = 730, top = 20, bottom = 225, extraValues = [], tickCount = 5, windowSeconds = Infinity } = {}) {
  const ordered = orderedChartHistory(history);
  const threshold = ordered.at(-1)?.timestamp - windowSeconds;
  const timeline = Number.isFinite(threshold) ? ordered.filter(({ timestamp }) => timestamp >= threshold) : ordered;
  if (!timeline.length) return {
    points: [], timeTicks: [], priceTicks: [], spotPath: '', targetPath: '',
    x: () => (left + right) / 2, y: () => (top + bottom) / 2, timeFromX: () => null,
  };
  const count = Number.isInteger(tickCount) ? Math.min(8, Math.max(2, tickCount)) : 5;
  const first = timeline[0].timestamp;
  const last = timeline.at(-1).timestamp;
  const margin = first === last ? 60 : Math.max(1, Math.ceil((last - first) * 0.04));
  const start = Math.max(0, first - margin);
  const end = Math.min(DATE_LIMIT_SECONDS, last + margin);
  const x = (time) => {
    const timestamp = chartTimestamp(time);
    return timestamp === null ? (left + right) / 2 : left + (timestamp - start) / (end - start) * (right - left);
  };
  const timeFromX = (coordinate) => {
    const position = Math.max(0, Math.min(1, (coordinate - left) / (right - left)));
    return start + position * (end - start);
  };
  const values = [...timeline.flatMap(({ item }) => [price(item.spot), price(item.target)]), ...extraValues.map(price)];
  const { low, high, step } = chartPriceBounds(values, count);
  const project = (value) => bottom - Number((value - low) * 1_000_000n / (high - low)) / 1_000_000 * (bottom - top);
  const y = (value) => project(price(value));
  const priceTicks = [];
  for (let level = low; level <= high; level += step) {
    const value = decimal(level);
    priceTicks.push({ value, label: value.replace('.', ','), y: project(level) });
  }
  const points = timeline.map(({ item, timestamp }) => ({ ...item, timestamp, x: x(timestamp), spotY: y(item.spot), targetY: y(item.target) }));
  return { points, timeTicks: chartTimeTicks(start, end, count, x), priceTicks, x, y, timeFromX,
    spotPath: stepPath(points, 'spotY'), targetPath: stepPath(points, 'targetY') };
}

function validateCommand(command, catalog) {
  if (!command || typeof command !== 'object') throw new Error('Некорректная команда управления.');
  if (command.kind === 'prices') {
    if (Object.keys(command).sort().join(',') !== 'kind,prices' || Object.keys(command.prices ?? {}).sort().join(',') !== 'RUBA,USDT,WBTC,WETH') throw new Error('Укажите цены всех четырёх тестовых активов.');
    for (const symbol of ['RUBA', 'USDT', 'WETH', 'WBTC']) price(command.prices[symbol]);
    if (command.prices.USDT !== '1') throw new Error('Цена USDT зафиксирована: 1.');
    return;
  }
  if (!catalog.markets.some((market) => market.id === command.marketId)) throw new Error('Неизвестный рынок команды.');
  if (['monitor', 'closeBatch', 'rebuildQueue'].includes(command.kind) && Object.keys(command).sort().join(',') === 'kind,marketId') return;
  if (command.kind === 'arbitrage' && Object.keys(command).sort().join(',') === 'delaySeconds,enabled,kind,marketId'
    && typeof command.enabled === 'boolean' && Number.isInteger(command.delaySeconds) && command.delaySeconds >= 5 && command.delaySeconds <= 3600) return;
  throw new Error('Некорректные настройки арбитража.');
}

export function sendControl({ provider, signer, command: rawCommand, fetchImpl = globalThis.fetch.bind(globalThis), isCurrent = () => true, onWalletStep = () => {} }) {
  const command = structuredClone(rawCommand);
  if (command?.kind === 'prices' && command.prices) {
    for (const key of Object.keys(command.prices)) command.prices[key] = decimal(price(command.prices[key]));
  }
  const job = controlQueue.then(async () => {
    const catalog = await loadMarkets(fetchImpl);
    if (!catalog) throw new Error('Управление доступно только для каталога рынков.');
    validateCommand(command, catalog);
    const owner = getAddress(await signer.getAddress());
    const defaultMarket = catalog.markets.find((market) => market.id === catalog.defaultMarketId);
    const domain = { name: 'RubaMarketControl', version: '1', chainId: BigInt(catalog.network.chainId), verifyingContract: defaultMarket.vault };
    if (getAddress(catalog.control.admin) !== owner || catalog.control.domain?.name !== domain.name || catalog.control.domain?.version !== '1'
      || BigInt(catalog.control.domain?.chainId) !== domain.chainId || getAddress(catalog.control.domain?.verifyingContract) !== domain.verifyingContract) throw new Error('Кошелёк не является администратором этого каталога.');
    const check = async () => {
      if (!isCurrent()) throw new Error('Выбранный рынок изменился. Команда не отправлена.');
      const [chainId, accounts] = await Promise.all([provider.send('eth_chainId', []), provider.send('eth_accounts', [])]);
      if (BigInt(chainId) !== domain.chainId || getAddress(accounts[0]) !== owner) throw new Error('Кошелёк или сеть изменились перед командой управления.');
      if (!isCurrent()) throw new Error('Выбранный рынок изменился. Команда не отправлена.');
    };
    await check();
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('Не удалось прочитать время сети.');
    const nonce = catalog.control.nonce, deadline = (BigInt(block.timestamp) + 600n).toString();
    const value = { actionHash: keccak256(toUtf8Bytes(canonicalControlJson(command))), nonce, deadline };
    const title = {
      prices: 'Подписать новые ориентиры цен',
      arbitrage: `Подписать настройки бота: ${command.enabled ? 'включить' : 'выключить'}, задержка ${command.delaySeconds} с`,
      monitor: 'Разрешить чтение состояния пула',
      closeBatch: 'Подписать закрытие текущего пакета',
      rebuildQueue: 'Подписать пересборку очереди',
    }[command.kind];
    const step = { id: Symbol(), key: `sign:demo-${command.kind}`, kind: 'signature', title };
    const report = (phase) => {
      try { onWalletStep({ ...step, phase }); }
      catch { /* Step display cannot interrupt wallet authorization. */ }
    };
    report('start');
    let signature;
    try {
      signature = await signer.signTypedData(domain, CONTROL_TYPES, value);
      report('done');
    } catch (error) {
      report('error');
      throw error;
    }
    await check();
    return json(fetchImpl, '/admin/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, nonce, deadline, signature }) }, ['closeBatch', 'rebuildQueue'].includes(command.kind) ? 120_000 : 20_000);
  });
  controlQueue = job.catch(() => undefined);
  return job;
}
