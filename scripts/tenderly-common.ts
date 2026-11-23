import { getAddress } from 'ethers';
import type { RubaEngine } from '../server/engine.ts';

const SEED_MARKER = 'tenderly:initial-liquidity';

export const MAINNET_USDT = getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7');

/** Report service quota failures without exposing the credential-bearing RPC URL. */
export function explainTenderlyFailure(error: unknown, phase: string): Error {
  const details = error as { message?: unknown; error?: { message?: unknown }; info?: { responseBody?: unknown } } | null;
  const messages: unknown[] = [details?.message, details?.error?.message];
  if (typeof details?.info?.responseBody === 'string') {
    try { messages.push(JSON.parse(details.info.responseBody).error?.message); }
    catch { /* Non-JSON provider errors still use the generic diagnostic below. */ }
  }
  if (messages.some((message) => typeof message === 'string' && /quota.{0,80}limit|limit.{0,80}quota/i.test(message))) {
    return new Error('В Tenderly исчерпан лимит текущего тарифа. Контракты и журнал сохранены. Проверьте лимиты в Tenderly и повторите запуск, когда лимит станет доступен.');
  }
  if (error instanceof Error && !('code' in error)) return error;
  return new Error(`Не удалось ${phase}. Проверьте Admin RPC, доступность Tenderly и введённые настройки; повторный запуск продолжит сохранённую настройку.`);
}
/** Faucet overrides belong to the fork only; deposits must still be real transactions. */
export async function ensureForkBalance(
  current: () => Promise<bigint>, target: bigint, set: (value: bigint) => Promise<unknown>,
): Promise<void> {
  if (await current() >= target) return;
  await set(target);
  if (await current() < target) throw new Error('Tenderly faucet не зачислил запрошенный баланс.');
}

/** Recover a partially deposited seed, and never re-seed an already initialized pool. */
export async function seedTenderlyPool(options: {
  engine: RubaEngine;
  account: string;
  ruba: bigint;
  usdt: bigint;
  sync: () => Promise<void>;
  deposit: (token: 'RUBA' | 'USDT', amount: bigint) => Promise<void>;
}): Promise<void> {
  const { engine, account, ruba, usdt, sync, deposit } = options;
  if (engine.getMetadata(SEED_MARKER) === 'complete') return;
  await sync();
  // addLiquidity persists before the marker: recover a crash in that small gap.
  if (engine.snapshot().totalSupply > 0n) {
    engine.setMetadata(SEED_MARKER, 'complete');
    return;
  }
  for (const [token, target] of [['RUBA', ruba], ['USDT', usdt]] as const) {
    const available = engine.accountSnapshot(account).balances[token];
    if (available < target) {
      await deposit(token, target - available);
      await sync();
      if (engine.accountSnapshot(account).balances[token] < target) {
        throw new Error('Индексатор не подтвердил начальный депозит. Повторите запуск после проверки RPC.');
      }
    }
  }
  engine.addLiquidity(account, ruba, usdt, ruba, usdt);
  engine.setMetadata(SEED_MARKER, 'complete');
}

