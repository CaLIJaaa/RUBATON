import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePrices, deviationBps, findCorrection, formatPrice, getAmountOut, parsePrice,
  rational, simulateSwap, splitCorrection, spotPrice, targetPrice,
  type CorrectionInput, type CorrectionPlan, type Rational,
} from '../price-math.ts';

const MAX96 = (1n << 96n) - 1n;
const unit = (decimals: number) => 10n ** BigInt(decimals);
const baseInput = (overrides: Partial<CorrectionInput> = {}): CorrectionInput => ({
  reserve0: 3000n * unit(18), reserve1: 3300n * unit(6), decimals0: 18, decimals1: 6,
  target: targetPrice('1', '1'), balance0: 1000n * unit(18), balance1: 1000n * unit(6),
  maxTradeBps: 2000, minDeviationBps: 40, swaps: 4, ...overrides,
});
function assertCorrects(input: CorrectionInput, plan: CorrectionPlan) {
  assert.equal(plan.swaps.length, input.swaps);
  assert.equal(plan.swaps.reduce((total, swap) => total + swap.amountIn, 0n), plan.amountIn);
  const high = comparePrices(spotPrice(input.reserve0, input.reserve1, input.decimals0, input.decimals1), input.target) > 0;
  assert.equal(plan.direction, high ? 'RUBA' : 'USDT');
  const reserveIn = high ? input.reserve0 : input.reserve1;
  assert.ok(plan.amountIn <= reserveIn * BigInt(input.maxTradeBps) / 10000n);
  assert.ok(plan.amountIn <= (high ? input.balance0 : input.balance1));
  let r0 = input.reserve0, r1 = input.reserve1;
  let before = spotPrice(r0, r1, input.decimals0, input.decimals1);
  for (const swap of plan.swaps) {
    assert.ok(swap.amountIn > 0n && swap.amountOut > 0n);
    assert.equal(swap.tokenIn, plan.direction);
    const exact = simulateSwap({ reserve0: r0, reserve1: r1 }, plan.direction, swap.amountIn);
    assert.deepEqual(swap, exact);
    assert.ok(swap.reserve0After * swap.reserve1After >= r0 * r1);
    const after = spotPrice(swap.reserve0After, swap.reserve1After, input.decimals0, input.decimals1);
    assert.equal(comparePrices(after, before), high ? -1 : 1);
    assert.ok(high ? comparePrices(after, input.target) >= 0 : comparePrices(after, input.target) <= 0);
    r0 = swap.reserve0After; r1 = swap.reserve1After; before = after;
  }
}

test('manual reference prices are canonical exact positive decimal rationals', () => {
  assert.deepEqual(parsePrice('0.97'), { numerator: 97n, denominator: 100n });
  assert.deepEqual(parsePrice('0.000000000000000001'), { numerator: 1n, denominator: unit(18) });
  assert.deepEqual(parsePrice('9007199254740993'), { numerator: 9007199254740993n, denominator: 1n });
  assert.deepEqual(targetPrice('1', '3000'), { numerator: 1n, denominator: 3000n });
  assert.deepEqual(targetPrice('3000', '90000'), { numerator: 1n, denominator: 30n });
  for (const bad of ['', '0', '0.0', '1.0', '01', '.5', '1.', '1e3', 'NaN', ' 1', '+1', '-1', '0.0000000000000000001']) {
    assert.throws(() => parsePrice(bad), Error, bad);
  }
});

test('spot normalization uses real 18/6, 18/18 and 18/8 token decimals', () => {
  assert.deepEqual(spotPrice(3000n * unit(18), 3000n * unit(6), 18, 6), rational(1n, 1n));
  assert.deepEqual(spotPrice(3000n * unit(18), unit(18), 18, 18), rational(1n, 3000n));
  assert.deepEqual(spotPrice(3n * unit(18), unit(8) / 10n, 18, 8), rational(1n, 30n));
  assert.equal(formatPrice(rational(1n, 3000n)), '0.000333333333333333');
  assert.equal(formatPrice(rational(11n, 10n)), '1.1');
  assert.equal(formatPrice(rational(199n, 100n), 0), '1');
  for (const decimals of [-1, 19, 1.5]) assert.throws(() => spotPrice(1n, 1n, decimals, 6));
  assert.throws(() => spotPrice(0n, 1n, 18, 6));
  assert.throws(() => rational(1n, 0n));
});

test('signed deviation has exact basis-point arithmetic and truncates fractions toward zero', () => {
  assert.equal(deviationBps(rational(11n, 10n), rational(1n, 1n)), 1000n);
  assert.equal(deviationBps(rational(9n, 10n), rational(1n, 1n)), -1000n);
  assert.equal(deviationBps(rational(10001n, 10000n), rational(1n, 1n)), 1n);
  assert.equal(deviationBps(rational(99999n, 100000n), rational(1n, 1n)), 0n);
});

test('V2 quote uses the exact 997/1000 fee and floor, including atomic dust', () => {
  assert.equal(getAmountOut(1000n, 10000n, 10000n), 906n);
  assert.equal(getAmountOut(1000n * unit(18), 10000n * unit(18), 10000n * unit(6)), 906610893n);
  assert.equal(getAmountOut(1n, 10000n, 1n), 0n);
  for (const input of [0n, -1n]) assert.throws(() => getAmountOut(input, 100n, 100n));
  assert.throws(() => getAmountOut(1n, 0n, 100n));
});

