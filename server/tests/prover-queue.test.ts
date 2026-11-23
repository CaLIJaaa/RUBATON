import assert from 'node:assert/strict';
import test from 'node:test';
import { withProverBudget } from '../zk/prover.ts';

test('independent markets share one heavy-prover slot and a failed proof releases it', async () => {
  let active = 0, maximum = 0;
  const order: number[] = [];
  const jobs = [1, 2, 3].map((market) => withProverBudget(async () => {
    active++; maximum = Math.max(maximum, active); order.push(market);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (market === 2) throw new Error('invalid witness');
      return market;
    } finally { active--; }
  }));
  const results = await Promise.allSettled(jobs);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(await withProverBudget(async () => 4), 4);
});
