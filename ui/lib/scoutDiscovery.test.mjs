import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryStorageKey, mergeAcknowledged, strongUnseenMatches } from './scoutDiscovery.mjs';

test('only unseen new matches at the action threshold are announced', () => {
  const entries = [
    { id: 'strong', status: 'new', score: 80 },
    { id: 'seen', status: 'new', score: 90 },
    { id: 'weak', status: 'new', score: 69 },
    { id: 'watch', status: 'watch', score: 95 },
  ];
  assert.deepEqual(strongUnseenMatches(entries, 70, ['seen']).map((x) => x.id), ['strong']);
});

test('acknowledgements deduplicate and workspace keys are isolated', () => {
  assert.deepEqual(mergeAcknowledged(['a'], [{ id: 'a' }, { id: 'b' }]), ['a', 'b']);
  assert.notEqual(discoveryStorageKey('one'), discoveryStorageKey('two'));
});
