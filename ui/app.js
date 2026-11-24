import { BrowserProvider, ZeroAddress, getAddress } from 'ethers';
import { createWalletConnector } from './wallet-connector.js';
import { RubaClient, loadConfig } from './client.js';
import { parseAmount, formatAmount, parseSlippage, minimumOutput, errorMessage } from './model.js';
import { loadMarkets, scopedMarketFetch, loadDashboard, sendControl, poolSpot, timeChartScale, formatChartTimestamp, compactChartPrice } from './markets.js';
import { loadEmbeddedDisclosure } from './disclosure.js';

const element = (id) => document.getElementById(id);
const state = {
  config: null,
  provider: null,
  signer: null,
  client: null,
  account: '',
  consent: false,
  market: null,
  snapshot: null,
  walletBalances: null,
  accountError: '',
  publicAccountError: '',
  publicAccountLoading: false,
  publicAccountRequest: null,
  balanceLoading: false,
  swapTab: 'trade',
  page: null,
  disclosurePage: null,
  quote: null,
  lastReceipt: null,
  disclosure: null,
  publicationRequest: null,
  publicationResult: null,
  publicationNotice: '',
  needsRefresh: false,
  busy: false,
  connecting: false,
  operationId: 0,
  walletOperation: null,
  quoteRevision: 0,
  walletConnector: null,
  walletTransport: null,
  walletListeners: [],
  version: 0,
  catalog: null,
  selectedMarketId: null,
  scopedFetch: undefined,
  dashboard: null,
  monitor: null,
  marketButtons: [],
  vaultAdmin: null,
  vaultAdminLoading: false,
  vaultAdminError: '',
  vaultWhitelist: null,
  vaultTransactions: new Map(),
};

class SessionChanged extends Error {}

function setStatus(message = '') {
  element('status').textContent = message;
  if (state.walletOperation?.running) {
    element('operation-dialog-status').textContent = message || 'Завершаем операцию…';
  }
}
function setError(message = '') {
  element('error').textContent = message;
  element('error').hidden = !message;
  if (state.walletOperation?.running) {
    const error = element('operation-dialog-error');
    error.textContent = message;
    error.hidden = !message;
  }
}

function updateOperationControl() {
  const dialog = element('operation-dialog');
  element('operation-dialog-open').hidden = dialog.open || !state.walletOperation;
}

function showWalletOperation() {
  const dialog = element('operation-dialog');
  if (!dialog.open && state.walletOperation) dialog.showModal();
  updateOperationControl();
}

const walletStepLabels = {
  check: { type: 'Проверка', active: 'Проверяем…', done: 'Проверено' },
  signature: { type: 'Подпись сообщения', active: 'Подтвердите в кошельке', done: 'Подписано' },
  transaction: { type: 'Транзакция', active: 'Подтвердите в кошельке', done: 'Подтверждено' },
  sequence: { type: 'Проверки и транзакции', active: 'Выполняется…', done: 'Выполнено' },
  local: { type: 'Сохранение файла', active: 'Сохраняем…', done: 'Сохранено' },
};

function beginWalletOperation(title, plan) {
  const list = element('operation-dialog-steps');
  const steps = plan.map((item) => {
    const node = document.createElement('li');
    node.className = 'operation-step';
    const check = document.createElement('span');
    check.className = 'operation-step-check';
    check.setAttribute('aria-hidden', 'true');
    const name = document.createElement('strong');
    name.className = 'operation-step-title';
    name.textContent = item.title;
    const detail = document.createElement('span');
    detail.className = 'operation-step-detail';
    node.append(check, name, detail);
    const step = { ...item, node, check, detail };
    setWalletStepState(step, 'waiting');
    return step;
  });
  const operation = state.walletOperation = { running: true, steps, group: null };
  element('operation-dialog-title').textContent = title;
  list.replaceChildren(...steps.map(({ node }) => node));
  element('operation-dialog-close').textContent = 'Скрыть';
  showWalletOperation();
  return operation;
}

function setWalletStepState(step, status, detail) {
  step.node.dataset.state = status;
  step.status = status;
  step.check.textContent = status === 'done' ? '✓' : status === 'skipped' ? '—' : '';
  if (status === 'active') step.node.setAttribute('aria-current', 'step');
  else step.node.removeAttribute('aria-current');
  const labels = walletStepLabels[step.kind];
  const fallback = { waiting: step.optional ? 'При необходимости' : '', pending: 'Ждём подтверждения', error: 'Шаг не завершён', skipped: 'Не потребовалось' };
  const label = detail || labels[status] || fallback[status];
  step.detail.textContent = [labels.type, label].filter(Boolean).join(' · ');
}

function recordWalletStep({ phase, kind, key, title, detail, id }) {
  const operation = state.walletOperation;
  if (!operation?.running || !Object.hasOwn(walletStepLabels, kind)) return;
  const group = operation.group;
  if (group && group.id !== id) {
    if (phase === 'start') {
      if (kind !== 'check' && kind !== 'transaction') return;
      group.childId = id;
    } else if (group.childId !== id) return;
    if (phase !== 'done') {
      const label = detail || walletStepLabels[kind].active;
      setWalletStepState(group, 'active', `${title} · ${label}`);
      element('operation-dialog-status').textContent = detail || `${walletStepLabels[kind].type} · ${title}`;
    }
    if (phase === 'done' || phase === 'pending' || phase === 'error') {
      group.childId = null;
      group.childError = phase === 'error' ? detail || 'Шаг не завершён' : '';
    }
    return;
  }
  if (phase === 'start') {
    const index = operation.steps.findIndex((step) => step.key === key && step.status === 'waiting');
    if (index < 0) return;
    const step = operation.steps[index];
    for (const earlier of operation.steps.slice(0, index)) {
      if (earlier.optional && earlier.status === 'waiting') setWalletStepState(earlier, 'skipped');
    }
    step.id = id;
    if (kind === 'sequence') operation.group = step;
    setWalletStepState(step, 'active', detail);
    element('operation-dialog-status').textContent = `${walletStepLabels[kind].type} · ${title}`;
    return;
  }
  const step = operation.steps.find((item) => item.id === id && item.status === 'active');
  if (!step) return;
  const status = { done: 'done', error: 'error', pending: 'pending', skipped: 'skipped', update: 'active' }[phase];
  if (status === 'pending' && step.childError) setWalletStepState(step, 'error', step.childError);
  else if (status) setWalletStepState(step, status, detail);
  if (group && status !== 'active') operation.group = null;
  if ((phase === 'update' || phase === 'pending') && detail) element('operation-dialog-status').textContent = detail;
  if (phase === 'done' && kind === 'signature') element('operation-dialog-status').textContent = 'Подпись получена. Обрабатываем запрос…';
}

function finishWalletOperation(operation, status = element('status').textContent, error = element('error').textContent) {
  if (!operation?.running || operation !== state.walletOperation) return;
  operation.running = false;
  const completed = !error && operation.steps.every((step) => step.optional || step.status === 'done');
  for (const step of operation.steps) {
    if (step.status === 'active') setWalletStepState(step, 'error');
    else if (step.status === 'waiting' && step.optional && completed) setWalletStepState(step, 'skipped');
  }
  const pending = operation.steps.some((step) => step.status === 'pending');
  element('operation-dialog-status').textContent = status || (pending ? 'Транзакция ждёт подтверждения.' : error ? 'Действие не завершено.' : 'Готово.');
  element('operation-dialog-error').textContent = error;
  element('operation-dialog-error').hidden = !error;
  element('operation-dialog-close').textContent = 'Закрыть';
}

element('operation-dialog-open').addEventListener('click', showWalletOperation);
element('operation-dialog-close').addEventListener('click', () => element('operation-dialog').close());
element('operation-dialog').addEventListener('close', updateOperationControl);

function guard(version) { if (version !== state.version) throw new SessionChanged(); }
function ready() { return Boolean(state.client && state.consent); }
function isZk() { return state.config?.proofMode === 'zk'; }
function provenWithdrawals() { return isZk() && state.config?.withdrawalMode === 'proven-reservation-v1'; }
function publicationKey(ticket) { return ticket?.kind === 'zk' ? `zk:${ticket.publicSignals[1]}` : ticket?.batch.batchId?.toString(); }
function tokenDecimals(token) { return Number(state.config.tokens[token].decimals); }
function amount(token, value) { return formatAmount(value, tokenDecimals(token)); }
function selectedMarket() { return state.catalog?.markets.find((market) => market.id === state.selectedMarketId); }
function symbol(token) {
  const market = selectedMarket();
  return state.config?.tokens[token]?.symbol ?? (token === 'RUBA' ? market?.base.symbol : market?.quote.symbol) ?? token;
}
function pairLabel() { return `${symbol('RUBA')} / ${symbol('USDT')}`; }
function enteredAmount(id, token, allowZero = false) {
  return parseAmount(element(id).value.trim() || (allowZero ? '0' : ''), tokenDecimals(token), { allowZero });
}
function tokenAmount(token, value) { return `${amount(token, value)} ${symbol(token)}`; }
function insufficientExchangeBalance(token, required, available) {
  const details = required === undefined ? '' : ` Нужно ${tokenAmount(token, required)}, доступно ${tokenAmount(token, available)}.`;
  return `На балансе обменника не хватает ${symbol(token)}.${details} Уменьшите сумму или пополните баланс в разделе «Мой баланс».`;
}
function requireExchangeBalance(token, required) {
  const available = BigInt(state.snapshot.balances[token]);
  if (required > available) throw new Error(insufficientExchangeBalance(token, required, available));
}
function operationErrorMessage(error) {
  const balance = /^Insufficient (RUBA|USDT) balance(?: \(required (\d+), available (\d+)\))?$/.exec(error?.message ?? '');
  return balance && state.config ? insufficientExchangeBalance(balance[1], balance[2], balance[3]) : errorMessage(error);
}
function newActivityAllowed() {
  return Boolean(state.market?.whitelisted && !state.market.marketPaused);
}
function fundingAllowed() { return newActivityAllowed(); }
function isAdmin() { return Boolean(state.catalog && state.account && state.account.toLowerCase() === state.catalog.control.admin.toLowerCase()); }
function balanceReady() { return ready() && !state.needsRefresh && Boolean(state.snapshot && state.market); }
function registeredAccount() { return !isZk() || state.snapshot?.zkProof?.registered === true; }
function balanceRefreshLabel() { return state.snapshot ? 'Обновить баланс' : 'Загрузить мой баланс'; }

function vaultKey() {
  return state.config && `${state.config.chainId}:${state.config.vaultAddress.toLowerCase()}`;
}

function canManageVault() {
  return ready() && state.page === 'admin' && state.vaultAdmin?.isOwner && !state.vaultAdminLoading;
}

function renderVaultAdmin() {
  const vault = state.vaultAdmin;
  const target = element('admin-wallet-address').value.trim();
  const tx = state.vaultTransactions.get(vaultKey());
  const readDisabled = state.busy || !canManageVault();
  const writeDisabled = readDisabled || tx?.status === 'submitted';
  element('admin-vault-status').textContent = !state.account ? 'Подключите кошелёк владельца Vault.'
    : state.vaultAdminLoading ? 'Читаем состояние Vault…'
      : state.vaultAdminError || (vault ? `${pairLabel()} · ${vault.isOwner ? 'Вы владелец Vault' : `Владелец Vault: ${vault.owner}`}` : 'Vault ещё не загружен.');
  element('admin-vault-refresh').disabled = state.busy || !ready() || state.vaultAdminLoading;
  element('admin-wallet-controls').disabled = readDisabled;
  element('admin-pause-controls').disabled = writeDisabled;
  element('admin-wallet-check').disabled = readDisabled || !target;
  element('admin-wallet-allow').disabled = writeDisabled || !target;
  element('admin-wallet-deny').disabled = writeDisabled || !target;
  element('admin-wallet-status').textContent = state.vaultWhitelist
    ? (state.vaultWhitelist.allowed ? 'Адрес есть в whitelist.' : 'Адреса нет в whitelist.') : '';
  element('admin-market-status').textContent = vault ? (vault.marketPaused ? 'Рынок на паузе.' : 'Рынок открыт.') : '';
  element('admin-market-toggle').textContent = vault?.marketPaused ? 'Снять паузу рынка' : 'Поставить рынок на паузу';
  const withdrawalStatus = [];
  for (const token of ['RUBA', 'USDT']) {
    const paused = vault?.withdrawalsPaused[token];
    const name = symbol(token);
    element(`admin-withdrawals-${token.toLowerCase()}-toggle`).textContent = paused ? `Возобновить вывод ${name}` : `Остановить вывод ${name}`;
    if (vault) withdrawalStatus.push(`${name}: ${paused ? 'вывод на паузе' : 'вывод открыт'}`);
  }
  element('admin-withdrawals-status').textContent = withdrawalStatus.join(' · ');
  const txLabels = { submitted: 'Транзакция ожидает подтверждения. Обновите статус из сети.', confirmed: 'Транзакция подтверждена.', reverted: 'Транзакция отклонена контрактом.' };
  element('admin-tx-status').textContent = tx ? `${txLabels[tx.status]} ${tx.transactionHash}` : '';
}

