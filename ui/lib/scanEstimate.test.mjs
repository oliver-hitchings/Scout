import assert from 'node:assert/strict';
import test from 'node:test';
import { scanEstimate, scanRemainingText } from './scanEstimate.mjs';

const run = (minutes, overrides = {}) => ({
  agent: 'codex', mode: 'primary', started_at: '2026-07-20T10:00:00.000Z',
  timestamp: new Date(Date.parse('2026-07-20T10:00:00.000Z') + minutes * 60_000).toISOString(),
  degraded: false, skipped: false, errors: [], ...overrides,
});

test('scan estimate uses comparable healthy history and ignores other runs', () => {
  assert.deepEqual(scanEstimate([run(6), run(7), run(8), run(20, { agent: 'claude' }), run(2, { degraded: true })], 'codex', 'primary'), {
    basis: 'history', sampleSize: 3, totalSecondsLow: 336, totalSecondsHigh: 504,
  });
});

test('scan estimate falls back conservatively and describes overruns honestly', () => {
  assert.deepEqual(scanEstimate([], 'codex'), {
    basis: 'default', sampleSize: 0, totalSecondsLow: 300, totalSecondsHigh: 600,
  });
  const operation = {
    startedAt: '2026-07-20T10:00:00.000Z',
    estimate: { totalSecondsLow: 300, totalSecondsHigh: 600 },
  };
  assert.equal(scanRemainingText(operation, Date.parse('2026-07-20T10:02:00.000Z')), 'About 3–8 min remaining');
  assert.match(scanRemainingText(operation, Date.parse('2026-07-20T10:11:00.000Z')), /still working/);
});
