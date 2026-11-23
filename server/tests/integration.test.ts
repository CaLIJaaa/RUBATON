import assert from 'node:assert/strict';
import test from 'node:test';
import { runDemo } from '../../scripts/demo.ts';

test('live Anvil: four swaps → user-paid signed publication with expiry/rotation/restart → Merkle proof → withdrawal', {
  skip: process.env.RUBA_INTEGRATION !== '1' ? 'Run npm run test:integration; requires local ports and Anvil' : false,
  timeout: 90_000,
}, async () => {
  const result = await runDemo(() => {});
  assert.deepEqual(result, {
    tradeCount: 4,
    batchId: 1n,
    merkleVerified: true,
    payoutAmount: 10_000_000n,
    custodyUnchangedDuringSwaps: true,
    publicationPaidByUser: true,
    operatorNonceUnchanged: true,
  });
});
