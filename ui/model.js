const UINT256_MAX = (1n << 256n) - 1n;

/** Human token amounts are always converted using integer arithmetic. */
export function parseAmount(text, decimals, { allowZero = false } = {}) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Некорректная точность токена.');
  if (typeof text !== 'string' || text.length > 120) throw new Error('Введите сумму обычным числом.');
  const normalized = text.trim().replace(',', '.');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) throw new Error('Введите сумму без знака минус и без экспоненты.');
  const [whole = '', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`У этого токена не больше ${decimals} знаков после запятой.`);
  const amount = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount > UINT256_MAX) throw new Error('Сумма слишком большая.');
  if (amount === 0n && !allowZero) throw new Error('Сумма должна быть больше нуля.');
  return amount;
}

export function formatAmount(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Некорректная точность токена.');
  const amount = BigInt(value);
  if (amount < 0n) throw new Error('Баланс не может быть отрицательным.');
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (amount / scale).toString() + (fraction ? `.${fraction}` : '');
}

/** A percentage with two fractional digits becomes basis points. */
export function parseSlippage(text) {
  const basisPoints = parseAmount(text, 2, { allowZero: true });
  if (basisPoints > 500n) throw new Error('Укажите допустимое изменение от 0 до 5%.');
  return basisPoints;
}

export function minimumOutput(quotedOutput, basisPoints) {
  const output = BigInt(quotedOutput);
  const bps = BigInt(basisPoints);
  if (output <= 0n || bps < 0n || bps > 500n) throw new Error('Некорректная котировка или допустимое изменение.');
  const minimum = output * (10_000n - bps) / 10_000n;
  return minimum > 0n ? minimum : 1n;
}

/** Same canonical encoding as server/auth.ts; JSON numbers are deliberately excluded. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Некорректный формат операции.');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Суммы операции должны быть десятичными строками.');
}

export function errorMessage(error) {
  const code = error?.code ?? error?.info?.error?.code;
  const text = [error?.revert?.name, error?.reason, error?.shortMessage, error?.message, error?.info?.error?.message].filter(Boolean).join(' ');
  if (code === 4001 || code === 'ACTION_REJECTED' || /user rejected|user denied/i.test(text)) return 'Вы отменили действие в кошельке.';
  if (Number(code) === -32002) return 'В кошельке уже открыт запрос. Откройте его окно и подтвердите или отмените запрос.';
  if (/Receipt not found/i.test(text)) return 'Квитанция не найдена для подключённого кошелька в выбранном пуле. Проверьте номер своей сделки и выбранную пару.';
  if (/Кошелёк изменился|Сеть кошелька|Wallet context changed/.test(text)) return 'Кошелёк или сеть изменились. Подключите кошелёк заново.';
  if (code === 'NETWORK_ERROR' || code === 4900 || code === 4901 || /Failed to fetch|fetch failed|timeout|AbortError/i.test(text)) return 'Не удалось связаться с сервером или сетью. Проверьте подключение.';
  if (/NotWhitelisted|not whitelisted/i.test(text)) return 'Кошелёк ещё не допущен к новым операциям. Обратитесь к администратору.';
  if (/MarketPaused|Market is paused/i.test(text)) return 'Новые операции временно приостановлены.';
  if (/TokenWithdrawalsPaused|Withdrawals for this token are paused/i.test(text)) return 'Вывод этого токена временно приостановлен.';
  if (/blacklist/i.test(text)) return 'Перевод токена заблокирован его эмитентом. Другой токен можно вывести отдельно.';
  if (/nonce|WithdrawalAlreadyUsed/i.test(text)) return 'Состояние запроса изменилось. Обновите данные перед повторным действием.';
  if (/ExpiredWithdrawal|expired|obsolete|InvalidSignerEpoch|signer epoch/i.test(text)) return 'Разрешение устарело. Обновите список запросов на вывод.';
  if (/slippage/i.test(text)) return 'Цена или пропорция пула изменилась. Обновите расчёт либо минимальные суммы.';
  if (/Insufficient.*balance|exceeds balance/i.test(text)) return 'На выбранном балансе недостаточно токенов.';
  if (/Insufficient LP shares/i.test(text)) return 'У вас недостаточно LP-долей.';
  if (/Insufficient.*liquidity|rounds to zero/i.test(text)) return 'В пуле недостаточно ликвидности либо сумма слишком мала.';
  if (code === 'INSUFFICIENT_FUNDS') return 'В кошельке недостаточно средств для суммы и комиссии сети.';
  if (/Blockchain operation failed/i.test(text)) return 'Сеть временно недоступна. Обновите данные немного позже.';
  if (/[А-Яа-яЁё]/.test(error?.message ?? '')) return error.message;
  return 'Не удалось выполнить действие. Проверьте баланс, доступ и подключение кошелька.';
}
