/** Exact atomic-unit V2 math. Manual references are USD per whole token. */
export interface Rational { numerator: bigint; denominator: bigint }
export interface PoolReserves { reserve0: bigint; reserve1: bigint }
export interface CorrectionInput extends PoolReserves {
  decimals0: number; decimals1: number; target: Rational;
  balance0: bigint; balance1: bigint; maxTradeBps: number; minDeviationBps: number; swaps: number;
}
export interface CorrectingSwap {
  tokenIn: 'RUBA' | 'USDT'; amountIn: bigint; amountOut: bigint;
  reserve0After: bigint; reserve1After: bigint;
}
export interface CorrectionPlan {
  direction: 'RUBA' | 'USDT'; amountIn: bigint; swaps: CorrectingSwap[]; deviationBps: bigint;
}
const BPS = 10_000n;
const MAX96 = (1n << 96n) - 1n;
const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (numerator <= 0n || denominator <= 0n) throw new Error('Price must be positive');
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
export function parsePrice(value: string): Rational {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value) || value.length > 80
    || (value.includes('.') && value.endsWith('0'))) throw new Error('Invalid canonical reference price');
  const [whole, fraction = ''] = value.split('.');
  return rational(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}
function scale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid token decimals');
  return 10n ** BigInt(decimals);
}
export function targetPrice(baseUsd: string, quoteUsd: string): Rational {
  const base = parsePrice(baseUsd), quote = parsePrice(quoteUsd);
  return rational(base.numerator * quote.denominator, base.denominator * quote.numerator);
}
export function spotPrice(reserve0: bigint, reserve1: bigint, decimals0: number, decimals1: number): Rational {
  if (reserve0 <= 0n || reserve1 <= 0n) throw new Error('Pool has no liquidity');
  return rational(reserve1 * scale(decimals0), reserve0 * scale(decimals1));
}
export function comparePrices(left: Rational, right: Rational): number {
  const delta = left.numerator * right.denominator - right.numerator * left.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function deviationBps(spot: Rational, target: Rational): bigint {
  return (spot.numerator * target.denominator - target.numerator * spot.denominator) * BPS
    / (spot.denominator * target.numerator);
}
export function formatPrice(value: Rational, places = 18): string {
  if (!Number.isInteger(places) || places < 0 || places > 18) throw new Error('Invalid price precision');
  const factor = 10n ** BigInt(places);
  const scaled = value.numerator * factor / value.denominator;
  const whole = scaled / factor;
  if (!places) return whole.toString();
  const fraction = (scaled % factor).toString().padStart(places, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) throw new Error('Invalid V2 reserves/input');
  return amountIn * 997n * reserveOut / (reserveIn * 1000n + amountIn * 997n);
}
export function simulateSwap(pool: PoolReserves, tokenIn: 'RUBA' | 'USDT', amountIn: bigint): CorrectingSwap {
  const out = tokenIn === 'RUBA'
    ? getAmountOut(amountIn, pool.reserve0, pool.reserve1)
    : getAmountOut(amountIn, pool.reserve1, pool.reserve0);
  return { tokenIn, amountIn, amountOut: out,
    reserve0After: pool.reserve0 + (tokenIn === 'RUBA' ? amountIn : -out),
    reserve1After: pool.reserve1 + (tokenIn === 'USDT' ? amountIn : -out) };
}
function balancedSplit(pool: PoolReserves, direction: 'RUBA' | 'USDT', amount: bigint, count: number): CorrectingSwap[] | undefined {
  if (!Number.isInteger(count) || count < 1 || count > 4 || amount < BigInt(count)) return undefined;
  if (pool.reserve0 <= 0n || pool.reserve1 <= 0n || pool.reserve0 > MAX96 || pool.reserve1 > MAX96) return undefined;
  let current = pool; let remaining = amount;
  const result: CorrectingSwap[] = [];
  for (let i = 0; i < count; ++i) {
    const input = remaining / BigInt(count - i);
    const swap = simulateSwap(current, direction, input);
    if (swap.reserve0After <= 0n || swap.reserve1After <= 0n
      || swap.reserve0After > MAX96 || swap.reserve1After > MAX96) return undefined;
    result.push(swap); remaining -= input;
    current = { reserve0: swap.reserve0After, reserve1: swap.reserve1After };
  }
  return result;
}
/** A balanced split of genuine correcting volume. Every integer swap must produce a positive output. */
export function splitCorrection(pool: PoolReserves, direction: 'RUBA' | 'USDT', amount: bigint, count: number): CorrectingSwap[] | undefined {
  const parts = balancedSplit(pool, direction, amount, count);
  return parts?.every((part) => part.amountOut > 0n) ? parts : undefined;
}
/** Largest capped split that approaches the reference without crossing it. */
export function findCorrection(input: CorrectionInput): CorrectionPlan | undefined {
  const { reserve0, reserve1, decimals0, decimals1, target, swaps } = input;
  if (!Number.isInteger(input.maxTradeBps) || input.maxTradeBps < 1 || input.maxTradeBps > 10_000
    || !Number.isInteger(input.minDeviationBps) || input.minDeviationBps < 0 || input.minDeviationBps > 10_000
    || !Number.isInteger(swaps) || swaps < 1 || swaps > 4) throw new Error('Invalid arbitrage bounds');
  rational(target.numerator, target.denominator);
  if (reserve0 <= 0n || reserve1 <= 0n || reserve0 > MAX96 || reserve1 > MAX96
    || input.balance0 < 0n || input.balance1 < 0n || input.balance0 > MAX96 || input.balance1 > MAX96) return undefined;
  const spot = spotPrice(reserve0, reserve1, decimals0, decimals1);
  const deviation = deviationBps(spot, target);
  if (comparePrices(spot, target) === 0 || (deviation < 0n ? -deviation : deviation) < BigInt(input.minDeviationBps)) return undefined;
  const high = comparePrices(spot, target) > 0;
  const direction = high ? 'RUBA' : 'USDT';
  const reserveIn = high ? reserve0 : reserve1;
  const balance = high ? input.balance0 : input.balance1;
  const outputRoom = MAX96 - (high ? input.balance1 : input.balance0);
  if (outputRoom === 0n) return undefined;
  let cap = reserveIn * BigInt(input.maxTradeBps) / BPS;
  if (balance < cap) cap = balance;
  if (cap > MAX96 - reserveIn) cap = MAX96 - reserveIn;
  if (cap < BigInt(swaps)) return undefined;
  const pool = { reserve0, reserve1 };
  const divisor = BigInt(swaps);
  let bestAmount = 0n;
  let parts: CorrectingSwap[] | undefined;
  // Balanced rounding changes which leg receives an extra atom at each residue.
  // Searching all amounts together is not monotone. Within a fixed residue,
  // every leg is q or q+1. cap<=reserveIn and q>=1 imply reserveIn>=swaps;
  // each output-reserve multiplier is then nonincreasing with q, including its
  // integer ceiling. Search those at most four monotone sequences separately.
  for (let residue = 0n; residue < divisor; ++residue) {
    if (divisor + residue > cap) continue;
    const simulate = (q: bigint) => balancedSplit(pool, direction, q * divisor + residue, swaps)!;
    const staysOnSide = (q: bigint) => {
      const split = simulate(q);
      const last = split.at(-1)!;
      const side = comparePrices(spotPrice(last.reserve0After, last.reserve1After, decimals0, decimals1), target);
      const output = split.reduce((sum, part) => sum + part.amountOut, 0n);
      return (high ? side >= 0 : side <= 0) && output <= outputRoom;
    };
    if (!staysOnSide(1n)) continue;
    let low = 1n, upper = (cap - residue) / divisor;
    while (low < upper) {
      const mid = (low + upper + 1n) / 2n;
      if (staysOnSide(mid)) low = mid; else upper = mid - 1n;
    }
    let q = low;
    while (q >= 1n && q * divisor + residue > bestAmount) {
      const split = simulate(q);
      if (split.every((part) => part.amountOut > 0n)) {
        bestAmount = q * divisor + residue; parts = split; break;
      }
      // Positivity itself can disappear after integer rounding. Skip the entire
      // unchanged reserve-vector plateau rather than decrementing a possibly
      // 96-bit atomic amount one unit at a time. A zero leg cannot become useful
      // while all intermediate output reserves remain identical.
      const outputReserve = (part: CorrectingSwap) => high ? part.reserve1After : part.reserve0After;
      const differs = (candidate: bigint) => simulate(candidate).some((part, i) => outputReserve(part) !== outputReserve(split[i]));
      if (q === 1n || !differs(1n)) break;
      let prior = 1n, limit = q - 1n;
      while (prior < limit) {
        const mid = (prior + limit + 1n) / 2n;
        if (differs(mid)) prior = mid; else limit = mid - 1n;
      }
      q = prior;
    }
  }
  if (!parts) return undefined;
  let previous = spot;
  for (const part of parts) {
    const after = spotPrice(part.reserve0After, part.reserve1After, decimals0, decimals1);
    if (high ? comparePrices(after, previous) >= 0 || comparePrices(after, target) < 0
      : comparePrices(after, previous) <= 0 || comparePrices(after, target) > 0) return undefined;
    previous = after;
  }
  return { direction, amountIn: bestAmount, swaps: parts, deviationBps: deviation };
}
