import assert from 'node:assert/strict';
import test from 'node:test';
import { runMonitorIncident } from '../../scripts/monitor-incident.ts';

test('test incident from the signal to recovery on a local chain', {
  skip: process.env.RUBA_MONITOR_INTEGRATION !== '1' ? 'Set RUBA_MONITOR_INTEGRATION=1; requires Anvil and forge build' : false,
}, async () => {
  const lines: string[] = [];
  const result = await runMonitorIncident((line) => lines.push(line));
  assert.deepEqual(result.journal.map((event) => `${event.criterion}:${event.severity}:${event.token}`), ['transfer:pause:RUBA', 'transfer:clear:RUBA']);
  assert.ok(result.journal[0].txHash, 'the bot sent the pause itself');
  assert.equal(result.marketPaused, false);
  assert.equal(result.rubaPaused, false);
  assert.ok(lines.some((line) => /после первой роли: рынок на паузе/.test(line)));
});