function renderSwapTabs() {
  const demo = Boolean(state.consent && state.catalog && state.swapTab === 'demo');
  element('swap-tabs').hidden = !state.catalog;
  element('swap-demo-tab').hidden = !state.catalog;
  for (const [id, selected] of [['swap-trade-tab', !demo], ['swap-demo-tab', Boolean(demo)]]) {
    element(id).setAttribute('aria-selected', String(selected));
    element(id).setAttribute('tabindex', selected ? '0' : '-1');
  }
  element('swap-trade-panel').hidden = demo;
  element('swap-demo-panel').hidden = !demo;
  element('market-admin').hidden = !demo;
  element('demo-market-label').textContent = pairLabel();
  const adminNotice = element('demo-access-notice');
  adminNotice.hidden = isAdmin();
  adminNotice.textContent = state.account
    ? 'Менять демо-настройки может администратор.'
    : 'Для изменения демо-настроек подключите кошелёк администратора.';
}

function renderReadiness() {
  let message = '';
  if (state.consent && ['swap', 'liquidity', 'account'].includes(state.page) && !(state.page === 'swap' && state.swapTab === 'demo')) {
    if (!state.account) message = 'Для операций нужен кошелёк.';
    else if (!state.client) message = state.busy
      ? 'Загружаем пул…'
      : 'Не удалось загрузить пул. Нажмите на карточку пары ещё раз.';
    else if (state.balanceLoading) message = 'Подпишите запрос баланса в кошельке.';
    else if (state.accountError) message = `Не удалось загрузить баланс: ${state.accountError} Нажмите «${balanceRefreshLabel()}», чтобы повторить запрос.`;
    else if (!state.snapshot || state.needsRefresh) message = 'Для просмотра баланса пула нужна подпись.';
    else if (!state.market && !state.publicAccountLoading) message = `Не удалось проверить допуск к пулу.${state.publicAccountError ? ` ${state.publicAccountError}` : ''} Обновите данные.`;
    else if (!state.market) message = 'Проверяем доступ к пулу.';
    else if (!state.market.whitelisted) message = 'Кошелька нет в whitelist. Пополнение, обмен и добавление ликвидности недоступны.';
    else if (state.market.marketPaused) message = 'Пополнение, обмен и добавление ликвидности на паузе.';
    else if (!registeredAccount()) message = 'Зарегистрируйте защищённый баланс в разделе «Мой баланс».';
    else if (BigInt(state.snapshot.balances.RUBA) === 0n && BigInt(state.snapshot.balances.USDT) === 0n && BigInt(state.snapshot.lpShares) === 0n) message = 'В этом пуле пусто. Пополните баланс в разделе «Мой баланс».';
  }
  element('account-readiness').hidden = !message;
  element('account-readiness-message').textContent = message;
  element('load-private-balances').hidden = !ready() || balanceReady() || state.balanceLoading;
  element('load-private-balances').textContent = balanceRefreshLabel();
  element('load-private-balances').disabled = state.busy || !ready();
}
function invalidateQuote() {
  state.quoteRevision += 1;
  state.quote = null;
  element('swap-quote').textContent = '—';
  element('swap-fee').textContent = '0,3% от суммы обмена';
  updateControls();
}

function clearDisclosure() {
  state.lastReceipt = null;
  state.disclosure = null;
  state.publicationRequest = null;
  state.publicationResult = null;
  state.publicationNotice = '';
  element('receipt-trade-id').value = '';
  renderDisclosure();
  renderPublication();
}

function renderPublication() {
  const offer = state.publicationRequest;
  let text = 'Нажмите «Обновить готовый пакет», чтобы проверить очередь публикации.';
  if (offer?.status === 'ready' && offer.request?.kind === 'zk') text = `Готов ZK-переход состояния №${offer.request.publicSignals[1]}: ${offer.request.publicSignals[2] === '0' ? 'регистрация, пополнение или управление балансом/LP' : `пакет из ${offer.request.batch.tradeCount} обменов`}. Контракт проверит доказательство. Газ оплачивает отправитель.`;
  else if (offer?.status === 'ready' && offer.request) text = `Готов пакет №${offer.request.batch.batchId} из ${offer.request.batch.tradeCount} сделок. Газ оплачивает отправитель транзакции.`;
  else if (offer?.status === 'waiting') text = 'Пакет уже принят сетью и ожидает подтверждения. Дождитесь подтверждения и обновите очередь; повторять обмены не нужно.';
  else if (offer?.status === 'idle' && offer.progress.collected > 0) text = `Пакет формируется: собрано ${offer.progress.collected} из ${offer.progress.required} сделок. Выполненные обмены повторять не нужно.`;
  else if (offer?.status === 'idle') text = 'Готовых неопубликованных пакетов сейчас нет.';
  if (state.publicationNotice) text += ` ${state.publicationNotice}`;
  element('publication-status').textContent = text;
}

function renderDisclosure() {
  const tradeId = element('receipt-trade-id').value.trim();
  const receipt = state.disclosure?.receipt?.tradeId?.toString() === tradeId
    ? state.disclosure.receipt : state.lastReceipt?.tradeId?.toString() === tradeId ? state.lastReceipt : null;
  element('receipt-summary').textContent = receipt
    ? `Квитанция сделки №${receipt.tradeId}. ${receipt.batchId === undefined ? 'Пакет ещё формируется.' : `Пакет №${receipt.batchId}.`}`
    : tradeId ? 'Нажмите «Загрузить квитанцию» или «Скачать квитанцию» и подпишите запрос.'
      : 'После обмена здесь появится номер сделки.';
  const cachedPublication = state.lastReceipt?.tradeId?.toString() === tradeId ? state.lastReceipt.publication : undefined;
  const publication = receipt?.publication
    ?? (receipt?.batchId !== undefined && cachedPublication?.status === 'collecting' ? undefined : cachedPublication);
  element('receipt-publication').textContent = publication?.status === 'collecting' && receipt?.batchId === undefined
    ? `${isZk() ? 'Расчёт принят сервером, ZK-подтверждение ещё ожидается.' : 'Обмен уже выполнен.'} Для публикации собирается пакет: ${publication.collected} из ${publication.required} сделок. После закрытия пакета загрузите квитанцию по её номеру.`
    : publication?.status === 'published'
      ? `Публикация в блокчейне подтверждена.${publication.transactionHash ? ` Транзакция: ${publication.transactionHash}` : ''}`
      : publication?.status === 'pending' && receipt?.batchId !== undefined
        ? `${isZk() ? 'Расчёт принят сервером.' : 'Обмен уже выполнен.'} Пакет сформирован и ожидает подтверждения публикации.${publication.transactionHash ? ` Транзакция: ${publication.transactionHash}` : ' Используйте панель публикации; повторять обмен не нужно.'}`
      : receipt?.batchId !== undefined
        ? 'Пакет сформирован. Квитанцию можно скачать; подтверждение публикации проверяется на странице раскрытия.'
        : receipt ? `${isZk() ? 'Расчёт принят сервером, ZK-подтверждение ещё ожидается.' : 'Обмен уже выполнен.'} Квитанция ожидает закрытия пакета до четырёх сделок.` : '';
  renderDashboard();
}

function updateControls() {
  const locked = !state.consent;
  const disabled = state.busy || !ready();
  const economicDisabled = state.busy || !balanceReady();
  const registeredDisabled = economicDisabled || !registeredAccount();
  for (const anchor of document.querySelectorAll('nav a[data-requires-entry]')) {
    if (locked) {
      anchor.removeAttribute('href');
      anchor.setAttribute('aria-disabled', 'true');
      anchor.setAttribute('tabindex', '-1');
      anchor.setAttribute('title', 'Сначала подтвердите вход');
    } else {
      anchor.setAttribute('href', `#/${anchor.dataset.route}`);
      anchor.removeAttribute('aria-disabled');
      anchor.removeAttribute('tabindex');
      anchor.removeAttribute('title');
    }
  }
  element('admin-link').hidden = locked;
  for (const section of document.querySelectorAll('[data-page]')) {
    if (section.dataset.page === 'entry' || section.dataset.page === 'disclosure') continue;
    section.inert = locked;
    if (locked) section.hidden = true;
  }
  for (const fieldset of document.querySelectorAll('fieldset[data-requires-wallet]')) {
    // Editing a form does not authorize a transaction. Keep inputs usable and
    // gate the economic buttons separately with the actual readiness/policy.
    fieldset.disabled = locked;
  }
  // Publishing roots does not spend the private account balance, so a rejected
  // balance-refresh signature must not prevent retrying an existing package.
  element('publication-controls').disabled = disabled;
  element('publication-refresh').disabled = disabled;
  const ticket = state.publicationRequest?.status === 'ready' ? state.publicationRequest.request : null;
  const submitted = state.publicationResult?.status === 'submitted'
    && (state.publicationResult.publicationKey ?? state.publicationResult.batchId?.toString()) === publicationKey(ticket);
  element('publication-submit').disabled = disabled || !ticket || submitted;
  element('connect-wallet').disabled = state.busy || !state.config;
  element('connect-wallet').hidden = Boolean(state.account);
  // Disconnect is an escape hatch even if a wallet/RPC/signature never responds.
  element('disconnect-wallet').disabled = !state.account;
  element('disconnect-wallet').hidden = !state.account;
  element('cancel-wallet-connect').hidden = !state.connecting;
  element('cancel-wallet-connect').disabled = !state.connecting;
  element('enter-app').disabled = state.busy || !element('consent').checked;
  element('consent').disabled = state.busy;
  element('refresh-balances').hidden = !balanceReady();
  element('refresh-balances').disabled = disabled;
  element('quote-swap').disabled = disabled || !newActivityAllowed();
  element('submit-swap').disabled = registeredDisabled || !newActivityAllowed() || !state.quote;
  element('submit-liquidity-add').disabled = registeredDisabled || !newActivityAllowed();
  element('submit-liquidity-remove').disabled = registeredDisabled;
  element('submit-deposit').disabled = economicDisabled || !fundingAllowed();
  const validReceiptId = /^[1-9][0-9]*$/.test(element('receipt-trade-id').value.trim());
  element('receipt-load').disabled = disabled || state.needsRefresh || !validReceiptId;
  const receiptId = element('receipt-trade-id').value.trim();
  const loadedReceipt = state.disclosure?.receipt?.tradeId?.toString() === receiptId ? state.disclosure.receipt : null;
  const collecting = !loadedReceipt && state.lastReceipt?.tradeId?.toString() === receiptId && state.lastReceipt.batchId === undefined;
  element('receipt-download').disabled = disabled || state.needsRefresh || !validReceiptId || collecting;
  const selectedToken = element('withdraw-token').value;
  element('submit-withdraw').disabled = registeredDisabled || Boolean(state.market?.withdrawalsPaused?.[selectedToken]);
  element('zk-balance-panel').hidden = !isZk();
  // Recovery must remain usable even when a private API refresh has failed.
  element('zk-balance-panel').disabled = disabled;
  for (const id of ['zk-proof-refresh', 'zk-backup-export', 'zk-backup-import', 'zk-register', 'zk-recover-chain']) element(id).disabled = disabled;
  element('zk-register').disabled = economicDisabled || !state.market?.whitelisted;
  for (const button of document.querySelectorAll('[data-pending-action]')) {
    const blockedToken = button.dataset.pendingAction === 'redeem' && Boolean(state.market?.withdrawalsPaused?.[button.dataset.token]);
    button.disabled = disabled || state.needsRefresh || blockedToken;
  }
  element('market-selection').hidden = !state.catalog || locked || state.page === 'disclosure';
  for (const button of state.marketButtons) button.disabled = state.busy || locked;
  element('dashboard-refresh').disabled = state.busy || locked || !state.catalog;
  element('faucet-panel').hidden = !state.catalog;
  element('faucet-panel').disabled = disabled;
  element('faucet-submit').disabled = disabled || !state.catalog;
  const admin = isAdmin();
  element('reference-controls').disabled = disabled || !admin;
  element('arbitrage-controls').disabled = disabled || !admin || !state.dashboard?.arbitrage;
  element('batch-admin-controls').disabled = disabled || !admin || !isZk();
  element('close-current-batch').disabled = disabled || !admin || !isZk();
  element('swap-demo-tab').disabled = locked;
  renderSwapTabs();
  renderReadiness();
  renderVaultAdmin();
}

