import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../model.js';

const missingReceiptMessage = 'Квитанция не найдена для подключённого кошелька в выбранном пуле. Проверьте номер своей сделки и выбранную пару.';

test('receipt errors explain the selected wallet and pool for current and older servers', () => {
  assert.equal(errorMessage(Object.assign(new Error(missingReceiptMessage), { status: 404 })), missingReceiptMessage);
  assert.equal(errorMessage(Object.assign(new Error('Receipt not found'), { status: 400 })), missingReceiptMessage);
  assert.equal(errorMessage({ message: 'could not coalesce error', info: { error: { message: 'Receipt not found' } } }), missingReceiptMessage);
});

test('a collecting receipt still explains batch closure instead of reporting a missing receipt', () => {
  const message = 'Квитанция ещё не включена в пакет: собрано 1 из 4 сделок. Повторите загрузку после закрытия.';
  assert.equal(errorMessage(Object.assign(new Error(message), { status: 409 })), message);
});
