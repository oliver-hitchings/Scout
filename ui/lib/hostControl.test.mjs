import assert from 'node:assert/strict';
import test from 'node:test';
import { hostControlConfig, hostUpdate, hostWindowCommand } from './hostControl.mjs';

test('host control requires both private environment values', () => {
  assert.equal(hostControlConfig({}), null);
  assert.equal(hostControlConfig({ SCOUT_HOST_CONTROL_URL: 'http://127.0.0.1:1' }), null);
});
test('Node forwards a confirmed window quit without leaking the token', async () => {
  let request; await hostWindowCommand('/quit', {}, { env: { SCOUT_HOST_CONTROL_URL: 'http://127.0.0.1:1234', SCOUT_HOST_CONTROL_TOKEN: 'secret' }, fetchFn: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ accepted: true }) }; } });
  assert.equal(request.url, 'http://127.0.0.1:1234/v1/window/quit'); assert.equal(request.options.headers['x-scout-host-token'], 'secret');
});
test('Node proxies host updates without exposing its token', async () => {
  let request; const result = await hostUpdate('/check', { force: true }, { env: { SCOUT_HOST_CONTROL_URL: 'http://127.0.0.1:1234/', SCOUT_HOST_CONTROL_TOKEN: 'secret' }, fetchFn: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ available: false }) }; } });
  assert.deepEqual(result, { available: false }); assert.equal(request.url, 'http://127.0.0.1:1234/v1/updates/check'); assert.equal(request.options.headers['x-scout-host-token'], 'secret');
});
