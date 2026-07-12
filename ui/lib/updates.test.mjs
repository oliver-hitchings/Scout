import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdate, compareVersions } from './updates.mjs';

test('beta versions compare numerically', () => {
  assert.equal(compareVersions('0.1.0-beta.10', '0.1.0-beta.9'), 1);
  assert.equal(compareVersions('v0.1.0-beta.7', '0.1.0-beta.7'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.99'), 1);
});

test('update check selects a newer verified Scout release URL', async () => {
  const result = await checkForUpdate('0.1.0-beta.7', async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.1.0-beta.8', draft: false, html_url: 'https://github.com/oliver-hitchings/Scout/releases/tag/v0.1.0-beta.8' },
  ] }));
  assert.equal(result.available, true); assert.equal(result.latestVersion, '0.1.0-beta.8');
});

test('update check rejects a non-Scout release URL', async () => {
  const result = await checkForUpdate('0.1.0-beta.7', async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.1.0-beta.8', draft: false, html_url: 'https://example.test/release' },
  ] }));
  assert.equal(result.available, false); assert.equal(result.url, null);
});