test('all three markets correct in both directions without crossing the manual reference', () => {
  const pairs: Array<[number, number, bigint, bigint, Rational]> = [
    [18, 6, 3000n * unit(18), 3000n * unit(6), targetPrice('1', '1')],
    [18, 18, 3000n * unit(18), unit(18), targetPrice('1', '3000')],
    [18, 8, 3n * unit(18), unit(8) / 10n, targetPrice('3000', '90000')],
  ];
  for (const [decimals0, decimals1, reserve0, equalReserve1, target] of pairs) {
    for (const numerator of [9n, 11n]) {
      const input = baseInput({ reserve0, reserve1: equalReserve1 * numerator / 10n, decimals0, decimals1,
        target, balance0: reserve0, balance1: equalReserve1 });
      const plan = findCorrection(input);
      assert.ok(plan, `${decimals0}/${decimals1}, ratio ${numerator}`);
      assertCorrects(input, plan);
    }
  }
});

test('the packet uses exactly 4-collected genuinely positive swaps', () => {
  for (let collected = 0; collected < 4; ++collected) {
    const input = baseInput({ swaps: 4 - collected });
    const plan = findCorrection(input);
    assert.ok(plan);
    assertCorrects(input, plan);
    const sizes = plan.swaps.map((swap) => swap.amountIn);
    assert.ok(sizes.at(-1)! - sizes[0] <= 1n);
  }
});

test('input funding, reserve cap, output account bound and minimum deviation are enforced', () => {
  const limited = baseInput({ balance0: 12n * unit(18) });
  const limitedPlan = findCorrection(limited)!;
  assert.equal(limitedPlan.amountIn, limited.balance0);
  assertCorrects(limited, limitedPlan);
  const capped = baseInput({ maxTradeBps: 10 });
  assert.equal(findCorrection(capped)!.amountIn, capped.reserve0 / 1000n);
  assert.equal(findCorrection(baseInput({ balance0: 0n })), undefined);
  assert.equal(findCorrection(baseInput({ balance1: MAX96 })), undefined);
  assert.equal(findCorrection(baseInput({ reserve1: 3000n * unit(6) })), undefined);
  assert.equal(findCorrection(baseInput({ reserve1: 3011n * unit(6) })), undefined);
  for (const maxTradeBps of [0, 10001, 1.5]) assert.throws(() => findCorrection(baseInput({ maxTradeBps })));
  for (const swaps of [0, 5, 1.5]) assert.throws(() => findCorrection(baseInput({ swaps })));
  assert.equal(findCorrection(baseInput({ reserve0: MAX96 + 1n })), undefined);
});

test('insufficient atomic correcting volume and zero-output filler never form a packet', () => {
  assert.equal(findCorrection(baseInput({ balance0: 3n })), undefined);
  assert.equal(splitCorrection({ reserve0: 1000n, reserve1: 1n }, 'RUBA', 100n, 4), undefined);
  assert.equal(splitCorrection({ reserve0: 10n, reserve1: 1000n }, 'RUBA', 3n, 4), undefined);
  const hugePlateau = baseInput({ reserve0: MAX96 / 2n, reserve1: 9n, decimals0: 0, decimals1: 0,
    target: rational(1n, MAX96), balance0: MAX96, balance1: 0n });
  assert.equal(findCorrection(hugePlateau), undefined);
});

test('balanced residue rounding is searched separately and handles disappearing positive outputs', () => {
  const input = baseInput({ reserve0: 6n, reserve1: 9n, decimals0: 0, decimals1: 0,
    target: rational(1n, 2n), balance0: 6n, balance1: 9n, maxTradeBps: 10000, minDeviationBps: 0, swaps: 3 });
  assert.equal(splitCorrection({ reserve0: 6n, reserve1: 9n }, 'RUBA', 6n, 3), undefined);
  assert.equal(findCorrection(input)?.amountIn, 5n);
  assertCorrects(input, findCorrection(input)!);
  const disappearing = { ...input, reserve0: 15n, reserve1: 9n, balance0: 15n, target: rational(1n, 10n) };
  assert.equal(splitCorrection({ reserve0: 15n, reserve1: 9n }, 'RUBA', 15n, 3), undefined);
  assert.equal(findCorrection(disappearing)?.amountIn, 14n);
});

test('binary search matches exhaustive exact split enumeration over small integer pools', () => {
  const targets = [rational(1n, 2n), rational(1n, 1n), rational(2n, 1n), rational(9n, 10n)];
  for (let reserve0 = 1n; reserve0 <= 24n; ++reserve0) for (let reserve1 = 1n; reserve1 <= 24n; ++reserve1) {
    for (const target of targets) for (let swaps = 1; swaps <= 4; ++swaps) {
      const start = spotPrice(reserve0, reserve1, 0, 0), side = comparePrices(start, target);
      if (side === 0) continue;
      const direction = side > 0 ? 'RUBA' : 'USDT';
      const cap = side > 0 ? reserve0 : reserve1;
      let expected = 0n;
      for (let amount = 1n; amount <= cap; ++amount) {
        const parts = splitCorrection({ reserve0, reserve1 }, direction, amount, swaps);
        if (!parts) continue;
        const end = parts.at(-1)!;
        const finalSide = comparePrices(spotPrice(end.reserve0After, end.reserve1After, 0, 0), target);
        if (side > 0 ? finalSide >= 0 : finalSide <= 0) expected = amount;
      }
      const actual = findCorrection(baseInput({ reserve0, reserve1, decimals0: 0, decimals1: 0,
        target, balance0: reserve0, balance1: reserve1, maxTradeBps: 10000, minDeviationBps: 0, swaps }));
      assert.equal(actual?.amountIn ?? 0n, expected, `${reserve0}/${reserve1}, target ${target.numerator}/${target.denominator}, ${swaps} swaps`);
    }
  }
});
