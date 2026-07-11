import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugOf, buildPrefills, HANDOFF_SUMMARY_PROMPT, handoffOpening } from './chatPrompts.mjs';

test('slugOf matches the app.js slug rules', () => {
  assert.equal(slugOf('Acme Avionics'), 'acme-avionics');
  assert.equal(slugOf('Boom & Bust Ltd.'), 'boom-and-bust-ltd');
  assert.equal(slugOf('  Weird -- Name  '), 'weird-name');
});

test('prefills carry slug-correct paths and the tracker id', () => {
  const entry = { id: 'acme-avionics-lead-2026-07', company: 'Acme Avionics', role: 'Lead Engineer' };
  const p = buildPrefills(entry, { locale: 'en-US', tone: 'concise and warm' });
  assert.equal(p.ask, '');
  assert.match(p.cv, /applications\/acme-avionics\/cv\.typ/);
  assert.match(p.cv, /typst compile --root \. applications\/acme-avionics\/cv\.typ/);
  assert.match(p.cv, /cv\/master-cv\.md/);
  assert.match(p.cv, /acme-avionics-lead-2026-07/);
  assert.match(p.cv, /Draft only, nothing sent\./);
  assert.match(p.coverLetter, /applications\/acme-avionics\/outreach\.md/);
  assert.match(p.coverLetter, /en-US, concise and warm/);
  assert.match(p.tweak, /<your change>/);
  assert.match(p.tweak, /applications\/acme-avionics\/cv\.typ/);
});

test('handoff prompt and opening are well-formed', () => {
  assert.match(HANDOFF_SUMMARY_PROMPT, /decisions made/);
  assert.match(HANDOFF_SUMMARY_PROMPT, /files created or edited/);
  const opening = handoffOpening('SUMMARY GOES HERE');
  assert.match(opening, /taking over an in-progress task/);
  assert.match(opening, /SUMMARY GOES HERE/);
});
