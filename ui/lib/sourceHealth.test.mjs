import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withSourceStatus } from './sourceHealth.mjs';

test('withSourceStatus normalises healthy, degraded and unavailable results', () => {
  assert.deepEqual(withSourceStatus({ jobs: [{}], errors: [] }), {
    jobs: [{}], errors: [], status: 'healthy', count: 1, reason: null,
  });
  assert.equal(withSourceStatus({ jobs: [{}], errors: ['one failed'] }).status, 'degraded');
  const missing = withSourceStatus({ jobs: [], errors: [], available: false, note: 'not configured' });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'not configured');
});
