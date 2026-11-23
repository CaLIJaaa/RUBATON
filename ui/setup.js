const element = (id) => document.getElementById(id);
let csrfToken = '';
let busy = false;
let canResume = false;
let polling;
let statusRequest = false;
let submitting = false;
let clearAdminAfterReady = false;

function showError(message = '') {
  element('setup-error').textContent = message;
  element('setup-error').hidden = !message;
}

function updateControls() {
  element('setup-fields').disabled = busy || submitting;
  element('setup-submit').disabled = busy || submitting || statusRequest || !csrfToken;
  element('setup-resume').hidden = !canResume;
  element('setup-resume').disabled = busy || submitting || statusRequest || !csrfToken;
  element('setup-refresh').disabled = statusRequest || submitting;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос. Обновите статус и попробуйте ещё раз.';
}

async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { cache: 'no-store', ...options }); }
  catch { throw new Error('Сервер настройки недоступен. Проверьте, что npm run tenderly запущен, и нажмите «Обновить статус».'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Сервер вернул неожиданный ответ. Обновите статус.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось выполнить запрос. Обновите статус.');
  return data;
}

function renderStatus(data) {
  if (!data || typeof data.csrfToken !== 'string' || !['idle', 'running', 'ready', 'error'].includes(data.phase)) {
    throw new Error('Сервер вернул некорректный статус настройки.');
  }
  csrfToken = data.csrfToken;
  canResume = data.canResume === true;
  busy = data.phase === 'running';
  const messages = {
    idle: 'Заполните данные нового форка и нажмите «Подготовить и запустить».',
    running: 'Подготовка форка выполняется. Эта страница обновляет состояние автоматически.',
    ready: 'Форк готов. Можно открыть обмен.',
    error: 'Настройка не завершена. Проверьте данные и попробуйте ещё раз.',
  };
  element('setup-status').textContent = messages[data.phase];
  showError(data.phase === 'error' && typeof data.error === 'string' ? data.error : '');
  const log = element('setup-log');
  log.replaceChildren();
  for (const line of Array.isArray(data.logs) ? data.logs : []) {
    const item = document.createElement('li');
    item.textContent = String(line);
    log.append(item);
  }
  const active = data.phase === 'ready' ? data.active : undefined;
  element('setup-result').hidden = !active;
  if (active) {
    for (const [id, value] of Object.entries({
      'setup-chain-id': active.chainId,
      'setup-result-wallet': active.testWalletAddress,
      'setup-vault': active.vaultAddress,
      'setup-ruba': active.rubaAddress,
      'setup-usdt': active.usdtAddress,
      'setup-result-rpc': active.publicRpcUrl || 'Скопируйте Public RPC этого форка из Tenderly.',
    })) element(id).textContent = String(value ?? '—');
    if (clearAdminAfterReady) {
      element('setup-admin-rpc').value = '';
      clearAdminAfterReady = false;
    }
  }
  clearTimeout(polling);
  polling = undefined;
  if (busy) polling = setTimeout(refreshStatus, 1_000);
}

async function refreshStatus() {
  if (statusRequest || submitting) return;
  statusRequest = true;
  updateControls();
  try {
    renderStatus(await request('/setup/status'));
  } catch (error) {
    clearTimeout(polling);
    polling = undefined;
    // A failed status poll must not trap the form in a disabled state.
    busy = false;
    showError(errorMessage(error));
    element('setup-status').textContent = 'Не удалось получить статус. Нажмите «Обновить статус», чтобы проверить результат.';
  } finally {
    statusRequest = false;
    updateControls();
  }
}

function checkedRpc(id, required) {
  const value = element(id).value.trim();
  if (!value && !required) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.startsWith('virtual.') && url.hostname.endsWith('.rpc.tenderly.co') && !url.username && !url.password) return value;
  } catch { /* Show a useful field-specific error without echoing the Admin URL. */ }
  throw new Error(id === 'setup-admin-rpc' ? 'Укажите HTTPS Admin RPC Tenderly Virtual TestNet.' : 'Укажите HTTPS Public RPC Tenderly Virtual TestNet.');
}

function formData() {
  const data = { rpcUrl: checkedRpc('setup-admin-rpc', true), testWalletAddress: element('setup-wallet').value.trim() };
  const publicRpcUrl = checkedRpc('setup-public-rpc', false);
  if (publicRpcUrl) data.publicRpcUrl = publicRpcUrl;
  if (!/^0x[0-9a-fA-F]{40}$/.test(data.testWalletAddress) || /^0x0{40}$/.test(data.testWalletAddress)) {
    throw new Error('Укажите публичный адрес кошелька 0x… из 40 шестнадцатеричных символов.');
  }
  for (const [field, id] of Object.entries({
    walletEth: 'setup-wallet-eth', walletRuba: 'setup-wallet-ruba', walletUsdt: 'setup-wallet-usdt',
    seedRuba: 'setup-seed-ruba', seedUsdt: 'setup-seed-usdt',
  })) {
    const value = element(id).value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) throw new Error('Суммы токенов и ликвидности должны быть положительными числами с точкой.');
    data[field] = value;
  }
  return data;
}

async function start(path, data) {
  if (busy || submitting) return;
  if (statusRequest) { showError('Дождитесь обновления статуса.'); return; }
  if (!csrfToken) { showError('Сначала нажмите «Обновить статус», чтобы подключиться к серверу.'); return; }
  submitting = true;
  clearTimeout(polling);
  polling = undefined;
  showError();
  updateControls();
  try {
    await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ruba-setup-token': csrfToken },
      body: JSON.stringify(data),
    });
    busy = true;
    clearAdminAfterReady = true;
    element('setup-result').hidden = true;
    element('setup-status').textContent = 'Запрос принят. Подготовка форка выполняется…';
  } catch (error) {
    busy = false;
    showError(errorMessage(error));
  } finally {
    submitting = false;
    updateControls();
  }
  if (busy) await refreshStatus();
}

element('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || submitting) return;
  try { void start('/setup/start', formData()); }
  catch (error) { showError(errorMessage(error)); }
});
element('setup-refresh').addEventListener('click', refreshStatus);
element('setup-resume').addEventListener('click', () => start('/setup/resume', {}));
updateControls();
void refreshStatus();
