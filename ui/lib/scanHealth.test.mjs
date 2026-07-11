import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScanRuns, scanHealthFromText } from './scanHealth.mjs';

test('parseScanRuns parses jsonl and reports bad lines', () => {
  const out = parseScanRuns('{"timestamp":"2026-07-08T07:30:00"}\nnope\n');
  assert.equal(out.runs.length, 1);
  assert.equal(out.errors.length, 1);
});

test('scanHealthFromText reports missing runs as stale', () => {
  const out = scanHealthFromText('', '2026-07-08');
  assert.equal(out.healthy, false);
  assert.equal(out.stale, true);
  assert.match(out.reason, /no scan runs/i);
});

test('scanHealthFromText reports a healthy same-day run', () => {
  const line = JSON.stringify({
    timestamp: '2026-07-08T07:30:00',
    search_degraded: false,
    sources_checked: ['ats'],
    ats_portals_checked: 2,
    candidates_found: 8,
    keepers_added: 1,
    discarded: { stale: 2 },
    errors: [],
  });
  const out = scanHealthFromText(`${line}\n`, '2026-07-08');
  assert.equal(out.healthy, true);
  assert.equal(out.stale, false);
  assert.equal(out.keepersAdded, 1);
  assert.deepEqual(out.sourcesChecked, ['ats']);
});

test('scanHealthFromText flags stale and degraded runs', () => {
  const stale = scanHealthFromText('{"timestamp":"2026-07-07T07:30:00","errors":[]}\n', '2026-07-08');
  assert.equal(stale.stale, true);
  const degraded = scanHealthFromText('{"timestamp":"2026-07-08T07:30:00","search_degraded":true,"errors":[]}\n', '2026-07-08');
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.healthy, false);
});

