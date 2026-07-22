import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectedModels, isSafeModelId, providerModels } from './providerModels.mjs';

test('Claude offers curated models merged with the ones used on this machine', () => {
  const models = providerModels('claude', { detected: ['claude-sonnet-5', 'claude-experimental-x'], configured: null });
  const ids = models.map((model) => model.id);
  assert.ok(ids.includes('claude-opus-4-8'));
  // A model seen locally but absent from the curated list is still offered.
  assert.ok(ids.includes('claude-experimental-x'));
  assert.equal(new Set(ids).size, ids.length, 'ids must be deduplicated');
  assert.equal(models.find((model) => model.id === 'claude-sonnet-5').detected, true);
  assert.equal(models.find((model) => model.id === 'claude-opus-4-8').detected, false);
});

test('Codex offers only the configured model, never a guessed identifier', () => {
  assert.deepEqual(providerModels('codex', { detected: [], configured: null }), []);
  assert.deepEqual(
    providerModels('codex', { detected: [], configured: 'gpt-5.6-sol' }).map((model) => model.id),
    ['gpt-5.6-sol'],
  );
});

test('unsafe identifiers never reach the picker', () => {
  assert.equal(isSafeModelId('claude-opus-4-8'), true);
  assert.equal(isSafeModelId('model & command'), false);
  const models = providerModels('claude', { detected: ['<synthetic>', 'rm -rf /'], configured: 'bad;id' });
  assert.equal(models.some((model) => !isSafeModelId(model.id)), false);
});

test('detection reads real Claude model ids and never guesses for Codex', () => {
  const detected = detectedModels({
    claude: { byModel: [{ model: 'claude-opus-4-8' }, { model: '<synthetic>' }] },
    codex: { models: ['codex-auto-review'] },
  });
  assert.deepEqual(detected.claude, ['claude-opus-4-8']);
  // Codex session logs record collaboration-mode names in the same field as
  // models, so nothing is detected for it.
  assert.deepEqual(detected.codex, []);
});
