import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildConfig,
  bytesToBase64,
  formatLocalDateTime,
  handoffAction,
  shouldAutoRunFirstScan,
  splitList,
  validateCvName,
} from './setup.js';

test('splitList accepts comma and newline separated settings', () => {
  assert.deepEqual(splitList('Robotics, climate tech\nHealthcare,  '), [
    'Robotics', 'climate tech', 'Healthcare',
  ]);
});
test('buildConfig creates generic search and commute settings', () => {
  const config = buildConfig({
    displayName: 'Alex',
    tone: 'concise and warm',
    roleFamilies: 'Design, Operations',
    sectors: 'Energy\nMobility',
    locations: 'Manchester, Remote UK',
    exclusions: 'Commission-only',
    salaryMinimum: '65000',
    currency: 'gbp',
    locale: 'en-GB',
    timezone: 'Europe/London',
    commuteOrigin: 'Manchester',
    commuteMode: 'public',
    commuteMax: '75',
    includeUnknown: false,
  }, { profile: { retained: true }, search: { retained: true }, commute: { retained: true } });

  assert.equal(config.profile.displayName, 'Alex');
  assert.equal(config.profile.retained, true);
  assert.deepEqual(config.search.roleFamilies, ['Design', 'Operations']);
  assert.deepEqual(config.search.sectors, ['Energy', 'Mobility']);
  assert.equal(config.search.salaryMinimum, 65000);
  assert.equal(config.currency, 'GBP');
  assert.deepEqual(config.commute, {
    retained: true,
    origin: 'Manchester',
    mode: 'public',
    maxMinutes: 75,
    includeUnknown: false,
  });
});

test('buildConfig represents a blank salary as null', () => {
  assert.equal(buildConfig({ displayName: 'Alex', salaryMinimum: '' }).search.salaryMinimum, null);
});

test('CV validation accepts only supported local import types', () => {
  for (const name of ['cv.pdf', 'cv.docx', 'cv.md', 'cv.markdown', 'cv.txt']) {
    assert.equal(validateCvName(name), true);
  }
  assert.throws(() => validateCvName('cv.pages'), /PDF, DOCX, Markdown or text/);
});

test('bytesToBase64 preserves binary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
  assert.deepEqual(Buffer.from(bytesToBase64(bytes), 'base64'), Buffer.from(bytes));
});

test('formatLocalDateTime returns local readable text and handles missing values', () => {
  assert.equal(formatLocalDateTime(null), 'pending');
  assert.match(formatLocalDateTime('2026-07-12T07:30:00.000Z', 'en-GB'), /2026/);
});

test('bounded proposal activation gates the first scan', () => {
  assert.deepEqual(handoffAction(false), { label: 'Activate a proposal to continue', defer: false, ready: false });
  assert.deepEqual(handoffAction(true), { label: 'Continue to first scan', defer: false, ready: true });
});

test('a first scan starts automatically only when the workspace has never scanned', () => {
  assert.equal(shouldAutoRunFirstScan({}), true);
  assert.equal(shouldAutoRunFirstScan({}, false), false);
  assert.equal(shouldAutoRunFirstScan({ lastRunAt: '2026-07-12T10:00:00.000Z' }), false);
});

test('first-run setup offers optional local create, private backup guidance, and restore', () => {
  const source = fs.readFileSync(new URL('./setup.js', import.meta.url), 'utf8');
  assert.match(source, /Set up Scout for the first time/);
  assert.match(source, /Restore my existing workspace/);
  assert.match(source, /Scout works fully.*without GitHub/s);
  assert.match(source, /select <strong>Private<\/strong>/);
  assert.match(source, />Not now</);
  assert.match(source, /Save your emergency recovery key/);
  assert.match(source, /Save key to file/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /GitHub copy is still pending/);
  assert.match(source, /setup-backup-check-git/);
  assert.match(source, />Retry</);
  assert.match(source, /api\/sync\/recovery-key\/confirm/);
});
