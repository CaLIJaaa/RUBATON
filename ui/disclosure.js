import { comparePublication, createDemoDisclosure, describeToken, displayFee, displayTokenAmount, inspectDisclosure, inspectDisclosureText, parseDisclosure, selectDisclosureMarket } from './disclosure-model.js';

/** The page has no wallet or authentication dependency. */
export function createDisclosurePage(container, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const document = container.ownerDocument ?? container;
  const byId = container === document
    ? (id) => document.getElementById(id)
    : (id) => container.querySelector(`#${id}`);
  const exchangeLink = byId('disclosure-exchange');
  let current;
  let revision = 0;
  const setNotice = (element, text, error = false) => {
    element.textContent = text;
    element.hidden = false;
    element.className = error ? 'notice error' : 'notice';
  };
  const clearResult = () => {
    revision++;
    current = undefined;
    byId('disclosure-result').hidden = true;
    byId('disclosure-summary').replaceChildren();
    byId('disclosure-proof').replaceChildren();
    byId('disclosure-error').hidden = true;
    byId('disclosure-error').textContent = '';
    byId('disclosure-publication').disabled = true;
    byId('disclosure-pair').textContent = 'Рынок определяется по сети и Vault квитанции';
    if (exchangeLink) exchangeLink.href = '/';
    setNotice(byId('disclosure-chain'), 'Публикация в блокчейне ещё не проверена.');
  };
  function addField(container, label, value) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    container.append(row);
  }
  async function show() {
    clearResult();
    const requestRevision = revision;
    try {
      const text = byId('disclosure-json').value;
      const parsed = parseDisclosure(text);
      const inspection = parsed.version === 2 ? await inspectDisclosureText(text) : inspectDisclosure(parsed);
      if (revision !== requestRevision) return;
      current = inspection;
      const { bundle } = inspection;
      const { receipt, batch } = bundle;
      const summary = byId('disclosure-summary');
      const inputToken = describeToken(bundle, receipt.tokenIn);
      const outputToken = describeToken(bundle, receipt.tokenOut);
      byId('disclosure-pair').textContent = bundle.tokens ? `${bundle.tokens.RUBA.symbol} / ${bundle.tokens.USDT.symbol}` : 'Названия токенов не переданы';
      for (const [label, value] of [
        ['Схема', bundle.version === 2 ? 'v2 · Poseidon · упорядоченное дерево' : 'v1 · Keccak · сортированные пары'],
        ['Сделка', receipt.tradeId.toString()], ['Пакет', `${batch.batchId} · сделок в пакете: ${batch.tradeCount}`],
        ['Владелец', receipt.account], ['Направление', `${inputToken.symbol} → ${outputToken.symbol}`],
        ['Отдал', displayTokenAmount(bundle, receipt.tokenIn, receipt.amountIn)],
        ['Получил', displayTokenAmount(bundle, receipt.tokenOut, receipt.amountOut)], ['Комиссия', displayFee(bundle)],
        ['Сеть · Chain ID', receipt.chainId.toString()], ['Контракт Vault', receipt.vault],
        ['Дата сделки', 'Не записана в квитанции'],
      ]) addField(summary, label, value);
      if (bundle.tokens) {
        addField(summary, 'Резервы AMM до сделки', `${displayTokenAmount(bundle, bundle.tokens.RUBA.address, receipt.reserveRubaBefore)} · ${displayTokenAmount(bundle, bundle.tokens.USDT.address, receipt.reserveUsdtBefore)}`);
        addField(summary, 'Резервы AMM после сделки', `${displayTokenAmount(bundle, bundle.tokens.RUBA.address, receipt.reserveRubaAfter)} · ${displayTokenAmount(bundle, bundle.tokens.USDT.address, receipt.reserveUsdtAfter)}`);
      }
      const details = byId('disclosure-proof');
      for (const [label, value] of [
        ['Хеш квитанции', receipt.leaf], ['Пересчитанный хеш', inspection.calculatedLeaf],
        ['Корень квитанций', batch.receiptsRoot], ['Предыдущее состояние', batch.previousStateRoot],
        ['Новое состояние', batch.newStateRoot], ['Соль', receipt.salt],
        ['Merkle proof', receipt.proof.length ? receipt.proof.join('\n') : 'Пустой: единственная квитанция является корнем пакета'],
        ['Хеш публикации из файла', batch.publishedTxHash ?? 'Не указан'],
      ]) addField(details, label, value);
      byId('disclosure-demo-notice').hidden = !bundle.demo;
      byId('disclosure-token-notice').textContent = bundle.tokens
        ? 'Названия токенов и количество знаков после запятой взяты из файла. Они будут сверены с настроенным Vault при проверке публикации.'
        : 'Метаданные токенов не переданы: суммы показаны в минимальных единицах, без определения символа и точности.';
      byId('disclosure-result').hidden = false;
      byId('disclosure-publication').disabled = !inspection.valid || bundle.demo;
      setNotice(byId('disclosure-local'), inspection.valid
        ? 'Локальная проверка пройдена: содержимое квитанции, её хеш и Merkle proof совпадают с загруженным корнем.'
        : 'Локальная проверка не пройдена: квитанция изменена либо Merkle proof не соответствует корню.', !inspection.valid);
      setNotice(byId('disclosure-chain'), bundle.demo ? 'Демопример не опубликован в блокчейне.' : 'Публикация в блокчейне ещё не проверена.');
      setNotice(byId('disclosure-status'), bundle.demo ? 'Загружен демонстрационный пример.' : 'Квитанция раскрыта локально в вашем браузере.');
    } catch (error) {
      if (revision !== requestRevision) return;
      setNotice(byId('disclosure-error'), error.message, true);
      setNotice(byId('disclosure-status'), 'Не удалось раскрыть квитанцию.');
    }
  }
  byId('disclosure-form').addEventListener('submit', (event) => { event.preventDefault(); return show(); });
  byId('disclosure-demo').addEventListener('click', () => {
    byId('disclosure-json').value = JSON.stringify(createDemoDisclosure(), null, 2);
    byId('disclosure-file').value = '';
    show();
  });
  byId('disclosure-clear').addEventListener('click', () => {
    clearResult();
    byId('disclosure-json').value = '';
    byId('disclosure-file').value = '';
    setNotice(byId('disclosure-status'), 'Загрузите квитанцию или откройте демопример.');
  });
  byId('disclosure-json').addEventListener('input', () => {
    clearResult();
    setNotice(byId('disclosure-status'), 'Данные изменены. Нажмите «Показать и проверить».');
  });
  byId('disclosure-file').addEventListener('change', async () => {
    clearResult();
    const requestRevision = revision;
    const file = byId('disclosure-file').files?.[0];
    if (!file) return;
    try {
      if (file.size > 262_144) throw new Error('Размер JSON не должен превышать 256 КиБ.');
      const text = await file.text();
      if (revision !== requestRevision) return;
      byId('disclosure-json').value = text;
      await show();
    } catch (error) {
      if (revision === requestRevision) setNotice(byId('disclosure-error'), error.message, true);
    }
  });
  byId('disclosure-publication').addEventListener('click', async () => {
    if (!current?.valid || current.bundle.demo) return;
    const inspection = current;
    const requestRevision = revision;
    byId('disclosure-publication').disabled = true;
    setNotice(byId('disclosure-chain'), 'Проверяю публичный пакет в подключённом Vault…');
    try {
      const options = { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) };
      const catalogResponse = await fetchImpl('/markets', options);
      if (revision !== requestRevision) return;
      let prefix = '';
      if (catalogResponse.status !== 404) {
        const catalog = await catalogResponse.json();
        if (revision !== requestRevision) return;
        if (!catalogResponse.ok) throw new Error(catalog.error ?? 'Не удалось получить каталог рынков.');
        const market = selectDisclosureMarket(inspection.bundle, catalog);
        prefix = `/markets/${market.id}`;
        const tokens = inspection.bundle.tokens;
        byId('disclosure-pair').textContent = `${tokens ? `${tokens.RUBA.symbol} / ${tokens.USDT.symbol}` : 'Рынок'} · ${market.label ?? market.id}`;
        if (exchangeLink) exchangeLink.href = `/?market=${encodeURIComponent(market.id)}`;
      }
      const response = await fetchImpl(`${prefix}/disclosure/batches/${inspection.bundle.batch.batchId}`, { ...options, signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (revision !== requestRevision) return;
      if (!response.ok) throw new Error(body.error ?? 'Не удалось получить данные публикации.');
      const publication = comparePublication(inspection.bundle, body);
      const text = publication.published
        ? 'Публикация подтверждена: корни и параметры пакета совпадают с данными контракта Vault.'
        : publication.status === 'published'
          ? 'Сервер сообщает о публикации, но сверка с контрактом не подтверждена.'
          : 'Пакет ещё не опубликован в контракте. Локальная проверка не подтверждает публикацию.';
      setNotice(byId('disclosure-chain'), text);
      if (publication.published && publication.tokensVerified) {
        byId('disclosure-token-notice').textContent = 'Адреса, названия и точность токенов сверены с соответствующим Vault.';
      }
    } catch (error) {
      const detail = error.name === 'TimeoutError' ? 'Сервер или RPC не ответил вовремя. Повторите сверку через несколько секунд.'
        : /Failed to fetch|fetch failed/i.test(error.message) ? 'Не удалось связаться с сервером. Проверьте подключение и повторите.' : error.message;
      if (revision === requestRevision) setNotice(byId('disclosure-chain'), `Публикация не подтверждена: ${detail}`, true);
    } finally {
      if (revision === requestRevision) byId('disclosure-publication').disabled = false;
    }
  });
  clearResult();
  return { show };
}

export async function loadEmbeddedDisclosure(container, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl('/disclosure', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Не удалось загрузить раскрытие сделки.');

  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  const source = page.querySelector('main[data-disclosure-content]');
  if (!source) throw new Error('Не удалось найти форму раскрытия сделки.');

  const document = container.ownerDocument;
  const content = document.createElement('div');
  content.append(...Array.from(source.children, (child) => document.importNode(child, true)));
  createDisclosurePage(content, fetchImpl);
  container.replaceChildren(content);
}

if (typeof document !== 'undefined' && document.body.classList.contains('disclosure-app')) {
  createDisclosurePage(document);
}
