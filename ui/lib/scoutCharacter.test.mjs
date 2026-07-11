import test from 'node:test';
import assert from 'node:assert/strict';
import { activityState, framePosition, scoutDefinition } from './scoutCharacter.mjs';

test('unknown character state falls back to idle', () => {
  assert.equal(scoutDefinition('missing'), scoutDefinition('idle'));
});

test('frame position clamps and maps across the sprite grid', () => {
  const def = { columns: 4, frames: 16 };
  assert.deepEqual(framePosition(6, def), { column: 2, row: 1 });
  assert.deepEqual(framePosition(99, def), { column: 3, row: 3 });
});

test('tool activity maps to semantic Scout states', () => {
  assert.equal(activityState('reading job advert'), 'searching');
  assert.equal(activityState('editing applications/acme/cv.typ'), 'writing');
  assert.equal(activityState('unknown tool'), 'thinking');
});
