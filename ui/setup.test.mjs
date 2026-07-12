import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConfig,
  buildOnboardingPrompt,
  bytesToBase64,
  formatLocalDateTime,
  handoffAction,
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

test('optional AI enrichment never traps initial setup in an error state', () => {
  assert.deepEqual(handoffAction(false), { label: 'Finish for now', defer: true });
  assert.deepEqual(handoffAction(true), { label: 'Continue to first scan', defer: false });
});

test('AI hand-off prompt is evidence-led and approval-gated', () => {
  const prompt = buildOnboardingPrompt({
    workspaceRoot: 'C:\\Users\\Alex\\Documents\\Scout Workspace',
    provider: 'codex',
    imported: { extracted: 'imports/cv.txt' },
    config: { search: { roleFamilies: ['Operations'], sectors: ['Climate tech'] } },
  });
  assert.match(prompt, /\$onboard-scout/);
  assert.match(prompt, /imports\/cv\.txt/);
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /ask for approval before activation/);
  assert.match(prompt, /never send an application or outreach message/);
});
