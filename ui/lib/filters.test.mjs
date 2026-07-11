import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMMUTE_FILTER, ORIGIN_POSTCODE, categoryOf, commuteLabel, commuteMinutes,
  filterOpportunities, matchesCommute, normaliseCategory, normaliseCommuteMode,
} from './filters.mjs';

test('normaliseCategory maps aliases and accepts configured slug values', () => {
  assert.equal(normaliseCategory('scaleup'), 'startup');
  assert.equal(normaliseCategory('prime'), 'established');
  assert.equal(normaliseCategory('standard'), 'established');
  assert.equal(normaliseCategory('corporate'), 'established');
  assert.equal(normaliseCategory('mainstream'), 'established');
  assert.equal(normaliseCategory('established'), 'established');
  assert.equal(normaliseCategory('research-labs'), 'research-labs');
  assert.throws(() => normaliseCategory('not a slug'), /invalid category/i);
});

test('categoryOf defaults uncategorised entries without career-specific inference', () => {
  assert.equal(categoryOf({ company: 'Example Dynamics', tags: ['Founding Hardware'] }), 'startup');
  assert.equal(categoryOf({ company: 'Large Employer', role: 'Senior Designer' }), 'startup');
  assert.equal(categoryOf({ category: 'corporate', company: 'X' }), 'established');
});

test('commute helpers use practical car and public transport minutes', () => {
  const entry = { commute: { originPostcode: 'AB1 2CD', carMinutes: '45', publicTransportMinutes: 70, checked: '2026-07-08' } };
  assert.equal(commuteMinutes(entry, 'car'), 45);
  assert.equal(commuteMinutes(entry, 'public'), 70);
  assert.equal(commuteLabel(entry), 'car 45m / public 70m from AB1 2CD checked 2026-07-08');
});

test('commute filter defaults to either mode within 180 minutes', () => {
  assert.deepEqual(DEFAULT_COMMUTE_FILTER, { mode: 'either', maxMinutes: 180, includeUnknown: true });
  assert.equal(normaliseCommuteMode('public'), 'public');
  assert.throws(() => normaliseCommuteMode('teleport'), /invalid commute mode/i);
});

test('matchesCommute supports either, individual modes, any, and unknown handling', () => {
  const entry = { commute: { carMinutes: 190, publicTransportMinutes: 170 } };
  assert.equal(matchesCommute(entry, { mode: 'either', maxMinutes: 180 }), true);
  assert.equal(matchesCommute(entry, { mode: 'car', maxMinutes: 180 }), false);
  assert.equal(matchesCommute(entry, { mode: 'public', maxMinutes: 180 }), true);
  assert.equal(matchesCommute(entry, { mode: 'any', maxMinutes: 30 }), true);
  assert.equal(matchesCommute({}, { mode: 'either', maxMinutes: 180, includeUnknown: true }), true);
  assert.equal(matchesCommute({}, { mode: 'either', maxMinutes: 180, includeUnknown: false }), false);
});

test('filterOpportunities combines category and commute filters', () => {
  const rows = [
    { id: 'a', category: 'startup', commute: { carMinutes: 30 } },
    { id: 'b', category: 'established', commute: { carMinutes: 90 } },
    { id: 'c', category: 'startup', commute: { carMinutes: 75 } },
  ];
  const filtered = filterOpportunities(rows, { category: 'startup', commute: { mode: 'car', maxMinutes: 60 } });
  assert.deepEqual(filtered.map((e) => e.id), ['a']);
});