function route() {
  const requested = location.hash.replace(/^#\/?/, '') || 'entry';
  const page = ['swap', 'liquidity', 'account', 'disclosure', 'admin'].includes(requested) ? requested : 'swap';
  const active = page === 'disclosure' || state.consent ? page : 'entry';
  const enteringAdmin = state.page !== 'admin' && active === 'admin';
  if (state.page !== active && active === 'swap') state.swapTab = 'trade';
  state.page = active;
  for (const section of document.querySelectorAll('[data-page]')) {
    section.hidden = section.dataset.page !== active;
    section.inert = section.hidden;
  }
  for (const anchor of document.querySelectorAll('nav a')) {
    const destination = anchor.hasAttribute('data-disclosure-link') ? 'disclosure' : anchor.dataset.route;
    if (destination === active) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  if (active === 'disclosure') showDisclosurePage();
  if (active === 'admin' && ready() && !state.vaultAdminLoading && (enteringAdmin || !state.vaultAdmin)) {
    void refreshVaultAdmin(state.version);
  }
  updateControls();
}

function showDisclosurePage() {
  if (state.disclosurePage) return;
  const content = element('disclosure-content');
  content.textContent = 'Загружаем страницу раскрытия…';
  content.setAttribute('role', 'status');
  state.disclosurePage = loadEmbeddedDisclosure(content).then(() => content.removeAttribute('role')).catch((error) => {
    state.disclosurePage = null;
    content.textContent = `Не удалось открыть раскрытие. ${errorMessage(error)}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', showDisclosurePage);
    content.append(retry);
  });
}

function renderAccount() {
  for (const token of ['RUBA', 'USDT']) {
    const suffix = token.toLowerCase();
    element(`internal-${suffix}`).textContent = state.snapshot ? amount(token, state.snapshot.balances[token]) : '—';
    element(`liquidity-available-${suffix}`).textContent = state.snapshot ? tokenAmount(token, state.snapshot.balances[token]) : '—';
    element(`wallet-${suffix}`).textContent = state.walletBalances ? amount(token, state.walletBalances[token]) : '—';
    const pending = state.snapshot?.withdrawals.filter((record) => record.token === token && record.status === 'pending') ?? [];
    element(`pending-${suffix}`).textContent = state.snapshot ? amount(token, pending.reduce((total, record) => total + BigInt(record.amount), 0n)) : '—';
  }
  renderSwapBalance();
  element('lp-shares').textContent = state.snapshot ? formatAmount(state.snapshot.lpShares, 18) : '—';
  element('withdrawal-help').textContent = provenWithdrawals()
    ? 'Сохранённые доказанные права бессрочны. Запрос на вывод закрывает неполный пакет. Продолжите публикацию и выплату из списка, не создавая новое резервирование.'
    : 'Если транзакция не была завершена, её можно продолжить здесь. После окончания срока можно вернуть зарезервированную сумму на баланс.';
  const proof = state.snapshot?.zkProof;
  element('zk-balance-status').textContent = proof
    ? `${proof.registered ? 'Баланс зарегистрирован.' : 'Баланс ещё не зарегистрирован.'} ${proof.verified ? 'Merkle proof соответствует текущему принятому корню Vault.' : 'Предварительное состояние сервера: ZK-публикация ещё не подтверждена.'} Версия: ${proof.stateVersion}. Корень: ${proof.stateRoot}.`
    : `Загрузите доказательство своего баланса. Суммы скрыты от блокчейна; адрес владельца публичен. ${provenWithdrawals() ? 'Выплата основана на доказанном резервировании без разрешения оператора. Для нового proof нужен prover; автономного аварийного выхода нет.' : 'Вывод по-прежнему требует разрешения оператора.'}`;
  renderWithdrawals();
}

function renderSwapBalance() {
  const token = element('swap-token-in').value;
  element('swap-available').textContent = state.snapshot && (token === 'RUBA' || token === 'USDT') ? tokenAmount(token, state.snapshot.balances[token]) : '—';
}

function renderWallet() {
  element('entry-policy').textContent = provenWithdrawals()
    ? 'Допуск к пополнению, обмену и добавлению ликвидности выдаёт администратор. Свои токены и LP-доли можно вывести после отзыва допуска.'
    : 'Допуск к обмену и новым вложениям выдаёт администратор.';
  element('wallet-address').hidden = !state.account;
  element('wallet-address').textContent = state.account ? 'Кошелёк подключён' : '';
  if (!state.market) element('access-status').textContent = state.publicAccountLoading
    ? 'Допуск проверяется'
    : state.publicAccountError ? 'Допуск не проверен' : '';
  else {
    const notices = [];
    if (!state.market.whitelisted) notices.push('Нет допуска к новым операциям.');
    if (state.market.marketPaused) notices.push('Новые операции приостановлены.');
    if (state.market.withdrawalsPaused.RUBA) notices.push(`Вывод ${symbol('RUBA')} приостановлен.`);
    if (state.market.withdrawalsPaused.USDT) notices.push(`Вывод ${symbol('USDT')} приостановлен.`);
    element('access-status').textContent = notices.length ? notices.join(' ') : 'Допуск к операциям есть';
  }
  updateControls();
}

function resetWallet(message = 'Кошелёк отключён от интерфейса.') {
  finishWalletOperation(state.walletOperation, message, '');
  state.version += 1;
  state.operationId += 1;
  state.busy = false;
  state.connecting = false;
  for (const [provider, event, listener] of state.walletListeners) provider.removeListener?.(event, listener);
  state.walletListeners = [];
  state.walletTransport = null;
  state.walletConnector?.cancel();
  void state.walletConnector?.disconnect().catch(() => {});
  state.client?.dispose?.();
  state.provider?.destroy?.();
  state.provider = null;
  state.signer = null;
  state.client = null;
  state.account = '';
  state.market = null;
  clearVaultAdmin();
  state.snapshot = null;
  state.walletBalances = null;
  state.accountError = '';
  state.publicAccountError = '';
  state.publicAccountLoading = false;
  state.balanceLoading = false;
  state.swapTab = 'trade';
  state.needsRefresh = false;
  state.monitor = null;
  element('admin-monitor-result').textContent = 'Приватный monitor ещё не запрошен.';
  element('batch-close-result').textContent = 'Пакет ещё не запрашивался.';
  clearDisclosure();
  invalidateQuote();
  renderAccount();
  renderWallet();
  setError();
  setStatus(message);
  route();
}

async function run(label, operation, requireReady = true, wallet) {
  if (state.busy) return;
  if (requireReady && !ready()) { setError('Подключите кошелёк и подтвердите вход.'); return; }
  const version = state.version;
  const operationId = ++state.operationId;
  state.busy = true;
  const walletOperation = wallet ? beginWalletOperation(wallet.title, wallet.steps) : null;
  setError();
  setStatus(label);
  updateControls();
  try {
    await operation(version);
  } catch (error) {
    if (!(error instanceof SessionChanged) && version === state.version) {
      setError(operationErrorMessage(error));
      if (error?.uncertain === true) {
        state.needsRefresh = true;
        invalidateQuote();
        setStatus('Результат неизвестен. Сначала обновите данные.');
      } else setStatus('Действие не завершено.');
    }
  } finally {
    if (operationId === state.operationId) {
      finishWalletOperation(walletOperation);
      state.busy = false;
      updateControls();
    }
  }
}

function runWallet(title, label, steps, operation) {
  return run(label, operation, true, { title, steps });
}

// Server responses and on-chain checks can skip some steps. Keep those rows
// visible, and use a fixed row for a sequence with an unknown number of transactions.
const checklist = (key, title, optional = false) => ({
  key, title, optional,
  kind: { check: 'check', sign: 'signature', tx: 'transaction', sequence: 'sequence', local: 'local' }[key.split(':')[0]],
});
const proofChecklist = (optionalSignature = false, optionalCheck = false) => [
  checklist('sign:zkState', 'Подписать запрос доказательства баланса', optionalSignature),
  checklist('check:zk-proof', 'Проверить доказательство баланса', optionalCheck),
];
const balanceChecklist = () => [
  checklist('sign:account', 'Подписать запрос баланса'),
  ...(isZk() ? proofChecklist(true) : []),
];
const registrationChecklist = () => [
  checklist('check:registration-admission', 'Проверить допуск к регистрации в Vault'),
  checklist('sign:recovery-key', 'Подписать создание ключа восстановления', true),
  ...proofChecklist(),
  checklist('sign:zkRegister', 'Подписать регистрацию защищённого баланса', true),
  ...proofChecklist(true, true),
  ...(provenWithdrawals() ? [
    checklist('sequence:registration-publication', 'Проверить регистрацию в сети и опубликовать нужные доказательства'),
  ] : []),
];
const publicationChecklist = (optional = false) => [
  checklist('check:publication', 'Проверить пакет и состояние Vault', optional),
  checklist('tx:publication', isZk() ? 'Опубликовать ZK-переход' : 'Опубликовать пакет сделок', true),
];
const withdrawalChecklist = () => provenWithdrawals() ? [
  checklist('check:proven-withdrawal', 'Проверить заявку на выплату'),
  checklist('sequence:proven-payout', 'При необходимости опубликовать доказательства и получить выплату'),
] : [
  checklist('check:withdrawal', 'Проверить разрешение на вывод'),
  checklist('tx:withdrawal', 'Вывести токены на кошелёк'),
];
const vaultChecklist = (key, title) => [checklist('check:owner', 'Проверить право владельца Vault'), checklist(key, title)];

function checklistReporter(key, kind, title) {
  const id = Symbol();
  return (phase, detail) => recordWalletStep({ id, key, kind, title, phase, detail });
}

async function runPublicationChecklist(version, boundary, offer) {
  const report = checklistReporter('sequence:publication', 'sequence', 'Опубликовать готовые ZK-переходы');
  report('start');
  try {
    const result = await publishClosedTransitions(version, boundary, offer);
    guard(version);
    if (result.completed) report(result.published ? 'done' : 'skipped');
    else report('pending', 'Публикация пока не завершена');
    return result;
  } catch (error) {
    if (version === state.version) report('error');
    throw error;
  }
}

async function refreshPublicAccount(version, { fresh = false } = {}) {
  const client = state.client;
  if (!client) return [];
  if (state.publicAccountRequest?.version === version) return state.publicAccountRequest.promise;
  state.publicAccountLoading = true;
  renderWallet();
  const promise = Promise.allSettled([
    waitForWallet(client.getMarketStatus({ fresh })).then((market) => {
      guard(version);
      state.market = market;
      state.publicAccountError = '';
    }).catch((error) => {
      guard(version);
      state.market = null;
      state.publicAccountError = errorMessage(error);
      throw error;
    }).finally(() => {
      if (version !== state.version) return;
      state.publicAccountLoading = false;
      renderWallet();
    }),
    waitForWallet(client.getWalletBalances()).then((balances) => {
      guard(version); state.walletBalances = balances; renderAccount();
    }),
  ]).finally(() => {
    if (state.publicAccountRequest?.version === version) state.publicAccountRequest = null;
  });
  state.publicAccountRequest = { version, promise };
  return promise;
}

async function refreshAccount(version) {
  const client = state.client;
  state.balanceLoading = true;
  state.accountError = '';
  state.needsRefresh = true;
  setStatus('Подпишите запрос для обновления своих балансов.');
  updateControls();
  try {
    const [publicReads, privateRead] = await Promise.allSettled([
      refreshPublicAccount(version),
      waitForWallet(client.getAccount(), 120_000).then((snapshot) => {
        guard(version); state.snapshot = snapshot; state.needsRefresh = false; renderAccount();
      }),
    ]);
    guard(version);
    if (privateRead.status === 'rejected') {
      state.accountError = errorMessage(privateRead.reason);
      throw privateRead.reason;
    }
    const publicError = publicReads.status === 'fulfilled'
      ? publicReads.value.find((result) => result.status === 'rejected')?.reason : publicReads.reason;
    if (publicError) throw new Error(`Приватный баланс загружен. Не удалось обновить данные сети: ${errorMessage(publicError)}`);
  } finally {
    if (version === state.version) { state.balanceLoading = false; renderWallet(); renderAccount(); }
  }
}

async function refreshAfterSuccess(version, message) {
  state.needsRefresh = true;
  updateControls();
  try {
    await refreshAccount(version);
    setStatus(message);
  } catch (error) {
    guard(version);
    // The trade or chain transaction is already committed. A rejected balance
    // signature must never make it look as though that operation can be repeated.
    setError(`Не удалось обновить балансы: ${errorMessage(error)}`);
    setStatus(`${message} Нажмите «${balanceRefreshLabel()}», чтобы проверить балансы.`);
  }
}

function waitForWallet(promise, milliseconds = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Кошелёк или сеть не ответили вовремя. Проверьте кошелёк и повторите действие.')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function clearVaultAdmin() {
  state.vaultAdmin = null;
  state.vaultAdminLoading = false;
  state.vaultAdminError = '';
  state.vaultWhitelist = null;
}

async function refreshVaultAdmin(version) {
  state.vaultAdminLoading = true;
  state.vaultAdminError = '';
  updateControls();
  try {
    const vault = await waitForWallet(state.client.getAdminStatus());
    guard(version);
    state.vaultAdmin = vault;
  } catch (error) {
    if (version !== state.version) return;
    state.vaultAdmin = null;
    state.vaultAdminError = errorMessage(error);
  } finally {
    if (version === state.version) {
      state.vaultAdminLoading = false;
      updateControls();
    }
  }
}

function whitelistAddress() {
  const input = element('admin-wallet-address').value.trim();
  if (!/^0x[\da-fA-F]{40}$/.test(input)) throw new Error('Введите адрес кошелька в формате 0x…');
  let address;
  try { address = getAddress(input); }
  catch { throw new Error('Проверьте регистр символов в адресе кошелька.'); }
  if (address === ZeroAddress) throw new Error('Введите ненулевой адрес кошелька.');
  return address;
}

function requireVaultOwner() {
  if (!canManageVault()) throw new Error('Нужен кошелёк владельца этого Vault.');
}

async function readWhitelist(address, version) {
  const input = element('admin-wallet-address');
  const allowed = await waitForWallet(state.client.getWhitelist(address));
  guard(version);
  if (input.value.trim().toLowerCase() === address.toLowerCase()) {
    state.vaultWhitelist = { address, allowed };
    updateControls();
  }
}

async function refreshVaultPolicy(version) {
  await state.publicAccountRequest?.promise;
  guard(version);
  state.market = null;
  invalidateQuote();
  await Promise.all([refreshPublicAccount(version, { fresh: true }), refreshVaultAdmin(version)]);
  guard(version);
}

async function sendVaultAdminTransaction(version, send, target = null) {
  requireVaultOwner();
  const key = vaultKey();
  const previous = state.vaultTransactions.get(key);
  if (previous?.status === 'submitted') throw new Error('Сначала проверьте предыдущую транзакцию.');
  const result = await send((message) => { if (version === state.version) setStatus(message); });
  if (state.vaultTransactions.get(key) === previous) state.vaultTransactions.set(key, { ...result, target });
  guard(version);
  setStatus('');
  if (result.status !== 'confirmed') return;
  await refreshVaultPolicy(version);
  if (target && state.vaultAdmin?.isOwner) {
    try { await readWhitelist(target, version); }
    catch (error) {
      guard(version);
      state.vaultWhitelist = null;
      setError(`Транзакция подтверждена. Не удалось прочитать whitelist: ${errorMessage(error)}`);
    }
  }
}

element('admin-vault-refresh').addEventListener('click', () => run('Обновляем состояние Vault…', async (version) => {
  const key = vaultKey();
  const tx = state.vaultTransactions.get(key);
  if (tx?.status === 'submitted') {
    const receipt = await waitForWallet(state.provider.getTransactionReceipt(tx.transactionHash));
    guard(version);
    if (receipt) tx.status = Number(receipt.status) === 1 ? 'confirmed' : 'reverted';
  }
  await refreshVaultPolicy(version);
  if (tx?.target && state.vaultAdmin?.isOwner) await readWhitelist(tx.target, version);
  setStatus('');
}));
element('admin-wallet-address').addEventListener('input', () => {
  state.vaultWhitelist = null;
  renderVaultAdmin();
});
element('admin-wallet-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run('Проверяем whitelist…', async (version) => {
    requireVaultOwner();
    await readWhitelist(whitelistAddress(), version);
    setStatus('');
  });
});
for (const [id, allowed] of [['admin-wallet-allow', true], ['admin-wallet-deny', false]]) {
  const title = allowed ? 'Добавление в whitelist' : 'Отзыв допуска';
  element(id).addEventListener('click', () => runWallet(title, 'Проверяем настройки Vault…', vaultChecklist('tx:whitelist',
    allowed ? 'Добавить кошелёк в список допуска' : 'Отозвать допуск кошелька'), (version) => {
    const address = whitelistAddress();
    return sendVaultAdminTransaction(version, (progress) => state.client.setWhitelist(address, allowed, progress), address);
  }));
}
element('admin-market-toggle').addEventListener('click', () => runWallet('Пауза рынка', 'Проверяем настройки Vault…', vaultChecklist('tx:market-pause',
  state.vaultAdmin?.marketPaused ? 'Возобновить работу рынка' : 'Поставить рынок на паузу'), (version) =>
  sendVaultAdminTransaction(version, (progress) => state.client.setMarketPaused(!state.vaultAdmin.marketPaused, progress))));
for (const token of ['RUBA', 'USDT']) {
  element(`admin-withdrawals-${token.toLowerCase()}-toggle`).addEventListener('click', () =>
    runWallet(`Пауза вывода ${symbol(token)}`, 'Проверяем настройки Vault…', vaultChecklist('tx:withdrawal-pause',
      `${state.vaultAdmin?.withdrawalsPaused[token] ? 'Возобновить' : 'Приостановить'} вывод ${symbol(token)}`), (version) => sendVaultAdminTransaction(version,
      (progress) => state.client.setTokenWithdrawalsPaused(token, !state.vaultAdmin.withdrawalsPaused[token], progress))));
}

function watchWallet(provider, account) {
  state.walletTransport = provider;
  const expectedChainId = BigInt(state.config.chainId);
  const messages = {
    accountsChanged: 'Аккаунт в кошельке изменился. Подключите нужный аккаунт.',
    chainChanged: 'Сеть изменена. Подключите кошелёк заново.',
    disconnect: 'Связь с кошельком потеряна. Подключитесь заново.',
  };
  for (const [event, message] of Object.entries(messages)) {
    const listener = (payload) => {
      if (state.walletTransport !== provider) return;
      // Some extensions repeat their current context during initialization.
      if (event === 'chainChanged' && typeof payload === 'string') {
        try { if (BigInt(payload) === expectedChainId) return; } catch {}
      }
      if (event === 'accountsChanged' && Array.isArray(payload)
        && payload[0]?.toLowerCase() === account.toLowerCase()) return;
      resetWallet(message);
    };
    provider.on?.(event, listener);
    state.walletListeners.push([provider, event, listener]);
  }
}

async function connect() {
  await run('Подключение кошелька…', async (version) => {
    state.walletConnector ??= createWalletConnector(state.config);
    const connector = state.walletConnector;
    state.connecting = true;
    updateControls();
    let candidateProvider;
    let candidateClient;
    try {
      const wallet = await waitForWallet(connector.connect(), 120_000);
      guard(version);
      if (!wallet) { setStatus('Подключение отменено. Можно выбрать кошелёк снова.'); return; }
      const provider = candidateProvider = new BrowserProvider(wallet.provider);
      const network = await waitForWallet(provider.getNetwork());
      guard(version);
      if (network.chainId !== BigInt(state.config.chainId)) {
        const networkName = state.catalog?.network.name ?? (state.config.chainMode === 'sepolia' ? 'Sepolia' : null);
        throw new Error(`Выберите в кошельке сеть ${networkName ?? state.config.chainId}. Сейчас подключена сеть ${network.chainId}.`);
      }
      const signer = await waitForWallet(provider.getSigner());
      const account = await waitForWallet(signer.getAddress());
      guard(version);
      watchWallet(wallet.provider, account);
      const client = candidateClient = new RubaClient(state.config, provider, signer, {
        fetchImpl: state.scopedFetch,
        onWalletStep: (step) => { if (state.client === candidateClient) recordWalletStep(step); },
      });
      await waitForWallet(client.assertContext());
      guard(version);
      state.provider = provider;
      state.signer = signer;
      state.client = client;
      state.account = account;
      state.market = null;
      state.walletBalances = null;
      state.snapshot = null;
      state.accountError = '';
      state.publicAccountError = '';
      clearDisclosure();
      state.needsRefresh = state.consent;
      renderWallet();
      renderAccount();
      invalidateQuote();
      route();
      void refreshPublicAccount(version);
      setStatus('');
    } catch (error) {
      if (version === state.version) {
        for (const [provider, event, listener] of state.walletListeners) provider.removeListener?.(event, listener);
        state.walletListeners = [];
        state.walletTransport = null;
        connector.cancel();
        void connector.disconnect().catch(() => {});
      }
      throw error;
    } finally {
      if (candidateClient && candidateClient !== state.client) candidateClient.dispose?.();
      if (candidateProvider && candidateProvider !== state.provider) candidateProvider.destroy?.();
      if (version === state.version) { state.connecting = false; updateControls(); }
    }
  }, false);
}

function renderWithdrawals() {
  const list = element('withdrawal-list');
  list.replaceChildren();
  if (!state.snapshot) { list.textContent = 'Обновите баланс, чтобы увидеть заявки на вывод.'; return; }
  if (!state.snapshot.withdrawals.length) { list.textContent = 'Заявок на вывод пока нет.'; return; }
  const items = document.createElement('ul');
  list.append(items);
  for (const record of state.snapshot.withdrawals) {
    const item = document.createElement('li');
    const status = { pending: provenWithdrawals() ? 'Ожидает доказательства или погашения права' : 'Ожидает выплаты', draft: 'Локальное открытие: резервирование ещё не подтверждено', settled: 'Выплачено', expired: 'Срок истёк, сумма возвращена на внутренний баланс' }[record.status] ?? record.status;
    const description = document.createElement('p');
    description.textContent = `${amount(record.token, record.amount)} ${symbol(record.token)} — ${status}. Заявка №${record.nonce}.`;
    item.append(description);
    if (record.status === 'pending' || (provenWithdrawals() && record.status === 'draft')) {
      const expired = !provenWithdrawals() && state.market && BigInt(state.market.timestamp) > BigInt(record.deadline);
      const deadline = document.createElement('p');
      deadline.textContent = provenWithdrawals() ? 'Доказанное право выплаты бессрочно. Запрос на вывод закрывает неполный пакет; продолжите подготовку доказательства и выплату без ожидания четвёртого обмена. Повторять резервирование не нужно.' : `Действует до ${new Date(Number(record.deadline) * 1000).toLocaleString('ru-RU')}.`;
      item.append(deadline);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.pendingAction = expired ? 'expire' : 'redeem';
      button.dataset.token = record.token;
      button.textContent = expired ? 'Вернуть просроченную сумму на баланс' : provenWithdrawals() ? 'Проверить и продолжить выплату' : 'Получить на кошелёк';
      button.addEventListener('click', () => runWallet(expired ? 'Возврат суммы на баланс' : 'Выплата по заявке', 'Проверяем заявку…', [
        ...(expired ? [checklist('sign:expireWithdrawal', 'Подписать возврат просроченной заявки')] : [
          checklist('sign:withdrawal', 'Подписать запрос сохранённой выплаты', provenWithdrawals()),
          ...withdrawalChecklist(),
        ]),
        ...balanceChecklist(),
      ], async (version) => {
        const client = state.client;
        if (expired) {
          await client.signedAction({ kind: 'expireWithdrawal', nonce: record.nonce.toString() });
          guard(version);
          await refreshAfterSuccess(version, 'Сумма просроченной заявки возвращена на внутренний баланс.');
        } else {
          const ticket = provenWithdrawals() && client.getCachedWithdrawalTicket?.(record.nonce, record.commitment)
            || await client.signedAction({ kind: 'withdrawal', nonce: record.nonce.toString() });
          guard(version);
          const result = await client.redeemWithdrawal(ticket, (message) => { if (version === state.version) setStatus(message); });
          guard(version);
          await refreshAfterSuccess(version, payoutResultMessage(result));
        }
      }));
      item.append(button);
    }
    items.append(item);
  }
  updateControls();
}

element('connect-wallet').addEventListener('click', connect);
for (const link of document.querySelectorAll('[data-disclosure-link]')) {
  link.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button > 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    location.hash = '#/disclosure';
    route();
  });
}
for (const anchor of document.querySelectorAll('nav a[data-requires-entry]')) {
  anchor.addEventListener('click', (event) => {
    if (state.consent) return;
    event.preventDefault();
    location.hash = '#/entry';
    route();
    setStatus('Сначала подтвердите вход и нажмите «Продолжить».');
  });
}
element('disconnect-wallet').addEventListener('click', () => resetWallet());
element('cancel-wallet-connect').addEventListener('click', () => resetWallet('Подключение отменено.'));
function selectSwapTab(tab, focus = false) {
  if (!state.consent || !state.catalog) return;
  state.swapTab = tab;
  updateControls();
  if (focus) element(`swap-${tab}-tab`).focus();
}
for (const tab of ['trade', 'demo']) {
  const button = element(`swap-${tab}-tab`);
  button.addEventListener('click', () => selectSwapTab(tab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'trade' : event.key === 'End' ? 'demo' : tab === 'demo' ? 'trade' : 'demo';
    selectSwapTab(next, true);
  });
}
element('consent').addEventListener('change', () => {
  if (!element('consent').checked && state.consent) {
    state.version += 1;
    state.consent = false;
    state.market = null;
    clearVaultAdmin();
    state.snapshot = null;
    state.walletBalances = null;
    state.publicAccountLoading = false;
    state.needsRefresh = false;
    clearDisclosure();
    invalidateQuote();
    renderAccount();
    renderWallet();
    setStatus('Вход не подтверждён. Остальные разделы заблокированы.');
    route();
  }
  updateControls();
});

function payoutResultMessage(result) {
  if (!provenWithdrawals()) return 'Выплата отправлена. Баланс обновится после подтверждения сети.';
  if (result?.status === 'waiting') return result.message ?? 'Открытие заявки сохранено. Дождитесь доказательства; повторять резервирование не нужно.';
  if (result?.status === 'submitted') return `Результат выплаты пока неизвестен.${result.transactionHash ? ` Транзакция: ${result.transactionHash}.` : ''} Проверьте сохранённое право; повторять резервирование не нужно.`;
  if (result?.status === 'already-withdrawn') return 'Это право выплаты уже погашено. Повторного перевода не было.';
  return 'Доказанное право погашено, токены перечислены на ваш кошелёк.';
}
element('enter-app').addEventListener('click', () => run('Подтверждение входа…', async (version) => {
  if (!element('consent').checked) throw new Error('Поставьте отметку подтверждения входа.');
  state.consent = true;
  state.needsRefresh = Boolean(state.client);
  const requested = location.hash.replace(/^#\/?/, '');
  if (!['swap', 'liquidity', 'account', 'admin'].includes(requested)) location.hash = '#/swap';
  route();
  renderDashboard();
  if (state.client && !state.market) void refreshPublicAccount(version);
  setStatus('');
}, false));

for (const id of ['refresh-balances', 'load-private-balances']) {
  element(id).addEventListener('click', () => runWallet('Обновление баланса', 'Готовим запрос баланса…', balanceChecklist(), async (version) => {
    await refreshAccount(version);
    setStatus('Балансы обновлены.');
  }));
}

for (const id of ['swap-token-in', 'swap-amount', 'swap-slippage']) {
  element(id).addEventListener('input', invalidateQuote);
  element(id).addEventListener('change', invalidateQuote);
}
element('swap-token-in').addEventListener('change', renderSwapBalance);

element('quote-swap').addEventListener('click', () => runWallet('Расчёт обмена', 'Готовим запрос котировки…', [
  checklist('sign:quote', 'Подписать запрос котировки'),
], async (version) => {
  if (!newActivityAllowed()) throw new Error('Проверьте допуск к обмену в выбранном пуле.');
  invalidateQuote();
  const revision = state.quoteRevision;
  const tokenIn = element('swap-token-in').value;
  const amountIn = enteredAmount('swap-amount', tokenIn);
  const slippage = parseSlippage(element('swap-slippage').value);
  const result = await state.client.signedAction({ kind: 'quote', tokenIn, amountIn: amountIn.toString() });
  guard(version);
  if (revision !== state.quoteRevision) {
    setStatus('Значения изменились. Получите новую котировку.');
    return;
  }
  const tokenOut = tokenIn === 'RUBA' ? 'USDT' : 'RUBA';
  const amountOut = BigInt(result.amountOut);
  if (amountOut <= 0n) throw new Error('Сумма слишком мала для обмена.');
  const minOut = minimumOutput(amountOut, slippage);
  state.quote = { tokenIn, amountIn, amountOut, minOut, createdAt: Date.now() };
  element('swap-quote').textContent = `Ожидается ${amount(tokenOut, amountOut)} ${symbol(tokenOut)}. Минимум: ${amount(tokenOut, minOut)} ${symbol(tokenOut)}.`;
  element('swap-fee').textContent = '0,3% уже учтено в котировке';
  setStatus('Котировка получена. Нажмите «Обменять» и подпишите заявку.');
}));

element('swap-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runWallet('Обмен токенов', 'Проверяем котировку…', [
    ...(isZk() ? proofChecklist() : []),
    checklist('sign:swap', 'Подписать обмен'),
    checklist('check:publication-queue', 'Проверить готовность пакета', true),
    ...publicationChecklist(true),
    ...balanceChecklist(),
  ], async (version) => {
    if (!balanceReady() || !registeredAccount() || !newActivityAllowed()) throw new Error('Загрузите доступный баланс выбранного пула перед обменом.');
    const quote = state.quote;
    if (!quote || Date.now() - quote.createdAt > 120_000) { invalidateQuote(); throw new Error('Получите свежую котировку.'); }
    requireExchangeBalance(quote.tokenIn, quote.amountIn);
    const receipt = await state.client.signedAction({ kind: 'swap', tokenIn: quote.tokenIn, amountIn: quote.amountIn.toString(), minOut: quote.minOut.toString() });
    guard(version);
    state.lastReceipt = receipt;
    state.disclosure = null;
    element('receipt-trade-id').value = receipt.tradeId.toString();
    renderDisclosure();
    invalidateQuote();
    const tokenOut = quote.tokenIn === 'RUBA' ? 'USDT' : 'RUBA';
    let publicationMessage = receipt.publication?.status === 'collecting'
      ? ` Публикация ожидает закрытия пакета: собрано ${receipt.publication.collected} из ${receipt.publication.required} сделок.`
      : receipt.publication?.status === 'published' ? ' Публикация в блокчейне подтверждена.' : ' Пакет ожидает подтверждения публикации.';
    const completed = isZk()
      ? `Обмен рассчитан сервером: ${amount(tokenOut, receipt.amountOut)} ${symbol(tokenOut)}. Сделка №${receipt.tradeId}. Баланс станет подтверждённым после принятия ZK-доказательства контрактом.`
      : `Обмен выполнен: получено ${amount(tokenOut, receipt.amountOut)} ${symbol(tokenOut)} на внутренний баланс. Сделка №${receipt.tradeId}.`;
    if (receipt.publication?.status === 'collecting') {
      if (state.publicationRequest?.status !== 'ready') {
        state.publicationRequest = { status: 'idle', request: null, progress: receipt.publication };
        state.publicationNotice = '';
        renderPublication();
      }
    } else if (receipt.batchId !== undefined && receipt.publication?.status !== 'published') {
      try {
        const offer = await refreshPublication(version);
        if (offer.status === 'ready' && offer.request?.batch.batchId.toString() === receipt.batchId.toString()) {
          const result = await sendPublication(version, offer.request, receipt, completed);
          publicationMessage = result?.status === 'published' || result?.status === 'already-published'
            ? ' Публикация в блокчейне подтверждена.'
            : result ? ' Результат публикации пока не подтверждён. Проверьте готовый пакет и статус транзакции в кошельке.'
              : ' Публикация не завершена. Повторите её кнопкой «Опубликовать пакет», не повторяя обмен.';
        } else if (offer.status === 'ready' && offer.request) {
          state.publicationNotice = `Сначала ожидает публикации более ранний пакет №${offer.request.batch.batchId}. Его можно опубликовать вручную; газ оплачивает отправитель.`;
          publicationMessage = ' Публикация ожидает более ранний пакет. Используйте отдельную панель публикации.';
          renderPublication();
        }
      } catch (error) {
        guard(version);
        state.publicationNotice = `Не удалось подготовить публикацию: ${errorMessage(error)} Обмен уже выполнен. Обновите готовый пакет и повторите только публикацию.`;
        publicationMessage = ' Публикация пока не подготовлена. Обновите готовый пакет; обмен повторять не нужно.';
        renderPublication();
      }
    }
    await refreshAfterSuccess(version, `${completed}${publicationMessage}`);
  });
});

async function refreshPublication(version) {
  const offer = await state.client.getPublicationRequest();
  guard(version);
  state.publicationRequest = offer;
  if (state.publicationResult?.status === 'submitted') {
    const confirmed = await state.client.batchAlreadyPublished(state.publicationResult.batch);
    guard(version);
    if (confirmed) {
      state.publicationResult = { ...state.publicationResult, status: 'published' };
      // Matching roots prove publication of this batch, but another sender may
      // have won the race while our submitted transaction reverted or vanished.
      delete state.publicationResult.transactionHash;
      for (const known of [state.lastReceipt, state.disclosure?.receipt]) {
        if (known?.batchId?.toString() === state.publicationResult.batchId.toString()) {
          known.publication = { status: 'published' };
        }
      }
      renderDisclosure();
      state.publicationNotice = `Публикация пакета №${state.publicationResult.batchId} подтверждена данными хранилища.`;
    } else if (state.publicationResult.transactionHash) {
      const mined = await state.provider.getTransactionReceipt(state.publicationResult.transactionHash);
      guard(version);
      if (mined) {
        state.publicationResult = { ...state.publicationResult, status: mined.status === 0 ? 'failed' : 'unconfirmed' };
        state.publicationNotice = mined.status === 0
          ? 'Транзакция публикации отклонена. Можно повторить публикацию готового пакета.'
          : 'Транзакция завершена, но нужный пакет ещё не подтверждён данными хранилища. Обновите очередь перед повторной отправкой.';
      } else state.publicationNotice = `Транзакция уже отправлена: ${state.publicationResult.transactionHash}. Дождитесь подтверждения сети.`;
    } else {
      // A transport error can hide the transaction hash. Require an explicit
      // refresh before allowing a manual retry; never repeat the swap or send.
      state.publicationResult = { ...state.publicationResult, status: 'unconfirmed' };
      state.publicationNotice = 'Результат предыдущей отправки неизвестен. Проверьте кошелёк перед повторной публикацией.';
    }
  } else state.publicationNotice = '';
  renderPublication();
  updateControls();
  return offer;
}

async function sendPublication(version, ticket, receipt, completed = '') {
  try {
    const result = await state.client.publishBatch(ticket, (message) => {
      if (version === state.version) setStatus(`${completed}${completed ? ' ' : ''}${message}`);
    }, receipt);
    guard(version);
    state.publicationResult = { ...result, publicationKey: publicationKey(ticket), batchId: ticket.batch.batchId,
      batch: ticket.kind === 'zk' ? { publicSignals: ticket.publicSignals } : ticket.batch };
    const accepted = result.status === 'published' || result.status === 'already-published';
    state.publicationNotice = accepted
      ? `${ticket.kind === 'zk' ? `ZK-переход №${ticket.publicSignals[1]}` : `Пакет №${ticket.batch.batchId}`} опубликован.${result.transactionHash ? ` Транзакция: ${result.transactionHash}` : ''}`
      : `Публикация пакета №${ticket.batch.batchId} пока не подтверждена.${result.transactionHash ? ` Транзакция: ${result.transactionHash}` : ' Результат отправки неизвестен.'} Проверьте статус в кошельке и обновите готовый пакет.`;
    for (const known of [state.lastReceipt, state.disclosure?.receipt]) {
      if (known?.batchId?.toString() === ticket.batch.batchId.toString()) {
        known.publication = { status: accepted ? 'published' : 'pending', ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}) };
      }
    }
    if (accepted) state.publicationRequest = { status: 'idle', request: null, progress: { collected: 0, required: 4 } };
    renderPublication();
    renderDisclosure();
    return result;
  } catch (error) {
    guard(version);
    state.publicationNotice = `Публикация не завершена: ${errorMessage(error)} Выполненные обмены сохранены. Повторите только публикацию пакета.`;
    renderPublication();
    return null;
  }
}

/** Publish only the immutable boundary selected by an exit or administrator. */
async function publishClosedTransitions(version, boundaryValue, initialOffer) {
  if (boundaryValue === null || boundaryValue === undefined) return { completed: true, published: 0 };
  if (!/^[1-9][0-9]*$/.test(String(boundaryValue))) throw new Error('Некорректная граница закрытого пакета.');
  const boundary = BigInt(boundaryValue);
  const seen = new Set();
  let offer = initialOffer;
  let published = 0;
  for (let step = 0; step < 32; step++) {
    offer ??= await refreshPublication(version);
    guard(version);
    if (offer.status !== 'ready') return { completed: offer.status === 'idle', published };
    const ticket = offer.request;
    if (ticket?.kind !== 'zk' || !/^[1-9][0-9]*$/.test(String(ticket.publicSignals?.[1]))) throw new Error('Ожидался готовый ZK-переход выбранного пула.');
    const nextVersion = BigInt(ticket.publicSignals[1]);
    if (nextVersion > boundary) return { completed: true, published };
    if (seen.has(nextVersion.toString())) return { completed: false, published };
    seen.add(nextVersion.toString());
    state.publicationRequest = offer;
    renderPublication();
    const result = await sendPublication(version, ticket);
    if (!result || !['published', 'already-published'].includes(result.status)) return { completed: false, published };
    published++;
    if (nextVersion === boundary) return { completed: true, published };
    offer = undefined;
  }
  return { completed: false, published };
}

element('publication-refresh').addEventListener('click', () => run('Проверка готового пакета…', async (version) => {
  try {
    await refreshPublication(version);
    setStatus('Очередь публикации обновлена.');
  } catch (error) {
    guard(version);
    state.publicationRequest = null;
    state.publicationNotice = `Не удалось проверить очередь: ${errorMessage(error)} Повторите обновление.`;
    renderPublication();
    setStatus('Обновление публикации не завершено. Выполненные обмены сохранены.');
  }
}));

element('publication-submit').addEventListener('click', () => runWallet('Публикация пакета', 'Готовим пакет…', publicationChecklist(), async (version) => {
  const ticket = state.publicationRequest?.status === 'ready' ? state.publicationRequest.request : null;
  if (!ticket) { setStatus('Сначала обновите готовый пакет.'); return; }
  if (state.publicationResult?.status === 'submitted' && (state.publicationResult.publicationKey ?? state.publicationResult.batchId?.toString()) === publicationKey(ticket)) {
    setStatus('Транзакция уже отправлена. Обновите готовый пакет и дождитесь подтверждения сети.'); return;
  }
  const ownReceipt = state.lastReceipt?.batchId?.toString() === ticket.batch.batchId.toString() ? state.lastReceipt : undefined;
  const result = await sendPublication(version, ticket, ownReceipt);
  setStatus(result?.status === 'published' || result?.status === 'already-published'
    ? 'Пакет опубликован. Выполненные обмены сохранены.'
    : result ? 'Публикация пока не подтверждена. Проверьте кошелёк и обновите готовый пакет. Обмены повторять не нужно.'
      : 'Публикация не завершена. Повторите только публикацию готового пакета.');
}));

element('receipt-trade-id').addEventListener('input', () => {
  state.disclosure = null;
  renderDisclosure();
  updateControls();
});

function downloadJson(value, filename) {
  const report = checklistReporter('local:save-file', 'local', 'Сохранить JSON');
  report('start');
  const link = document.createElement('a');
  let url;
  try {
    const blob = new Blob([JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    report('done');
  } catch (error) {
    report('error');
    throw error;
  } finally {
    link.remove();
    if (url) URL.revokeObjectURL(url);
  }
}

element('zk-proof-refresh').addEventListener('click', () => runWallet('Проверка доказательства баланса', 'Готовим запрос состояния…', proofChecklist(), async (version) => {
  const proof = await state.client.getZkState(); guard(version);
  state.snapshot ??= { balances: {}, withdrawals: [], lpShares: 0n };
  state.snapshot.zkProof = proof;
  state.snapshot.balances = { RUBA: proof.account[1], USDT: proof.account[2] };
  state.snapshot.lpShares = proof.account[3]; renderAccount();
  setStatus(proof.verified ? 'Доказательство баланса соответствует текущему Vault root.' : 'Локальный Merkle proof корректен, но состояние ещё ожидает ZK-публикацию.');
}));
element('zk-register').addEventListener('click', () => runWallet('Регистрация защищённого баланса', 'Проверяем счёт в Vault…', [
  ...registrationChecklist(),
  ...balanceChecklist(),
  checklist('check:publication-queue', 'Проверить очередь публикации'),
], async (version) => {
  if (!state.market?.whitelisted) throw new Error('Account is not whitelisted');
  await state.client.ensureZkRegistration((message) => { if (version === state.version) setStatus(message); });
  guard(version); await refreshAccount(version); await refreshPublication(version);
  setStatus(provenWithdrawals() ? 'Регистрация доказана в Vault. Пополнение доступно, пока кошелёк находится в whitelist.' : 'Регистрация принята сервером. Опубликуйте готовый ZK-переход; повторная регистрация не требуется.');
}));
element('zk-backup-export').addEventListener('click', () => runWallet('Резервная копия', 'Готовим данные для копии…', [
  ...proofChecklist(),
  checklist('sign:recovery-key', 'Подписать создание ключа восстановления', true),
  checklist('local:save-file', 'Сохранить резервную копию'),
], async (version) => {
  const backup = await state.client.exportZkBackup(); guard(version);
  downloadJson(backup, 'ruba-owner-backup.json');
  setStatus('Копия сохранена. Файл содержит ключ просмотра, приватные балансы и открытия прав выплаты. Для нового доказательства нужен prover; автономный аварийный выход не реализован.');
}));
element('zk-backup-import').addEventListener('change', () => run('Проверка резервной копии…', async (version) => {
  const file = element('zk-backup-import').files?.[0];
  if (!file) return;
  if (file.size > 1_048_576) throw new Error('Резервная копия должна быть не больше 1 МиБ.');
  const proof = await state.client.importZkBackup(await file.text()); guard(version);
  const missingOpenings = (BigInt(proof.account[5]) > 0n || BigInt(proof.account[6]) > 0n) && !state.client.withdrawalClaims?.length;
  setStatus((proof.verified ? 'Копия проверена против актуального корня Vault. Операции не отправлялись.' : 'Копия восстановлена локально; её root отличается от актуального. Обновите доказательство. Операции не отправлялись.')
    + (missingOpenings ? ' В копии есть pending-баланс, но нет открытий прав выплаты. Для погашения нужны сохранённые nonce и salt; account proof их не восстанавливает.' : ''));
}));
element('zk-recover-chain').addEventListener('click', () => runWallet('Восстановление из блокчейна', 'Готовим данные для восстановления…', [
  checklist('sign:recovery-key', 'Подписать создание ключа восстановления', true),
  checklist('check:recover-chain', 'Прочитать подтверждённые переходы из блокчейна'),
  checklist('local:save-file', 'Сохранить восстановленную копию'),
], async (version) => {
  const { backup, proof } = await state.client.recoverZkFromChain((message) => { if (version === state.version) setStatus(message); });
  guard(version);
  state.snapshot ??= { balances: {}, withdrawals: [], lpShares: 0n };
  state.snapshot.zkProof = proof;
  state.snapshot.balances = { RUBA: proof.account[1], USDT: proof.account[2] };
  state.snapshot.lpShares = proof.account[3];
  renderAccount(); downloadJson(backup, 'ruba-zk-account-backup.json');
  setStatus('Баланс и Merkle proof восстановлены из опубликованных данных и проверены против Vault. Сервер не использовался, операции не отправлялись.');
}));

async function loadDisclosure(version) {
  const tradeId = element('receipt-trade-id').value.trim();
  if (!/^[1-9][0-9]*$/.test(tradeId)) throw new Error('Укажите положительный номер своей сделки.');
  let bundle;
  try { bundle = await state.client.getDisclosure(tradeId); }
  catch (error) {
    guard(version);
    if (error?.status === 409) {
      state.disclosure = null;
      renderDisclosure();
      setStatus(`Сделка уже выполнена, квитанция ожидает закрытия пакета. ${error.message}`);
      return null;
    }
    throw error;
  }
  guard(version);
  state.disclosure = bundle;
  renderDisclosure();
  return bundle;
}

element('receipt-export-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runWallet('Загрузка квитанции', 'Готовим запрос квитанции…', [
    checklist('sign:disclosure', 'Подписать запрос квитанции для раскрытия'),
  ], async (version) => {
    if (state.needsRefresh) throw new Error('Сначала обновите данные.');
    const bundle = await loadDisclosure(version);
    if (bundle) setStatus('Квитанция загружена. Скачайте JSON и откройте его на странице раскрытия.');
  });
});

element('receipt-download').addEventListener('click', () => {
  const tradeId = element('receipt-trade-id').value.trim();
  const cached = state.disclosure?.receipt?.tradeId?.toString() === tradeId ? state.disclosure : null;
  return runWallet('Скачивание квитанции', 'Готовим квитанцию…', [
    ...(cached ? [] : [checklist('sign:disclosure', 'Подписать запрос квитанции для раскрытия')]),
    checklist('local:save-file', 'Сохранить квитанцию в JSON'),
  ], async (version) => {
    if (state.needsRefresh) throw new Error('Сначала обновите данные.');
    const bundle = cached ?? await loadDisclosure(version);
    guard(version);
    if (!bundle) return;
    downloadJson(bundle, `ruba-trade-${bundle.receipt.tradeId}.json`);
    setStatus('Квитанция скачана. Передайте JSON для раскрытия выбранной сделки.');
  });
});

element('liquidity-add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runWallet('Добавление ликвидности', 'Проверяем суммы и баланс…', [
    checklist('check:liquidity-balance', 'Проверить суммы и баланс обменника'),
    ...(isZk() ? proofChecklist() : []),
    checklist('sign:addLiquidity', 'Подписать добавление ликвидности'),
    ...balanceChecklist(),
  ], async (version) => {
    const report = checklistReporter('check:liquidity-balance', 'check', 'Проверить суммы и баланс обменника');
    report('start');
    if (!balanceReady() || !registeredAccount() || !newActivityAllowed()) throw new Error('Загрузите доступный баланс выбранного пула перед добавлением ликвидности.');
    const rubaDesired = enteredAmount('liquidity-ruba', 'RUBA');
    const usdtDesired = enteredAmount('liquidity-usdt', 'USDT');
    const rubaMin = enteredAmount('liquidity-ruba-min', 'RUBA', true);
    const usdtMin = enteredAmount('liquidity-usdt-min', 'USDT', true);
    if (rubaMin > rubaDesired || usdtMin > usdtDesired) throw new Error('Минимальная сумма токена не может превышать желаемую.');
    const { RUBA: ruba, USDT: usdt } = state.snapshot.balances;
    // The AMM uses the full desired amount of one token and may use less of the other.
    // With both maxima above the balance, there is no feasible pair at any pool ratio.
    if (rubaDesired > BigInt(ruba) && usdtDesired > BigInt(usdt)) {
      throw new Error(`На балансе обменника доступно ${tokenAmount('RUBA', ruba)} и ${tokenAmount('USDT', usdt)}. Уменьшите суммы или пополните баланс в разделе «Мой баланс».`);
    }
    requireExchangeBalance('RUBA', rubaMin || 1n);
    requireExchangeBalance('USDT', usdtMin || 1n);
    report('done');
    const operation = {
      kind: 'addLiquidity',
      rubaDesired: rubaDesired.toString(), usdtDesired: usdtDesired.toString(),
      rubaMin: rubaMin.toString(), usdtMin: usdtMin.toString(),
    };
    const result = await state.client.signedAction(operation);
    guard(version);
    invalidateQuote();
    const amounts = `${tokenAmount('RUBA', result.rubaAmount)} и ${tokenAmount('USDT', result.usdtAmount)}. LP-доли: ${formatAmount(result.shares, 18)}.`;
    await refreshAfterSuccess(version, isZk()
      ? `Внесение рассчитано: ${amounts} Для подтверждения в блокчейне опубликуйте готовый переход в разделе «Обмен».`
      : `В пул внесено ${amounts}`);
  });
});

element('liquidity-remove-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runWallet('Снятие ликвидности', 'Проверяем запрос…', [
    ...(isZk() ? proofChecklist() : []),
    checklist('sign:removeLiquidity', 'Подписать снятие ликвидности'),
    ...(isZk() ? [checklist('sequence:publication', 'Опубликовать готовые ZK-переходы', true)] : []),
    ...balanceChecklist(),
  ], async (version) => {
    if (!balanceReady() || !registeredAccount()) throw new Error('Загрузите баланс выбранного пула перед снятием ликвидности.');
    const shares = parseAmount(element('liquidity-shares').value, 18);
    const available = BigInt(state.snapshot.lpShares);
    if (shares > available) throw new Error(`Доступно ${formatAmount(available, 18)} LP-долей. Уменьшите сумму снятия.`);
    const result = await state.client.signedAction({
      kind: 'removeLiquidity',
      shares: shares.toString(),
      rubaMin: enteredAmount('liquidity-remove-ruba-min', 'RUBA', true).toString(),
      usdtMin: enteredAmount('liquidity-remove-usdt-min', 'USDT', true).toString(),
    });
    guard(version);
    invalidateQuote();
    let publicationMessage = '';
    if (isZk() && result.closedThroughStateVersion !== undefined) {
      try {
        const publication = await runPublicationChecklist(version, result.closedThroughStateVersion);
        publicationMessage = publication.completed ? ' Снятие LP подтверждено в блокчейне.' : ' Пакет закрыт. Продолжите публикацию через панель готового пакета; повторять снятие LP не нужно.';
      } catch (error) {
        guard(version);
        state.publicationNotice = `Не удалось подготовить публикацию: ${errorMessage(error)} Повторите только публикацию, снятие LP уже сохранено.`;
        renderPublication();
        publicationMessage = ' Снятие LP сохранено. Обновите готовый пакет и продолжите публикацию; повторять снятие не нужно.';
      }
    }
    await refreshAfterSuccess(version, `На внутренний баланс рассчитано ${amount('RUBA', result.rubaAmount)} ${symbol('RUBA')} и ${amount('USDT', result.usdtAmount)} ${symbol('USDT')}.${publicationMessage} Вывести их можно на странице «Баланс».`);
  });
});

element('deposit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const token = element('deposit-token').value;
  const currency = symbol(token);
  void runWallet('Пополнение баланса', 'Проверяем параметры пополнения…', [
    checklist('check:deposit-admission', 'Проверить допуск к пополнению и паузу рынка'),
    ...(isZk() ? registrationChecklist() : []),
    ...(provenWithdrawals() ? [checklist('check:registered-vault', 'Проверить регистрацию баланса в Vault')] : []),
    checklist('check:allowance', `Проверить разрешённую сумму ${currency}`),
    checklist('tx:reset-allowance', `Сбросить разрешение на перевод ${currency}`, true),
    checklist('tx:approve', `Разрешить перевод ${currency}`, true),
    checklist('tx:deposit', `Пополнить баланс обменника в ${currency}`),
    ...balanceChecklist(),
  ], async (version) => {
    if (!balanceReady() || !fundingAllowed()) throw new Error('Загрузите доступный баланс выбранного пула перед пополнением.');
    const value = enteredAmount('deposit-amount', token);
    const available = state.walletBalances?.[token];
    if (available !== undefined && value > BigInt(available)) {
      throw new Error(`Для пополнения нужно ${tokenAmount(token, value)}. В кошельке доступно ${tokenAmount(token, available)}. Уменьшите сумму или получите тестовые токены.`);
    }
    await state.client.deposit(token, value, (message) => { if (version === state.version) setStatus(message); });
    guard(version);
    await refreshAfterSuccess(version, 'Транзакция пополнения подтверждена в сети.');
  });
});

element('withdraw-token').addEventListener('change', updateControls);
element('withdraw-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runWallet('Вывод токенов', 'Проверяем запрос на вывод…', [
    ...(isZk() ? proofChecklist() : []),
    checklist('sign:withdraw', 'Подписать резервирование средств для вывода'),
    ...withdrawalChecklist(),
    ...balanceChecklist(),
  ], async (version) => {
    const client = state.client;
    const token = element('withdraw-token').value;
    if (!balanceReady() || !registeredAccount()) throw new Error('Загрузите баланс выбранного пула перед выводом.');
    if (state.market.withdrawalsPaused[token]) throw new Error(`Вывод ${symbol(token)} приостановлен.`);
    const value = enteredAmount('withdraw-amount', token);
    requireExchangeBalance(token, value);
    const ticket = await client.signedAction({ kind: 'withdraw', token, amount: value.toString() });
    guard(version);
    // Reservation is already durable. If the wallet transaction is cancelled,
    // the existing ticket is recovered from the pending list without a second debit.
    setStatus('Сумма зарезервирована. Подтвердите выплату в кошельке.');
    try {
      const result = await client.redeemWithdrawal(ticket, (message) => { if (version === state.version) setStatus(message); });
      guard(version);
      if (provenWithdrawals()) { await refreshAfterSuccess(version, payoutResultMessage(result)); return; }
    } catch (error) {
      if (version === state.version) {
        try { await refreshAccount(version); } catch { /* Keep the original payout error visible. */ }
        setStatus('Заявка сохранена. Повторите выплату из списка ожидающих заявок.');
      }
      if (error instanceof SessionChanged) throw error;
      throw new Error(`Выплата не завершена. Заявка сохранена — повторите выплату из списка ожидающих заявок. ${errorMessage(error)}`);
    }
    await refreshAfterSuccess(version, 'Выплата отправлена. Баланс обновится после подтверждения сети.');
  });
});

function renderTokenMetadata() {
  const label = pairLabel();
  document.title = state.config ? `Solid · ${label}` : 'Solid';
  element('pool-pair-label').textContent = label;
  for (const node of document.querySelectorAll('[data-token-symbol]')) node.textContent = symbol(node.dataset.tokenSymbol);
}

function renderMarketCatalog() {
  element('market-cards').replaceChildren(); state.marketButtons = [];
  if (!state.catalog) return;
  const assetNames = { WETH: 'Wrapped Ether', WBTC: 'Wrapped BTC' };
  for (const market of state.catalog.markets) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'secondary';
    const title = document.createElement('span');
    title.className = 'market-card-title';
    title.textContent = `${market.base.symbol} / ${market.quote.symbol}`;
    card.append(title);
    const assets = [market.base.symbol, market.quote.symbol];
    if (assets.some((token) => Object.hasOwn(assetNames, token))) {
      const description = document.createElement('span');
      description.className = 'market-card-description';
      description.textContent = assets.map((token) => assetNames[token] ?? token).join(' / ');
      card.append(description);
    }
    card.dataset.marketId = market.id;
    card.setAttribute('aria-pressed', String(market.id === state.selectedMarketId));
    card.addEventListener('click', () => selectMarket(market.id));
    state.marketButtons.push(card); element('market-cards').append(card);
  }
}

function renderReferencePrices() {
  for (const token of ['RUBA', 'USDT', 'WETH', 'WBTC']) {
    element(`reference-${token.toLowerCase()}`).value = state.catalog.control.prices[token];
  }
}

async function selectMarket(id, initial = false) {
  if (!state.catalog || (!initial && (state.busy || !state.consent))) return;
  const chosen = state.catalog.markets.find((market) => market.id === id);
  if (!chosen) { setError('Неизвестный рынок.'); return; }
  if (!initial && state.selectedMarketId === id && state.config && (!state.account || state.client)) return;
  const version = ++state.version;
  state.operationId += 1;
  state.client?.dispose?.(); state.client = null;
  state.busy = true; state.config = null; state.selectedMarketId = id; state.scopedFetch = scopedMarketFetch(id);
  state.market = null; state.snapshot = null; state.walletBalances = null; state.dashboard = null; state.monitor = null;
  clearVaultAdmin();
  state.accountError = ''; state.publicAccountError = ''; state.publicAccountLoading = false; state.balanceLoading = false;
  state.needsRefresh = Boolean(state.account && state.consent); state.dashboardSettingsRevision = null;
  clearDisclosure(); invalidateQuote(); setError();
  element('admin-monitor-result').textContent = 'Приватный monitor ещё не запрошен.';
  element('batch-close-result').textContent = 'Пакет ещё не запрашивался.';
  element('arbitrage-enabled').checked = false;
  element('arbitrage-delay').value = '';
  for (const name of ['swap-amount', 'liquidity-ruba', 'liquidity-usdt', 'liquidity-shares', 'deposit-amount', 'withdraw-amount']) element(name).value = '';
  for (const name of ['liquidity-ruba-min', 'liquidity-usdt-min', 'liquidity-remove-ruba-min', 'liquidity-remove-usdt-min']) element(name).value = '0';
  for (const name of ['swap-token-in', 'deposit-token', 'withdraw-token', 'faucet-token']) element(name).value = 'RUBA';
  renderMarketCatalog(); renderAccount(); renderWallet(); renderTokenMetadata(); updateControls();
  setStatus('Загружаем выбранный пул…');
  let candidateClient;
  try {
    const config = await loadConfig(state.scopedFetch); guard(version);
    if (BigInt(config.chainId) !== BigInt(chosen.chainId) || config.vaultAddress.toLowerCase() !== chosen.vault.toLowerCase()) throw new Error('Конфигурация относится к другому Vault каталога.');
    for (const [key, asset] of [['RUBA', chosen.base], ['USDT', chosen.quote]]) {
      if (config.tokens[key].address.toLowerCase() !== asset.address.toLowerCase() || config.tokens[key].decimals !== asset.decimals
        || config.tokens[key].symbol !== asset.symbol) throw new Error('Активы выбранного рынка не совпадают с каталогом.');
    }
    state.config = config; renderTokenMetadata();
    if (state.provider && state.account) {
      const signer = state.signer ?? await waitForWallet(state.provider.getSigner()); guard(version);
      candidateClient = new RubaClient(config, state.provider, signer, {
        fetchImpl: state.scopedFetch,
        onWalletStep: (step) => { if (state.client === candidateClient) recordWalletStep(step); },
      });
      await waitForWallet(candidateClient.assertContext()); guard(version);
      state.client = candidateClient;
    }
    renderWallet(); renderAccount();
    // Pool selection never disconnects the wallet or waits for a private
    // signature. Public reads/chart refresh independently of the form layout.
    if (state.client && state.consent) void refreshPublicAccount(version);
    if (state.client && state.page === 'admin') void refreshVaultAdmin(version);
    void refreshDashboard(version).catch((error) => {
      if (version === state.version) element('dashboard-source').textContent = `Не удалось обновить принятые цены. ${errorMessage(error)} Нажмите «Обновить принятые цены».`;
    });
    guard(version);
    setStatus('');
    globalThis.history?.replaceState?.(null, '', `${location.pathname || '/'}?market=${id}${location.hash || ''}`);
  } catch (error) {
    if (!(error instanceof SessionChanged) && version === state.version) {
      setError(errorMessage(error));
      setStatus('Не удалось открыть выбранный пул.');
    }
  } finally {
    if (candidateClient && candidateClient !== state.client) candidateClient.dispose?.();
    if (version === state.version) { state.busy = false; updateControls(); }
  }
}

async function refreshDashboard(version = state.version) {
  if (!state.catalog || !state.selectedMarketId) return;
  const id = state.selectedMarketId;
  const dashboard = await loadDashboard(id); guard(version);
  if (id !== state.selectedMarketId) return;
  state.dashboard = dashboard; renderDashboard();
  if (state.dashboardSettingsRevision !== dashboard.settingsRevision) {
    element('arbitrage-enabled').checked = dashboard.arbitrage.enabled;
    element('arbitrage-delay').value = String(dashboard.arbitrage.delaySeconds);
    state.dashboardSettingsRevision = dashboard.settingsRevision;
  }
  updateControls();
}

const priceChartSvg = element('market-chart');
const priceChartPeriod = element('market-chart-period');
const priceChartHeight = 264;
let priceChartView = null;
let priceChartSelection = null;

function chartNode(parent, tag, attributes, label) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (label) node.textContent = label;
  parent.append(node);
  return node;
}

function selectChartPrice(index, timestamp, remember = true) {
  const view = priceChartView;
  const point = view?.scale.points[index];
  if (!point) return;
  view.index = index;
  if (remember) priceChartSelection = { marketId: view.marketId, version: point.stateVersion, timestamp };
  const x = view.scale.x(timestamp);
  view.cursor.setAttribute('x1', x);
  view.cursor.setAttribute('x2', x);
  view.marker.setAttribute('cx', x);
  view.marker.setAttribute('cy', point.spotY);
  const takenAt = timestamp === point.timestamp ? '' : ` · Опубликовано ${formatChartTimestamp(point.timestamp)}`;
  const block = point.blockNumber === undefined ? '' : ` · Блок ${point.blockNumber}`;
  const reading = `${formatChartTimestamp(timestamp)} · ${point.spot.replace('.', ',')} ${view.unit}${takenAt}${block}`;
  const output = element('market-chart-reading');
  if (output.textContent !== reading) output.textContent = reading;
}

function renderPriceChart(marketId, history, target, unit) {
  if (priceChartView?.marketId !== marketId) priceChartSelection = null;
  const measured = priceChartSvg.getBoundingClientRect?.().width;
  const width = Math.max(220, Math.floor(measured || priceChartView?.width || 600));
  const windowSeconds = priceChartPeriod.value === 'all' ? Infinity : Number(priceChartPeriod.value || 900);
  const bounds = {
    left: width < 360 ? 65 : 84, right: width - 18, top: 28, bottom: priceChartHeight - 36,
    tickCount: width < 380 ? 3 : 5, windowSeconds,
  };
  const scale = timeChartScale(history.map((point) => ({ ...point, target })), bounds);
  priceChartView = { marketId, history, target, unit, width, scale };
  priceChartSvg.replaceChildren();
  priceChartSvg.setAttribute('viewBox', `0 0 ${width} ${priceChartHeight}`);
  const empty = scale.points.length === 0;
  priceChartSvg.hidden = empty;
  priceChartPeriod.disabled = empty;
  priceChartSvg.setAttribute('tabindex', empty ? '-1' : '0');
  element('market-chart-reading').hidden = empty;
  element('market-chart-note').textContent = empty
    ? 'Подтверждённых цен пока нет.'
    : `Время МСК. ${Number.isFinite(windowSeconds) ? 'Период отсчитан от последней публикации. ' : ''}Стрелки ← → переключают публикации.`;
  if (empty) {
    element('market-chart-reading').textContent = '';
    return;
  }

  const { left, right, top, bottom } = bounds;
  const plot = chartNode(priceChartSvg, 'g', { 'aria-hidden': 'true' });
  for (const tick of scale.priceTicks) {
    chartNode(plot, 'line', { x1: left, y1: tick.y, x2: right, y2: tick.y, class: 'chart-grid' });
    chartNode(plot, 'text', { x: left - 8, y: tick.y + 4, 'text-anchor': 'end', class: 'chart-tick' }, tick.label);
  }
  for (const tick of scale.timeTicks) {
    chartNode(plot, 'line', { x1: tick.x, y1: top, x2: tick.x, y2: bottom, class: 'chart-grid' });
    const anchor = tick.x <= left + 25 ? 'start' : tick.x >= right - 25 ? 'end' : 'middle';
    chartNode(plot, 'text', { x: tick.x, y: bottom + 19, 'text-anchor': anchor, class: 'chart-tick' }, tick.label);
  }
  chartNode(plot, 'line', { x1: left, y1: bottom, x2: right, y2: bottom, class: 'chart-axis' });
  chartNode(plot, 'text', { x: left, y: 16, class: 'chart-axis-label' }, unit);
  const targetY = scale.y(target);
  chartNode(plot, 'line', { x1: left, y1: targetY, x2: right, y2: targetY, class: 'target-line' });
  if (scale.spotPath) chartNode(plot, 'path', { d: scale.spotPath, class: 'amm-line' });
  for (const point of scale.points) {
    chartNode(plot, 'circle', { cx: point.x, cy: point.spotY, r: 3, class: 'chart-point' });
  }
  priceChartView.cursor = chartNode(plot, 'line', { y1: top, y2: bottom, class: 'chart-cursor' });
  priceChartView.marker = chartNode(plot, 'circle', { r: 5, class: 'chart-selected' });
  const selected = priceChartSelection;
  const index = selected ? scale.points.findIndex((point) => point.stateVersion === selected.version) : -1;
  if (index >= 0) selectChartPrice(index, Math.min(selected.timestamp, scale.points.at(-1).timestamp), false);
  else selectChartPrice(scale.points.length - 1, scale.points.at(-1).timestamp, false);
}

function inspectChartPointer(event) {
  const view = priceChartView;
  if (!view?.scale.points.length || (event.type === 'pointermove' && event.pointerType === 'touch')) return;
  const rect = priceChartSvg.getBoundingClientRect();
  if (!rect.width) return;
  const timestamp = view.scale.timeFromX((event.clientX - rect.left) * view.width / rect.width);
  const points = view.scale.points;
  const inspected = Math.max(points[0].timestamp, Math.min(points.at(-1).timestamp, Math.round(timestamp)));
  selectChartPrice(points.findLastIndex((point) => point.timestamp <= inspected), inspected);
}

priceChartSvg.addEventListener('pointermove', inspectChartPointer);
priceChartSvg.addEventListener('pointerdown', inspectChartPointer);
priceChartPeriod.addEventListener('change', () => {
  const view = priceChartView;
  if (!view) return;
  priceChartSelection = null;
  renderPriceChart(view.marketId, view.history, view.target, view.unit);
});
priceChartSvg.addEventListener('keydown', (event) => {
  const view = priceChartView;
  if (!view?.scale.points.length) return;
  const last = view.scale.points.length - 1;
  const indexes = { ArrowLeft: Math.max(0, view.index - 1), ArrowRight: Math.min(last, view.index + 1), Home: 0, End: last };
  if (!Object.hasOwn(indexes, event.key)) return;
  event.preventDefault();
  const index = indexes[event.key];
  selectChartPrice(index, view.scale.points[index].timestamp);
});

if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(() => {
    const view = priceChartView;
    const width = Math.floor(priceChartSvg.getBoundingClientRect().width);
    if (view?.scale.points.length && width > 0 && Math.max(220, width) !== view.width) {
      renderPriceChart(view.marketId, view.history, view.target, view.unit);
    }
  });
  observer.observe(priceChartSvg);
}

function renderDashboard() {
  element('market-dashboard').hidden = !state.catalog || !state.consent;
  if (!state.catalog) return;
  const dashboard = state.dashboard, accepted = dashboard?.accepted;
  const unit = `${symbol('USDT')} за 1 ${symbol('RUBA')}`;
  element('dashboard-spot').textContent = accepted ? `${compactChartPrice(accepted.spot)} ${unit}` : 'Принятой ликвидности пока нет';
  element('dashboard-target').textContent = accepted ? `${compactChartPrice(accepted.target)} ${unit}` : '—';
  element('dashboard-spot').title = accepted ? `${accepted.spot.replace('.', ',')} ${unit}` : '';
  element('dashboard-target').title = accepted ? `${accepted.target.replace('.', ',')} ${unit}` : '';
  const bps = accepted ? BigInt(accepted.deviationBps) : 0n;
  element('dashboard-deviation').textContent = accepted ? `${bps < 0n ? '−' : '+'}${formatAmount(bps < 0n ? -bps : bps, 2)}%` : '—';
  element('dashboard-source').textContent = accepted
    ? `Последнее подтверждённое состояние в блоке ${accepted.blockNumber}. Ориентир задан вручную.`
    : 'Публичная история появится после подтверждения состояния пула в блокчейне.';
  const bot = dashboard?.arbitrage;
  element('arbitrage-status').textContent = bot ? `Бот: ${{ disabled: 'выключен', idle: 'ожидание', scheduled: 'ожидает задержку', waiting: 'ожидает условия', executing: 'выравнивает', publishing: 'публикует proof', error: 'ошибка' }[bot.status] ?? bot.status}. Задержка ${bot.delaySeconds} с.${bot.nextRunAt ? ` Следующий запуск: ${new Date(bot.nextRunAt).toLocaleTimeString('ru-RU')}.` : ''}${bot.message ? ` ${bot.message}` : ''}${bot.error ? ` ${bot.error}` : ''}` : 'Статус бота ещё не загружен.';
  const receipt = state.lastReceipt;
  let overlay = [];
  if (receipt && state.config && receipt.publication?.status !== 'published'
    && ['reserveRubaBefore', 'reserveUsdtBefore', 'reserveRubaAfter', 'reserveUsdtAfter'].every((name) => receipt[name] !== undefined)) {
    const before = poolSpot(receipt.reserveRubaBefore, receipt.reserveUsdtBefore, tokenDecimals('RUBA'), tokenDecimals('USDT'));
    const after = poolSpot(receipt.reserveRubaAfter, receipt.reserveUsdtAfter, tokenDecimals('RUBA'), tokenDecimals('USDT'));
    if (before && after && before !== '0' && after !== '0') overlay = [before, after];
  }
  element('own-price-preview').textContent = overlay.length ? `Только ваша квитанция №${receipt.tradeId}: ${overlay[0]} → ${overlay[1]} ${unit}. Предварительный частный расчёт, его принятие проверяется отдельно; это не текущая публичная цена.` : '';
  renderPriceChart(state.selectedMarketId, accepted?.history ?? [], accepted?.target, unit);
}

function sendDemoCommand(command, version) {
  const operation = state.walletOperation;
  return sendControl({
    provider: state.provider, signer: state.signer, command, isCurrent: () => version === state.version,
    onWalletStep: (step) => { if (state.walletOperation === operation && version === state.version) recordWalletStep(step); },
  });
}

async function adminCommand(command, version) {
  if (!isAdmin()) throw new Error('Изменять настройки может администратор демо-рынков.');
  const response = await sendDemoCommand(command, version);
  guard(version);
  if (command.kind === 'monitor') {
    const monitor = response.result;
    if (monitor?.marketId !== state.selectedMarketId || monitor.source !== 'private-current' || monitor.accepted !== false) throw new Error('Получен monitor другого рынка.');
    state.monitor = monitor;
    element('admin-monitor-result').textContent = `Приватный текущий снимок, не принятое состояние: ${amount('RUBA', monitor.reserve0)} ${symbol('RUBA')} / ${amount('USDT', monitor.reserve1)} ${symbol('USDT')}. AMM ${monitor.spot}, ориентир ${monitor.target}, отклонение ${monitor.deviationBps} bps.`;
  }
  const catalog = await loadMarkets(); guard(version); state.catalog = catalog;
  if (command.kind === 'prices') renderReferencePrices();
  await refreshDashboard(version); updateControls();
  setStatus(command.kind === 'monitor' ? 'Приватный monitor получен по подписи администратора. Публичный график не изменён.' : 'Подписанные настройки сохранены.');
}

element('dashboard-refresh').addEventListener('click', () => run('Обновление принятого состояния…', async (version) => {
  if (!state.consent) throw new Error('Сначала подтвердите вход.');
  await refreshDashboard(version); setStatus('Принятые цены обновлены.');
}, false));
element('reference-prices-form').addEventListener('submit', (event) => { event.preventDefault(); void runWallet('Изменение ручных цен', 'Готовим настройки…', [
  checklist('sign:demo-prices', 'Подписать новые ориентиры цен'),
], (version) => adminCommand({ kind: 'prices',
  prices: Object.fromEntries(['RUBA', 'USDT', 'WETH', 'WBTC'].map((token) => [token, element(`reference-${token.toLowerCase()}`).value.trim()])) }, version)); });
element('arbitrage-form').addEventListener('submit', (event) => { event.preventDefault(); void runWallet('Настройки бота', 'Готовим настройки…', [
  checklist('sign:demo-arbitrage', 'Подписать настройки бота'),
], (version) => adminCommand({ kind: 'arbitrage',
  marketId: state.selectedMarketId, enabled: element('arbitrage-enabled').checked, delaySeconds: Number(element('arbitrage-delay').value) }, version)); });
element('private-monitor').addEventListener('click', () => runWallet('Текущее состояние пула', 'Готовим запрос…', [
  checklist('sign:demo-monitor', 'Разрешить чтение состояния пула'),
], (version) => adminCommand({ kind: 'monitor', marketId: state.selectedMarketId }, version)));
element('close-current-batch').addEventListener('click', () => runWallet('Закрытие пакета', 'Проверяем пакет…', [
  checklist('sign:demo-closeBatch', 'Подписать закрытие текущего пакета'),
  checklist('sequence:publication', 'Опубликовать готовые ZK-переходы', true),
], async (version) => {
  if (!isZk() || !state.catalog || state.account?.toLowerCase() !== state.catalog.control.admin.toLowerCase()) throw new Error('Закрыть пакет может только администратор выбранного ZK-рынка.');
  const marketId = state.selectedMarketId;
  const response = await sendDemoCommand({ kind: 'closeBatch', marketId }, version);
  guard(version);
  const result = response.result;
  if (!result || result.marketId !== marketId) throw new Error('Получен результат закрытия другого рынка.');
  const catalog = await loadMarkets(); guard(version); state.catalog = catalog;
  let message;
  if (result.closedThroughStateVersion === null) {
    message = 'Нет ожидающих операций: закрывать и публиковать нечего.';
  } else if (result.preparationError || !result.publication) {
    message = 'Пакет закрыт. Подготовка доказательства пока не завершена. Нажмите «Обновить готовый пакет» и повторите только публикацию.';
  } else {
    const publication = await runPublicationChecklist(version, result.closedThroughStateVersion, result.publication);
    guard(version);
    message = publication.completed
      ? `Закрытые переходы до №${result.closedThroughStateVersion} опубликованы. Квитанции доступны для отдельного раскрытия.`
      : 'Пакет закрыт и сохранён. Продолжите публикацию через панель готового пакета; повторять закрытие не нужно.';
  }
  element('batch-close-result').textContent = message;
  await refreshDashboard(version);
  setStatus(message);
}));
element('faucet-submit').addEventListener('click', () => runWallet(`Получение ${symbol(element('faucet-token').value)}`, 'Проверяем доступность крана…', [
  checklist('check:faucet', 'Проверить доступность крана'),
  checklist('tx:faucet', `Получить тестовые ${symbol(element('faucet-token').value)} на кошелёк`),
], async (version) => {
  const token = element('faucet-token').value;
  const result = await state.client.faucet(token, (message) => { if (version === state.version) setStatus(message); }); guard(version);
  state.walletBalances = await state.client.getWalletBalances(); guard(version); renderAccount();
  setStatus(`Получено ${amount(token, result.amount)} тестовых ${symbol(token)} в кошелёк. Пополните выбранный Vault отдельно; кран доступен раз в 60 секунд.`);
}));

window.addEventListener('hashchange', () => {
  const previousPage = state.page;
  route();
  if (state.page !== previousPage && !state.busy && element('error').textContent) {
    setError();
    setStatus();
  }
});

renderAccount();
renderWallet();
invalidateQuote();
route();
async function initializeMarkets() {
  const catalog = typeof loadMarkets === 'function' ? await loadMarkets() : null;
  state.catalog = catalog;
  if (catalog) {
    renderReferencePrices();
    const requested = /(?:^\?|&)market=([a-z0-9-]+)(?:&|$)/.exec(globalThis.location?.search ?? '')?.[1];
    const id = catalog.markets.some((market) => market.id === requested) ? requested : catalog.defaultMarketId;
    await selectMarket(id, true);
    if (typeof setInterval === 'function') setInterval(() => {
      if (!state.catalog || !state.selectedMarketId) return;
      refreshDashboard().catch((error) => { if (!(error instanceof SessionChanged)) element('dashboard-source').textContent = `Принятые цены недоступны: ${errorMessage(error)}`; });
    }, 10_000);
    return;
  }
  const config = await loadConfig();
  state.config = config;
  element('tenderly-setup-link').hidden = !config.setupAvailable;
  renderAccount();
  renderWallet();
  renderTokenMetadata();
  setStatus('');
}
initializeMarkets().catch((error) => {
  setError(errorMessage(error));
  setStatus('Не удалось загрузить параметры приложения. Проверьте, запущен ли сервер.');
});
