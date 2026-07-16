import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRemoteHostingPreflight } from './remote-hosting-preflight.mjs';

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-remote-preflight-'));
  fs.mkdirSync(path.join(root, 'ui', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ui', 'server.mjs'), "server.listen(PORT, '127.0.0.1');\n", 'utf8');
  fs.writeFileSync(path.join(root, 'ui', 'lib', 'remoteAccess.mjs'), "run(tailscale, ['serve', '--bg', '--https=443', '8459']);\n", 'utf8');
  return root;
}

function response(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => lower[name.toLowerCase()] || null },
    async json() { return body; },
  };
}

function healthyFetch(url) {
  if (String(url).endsWith('/manifest.webmanifest')) {
    return response({ name: 'Scout', start_url: '/' }, { headers: { 'content-type': 'application/manifest+json' } });
  }
  return response({ requestAccess: 'local' }, { headers: {
    'cache-control': 'no-store', 'content-security-policy': "default-src 'self'",
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  } });
}

test('preflight verifies enabled mapping, startup, local security and PWA without exposing owner login', async () => {
  const root = fixtureRoot();
  try {
    const result = await runRemoteHostingPreflight({
      appRoot: root, platform: 'win32', fetchFn: healthyFetch, requireEnabled: true,
      loadSettings: () => ({ remoteAccess: { enabled: true, ownerLogin: 'owner@example.com' } }),
      remoteStatus: () => ({ state: 'enabled', ownerLogin: 'owner@example.com' }),
      startupStatus: () => ({ enabled: true }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.summary.fail, 0);
    assert.equal(result.checks.every((check) => check.status === 'pass'), true);
    assert.doesNotMatch(JSON.stringify(result), /owner@example\.com/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disabled remote access is a warning unless enabled hosting is required', async () => {
  const root = fixtureRoot();
  try {
    const options = {
      appRoot: root, platform: 'linux', fetchFn: healthyFetch, loadSettings: () => ({}),
      remoteStatus: () => ({ state: 'disabled' }), startupStatus: () => ({ enabled: false }),
    };
    const optional = await runRemoteHostingPreflight(options);
    assert.equal(optional.ok, true);
    assert.equal(optional.checks.find((check) => check.id === 'tailscale-mapping').status, 'warn');
    const required = await runRemoteHostingPreflight({ ...options, requireEnabled: true });
    assert.equal(required.ok, false);
    assert.equal(required.checks.find((check) => check.id === 'tailscale-mapping').status, 'fail');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('preflight fails closed on missing security headers and non-loopback targets', async () => {
  const root = fixtureRoot();
  try {
    const result = await runRemoteHostingPreflight({
      appRoot: root, platform: 'linux', loadSettings: () => ({}), remoteStatus: () => ({ state: 'disabled' }),
      fetchFn: (url) => String(url).endsWith('/manifest.webmanifest')
        ? response({ name: 'Scout', start_url: '/' }, { headers: { 'content-type': 'application/manifest+json' } })
        : response({ requestAccess: 'local' }, { headers: { 'cache-control': 'private' } }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.id === 'security-headers').status, 'fail');
    await assert.rejects(() => runRemoteHostingPreflight({ url: 'https://example.com' }), /loopback/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
