import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const previousWorkspace = process.env.SCOUT_WORKSPACE;
const previousDeviceSettings = process.env.SCOUT_DEVICE_SETTINGS;
const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-server-test-'));
process.env.SCOUT_WORKSPACE = testWorkspace;
process.env.SCOUT_DEVICE_SETTINGS = path.join(testWorkspace, 'device-settings.json');
const { APP_ROOT, APP_VERSION, WORKSPACE_ROOT, createServer, restartControl, shutdownControl } = await import('./server.mjs');

let server;
let port;

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (previousWorkspace === undefined) delete process.env.SCOUT_WORKSPACE;
  else process.env.SCOUT_WORKSPACE = previousWorkspace;
  if (previousDeviceSettings === undefined) delete process.env.SCOUT_DEVICE_SETTINGS;
  else process.env.SCOUT_DEVICE_SETTINGS = previousDeviceSettings;
  fs.rmSync(testWorkspace, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('local server rejects a non-loopback Host header', async () => {
  const response = await request({ headers: { host: 'attacker.example' } });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'private remote access is not enabled for this address' });
});

test('production server remains loopback-only and never configures public Funnel access', () => {
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /server\.listen\(PORT, '127\.0\.0\.1'\)/);
  assert.doesNotMatch(source, /0\.0\.0\.0|tailscale funnel/i);
});

test('security headers protect pages and private APIs are never cacheable', async () => {
  const page = await request({ path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*'unsafe-inline'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  const api = await request({ path: '/api/app-info' });
  assert.equal(api.headers['cache-control'], 'no-store');
});

test('remote pages and APIs require the configured Tailscale owner', async () => {
  fs.writeFileSync(process.env.SCOUT_DEVICE_SETTINGS, JSON.stringify({
    schemaVersion: 2,
    remoteAccess: {
      enabled: true,
      ownerLogin: 'owner@example.com',
      origin: 'https://scout-host.example.ts.net',
      httpsPort: 443,
      managedMapping: { protocol: 'https', port: 443, target: 'http://127.0.0.1:8459' },
    },
  }));
  const missing = await request({ headers: { host: 'scout-host.example.ts.net' } });
  assert.equal(missing.status, 403);
  const wrong = await request({ headers: { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'other@example.com' } });
  assert.equal(wrong.status, 403);
  const owner = await request({ path: '/api/app-info', headers: { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'OWNER@example.com' } });
  assert.equal(owner.status, 200);
  assert.equal(JSON.parse(owner.text).name, 'Scout');
  assert.equal(owner.headers['strict-transport-security'], 'max-age=31536000');
  const alteredOrigin = await request({ path: '/api/app-info', headers: { host: 'scout-host.example.ts.net', origin: 'https://other.example.ts.net', 'tailscale-user-login': 'owner@example.com' } });
  assert.equal(alteredOrigin.status, 403);
});

test('remote owner mutations require HTTPS Origin and administration remains local-only', async () => {
  const remote = { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'owner@example.com', 'content-type': 'application/json' };
  const noOrigin = await request({ method: 'POST', path: '/api/chat/stop', headers: remote, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const badOrigin = await request({ method: 'POST', path: '/api/chat/stop', headers: { ...remote, origin: 'https://changed.example.ts.net' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const ownerChat = await request({ method: 'POST', path: '/api/chat/stop', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: JSON.stringify({ id: 'none' }) });
  assert.equal(ownerChat.status, 200);
  const localOnly = await request({ method: 'POST', path: '/api/remote-access/disable', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: '{}' });
  assert.equal(localOnly.status, 403);
  assert.match(JSON.parse(localOnly.text).error, /only be changed on the Scout host/);
});

test('streamed chat endpoints reject missing Tailscale identity before opening SSE', async () => {
  const response = await request({
    method: 'POST', path: '/api/chat/send',
    headers: { host: 'scout-host.example.ts.net', origin: 'https://scout-host.example.ts.net', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'example', engine: 'codex', text: 'hello' }),
  });
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.headers['content-type'] || '', /event-stream/);
});

test('forwarding headers cannot turn local access into a remote request', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST', path: '/api/chat/stop',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json', 'x-forwarded-host': 'attacker.example', 'tailscale-user-login': 'other@example.com' },
    body: JSON.stringify({ id: 'none' }),
  });
  assert.equal(response.status, 200);
});

test('chat mutations reject a cross-origin browser request', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: {
      host: `127.0.0.1:${port}`,
      origin: 'https://attacker.example',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'same-origin request required' });
});

test('chat mutations reject a different Origin scheme on the same host', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: { host, origin: `https://${host}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'same-origin request required' });
});

test('chat mutations require application/json', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.status, 415);
  assert.deepEqual(JSON.parse(response.text), { error: 'application/json required' });
});

test('normal same-origin JSON chat mutations still work', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ id: 'no-running-turn' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { ok: true, stopped: false });
});

test('app identity reports the serving build and private workspace', async () => {
  const response = await request({ path: '/api/app-info' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    name: 'Scout', version: APP_VERSION, appRoot: APP_ROOT, workspaceRoot: WORKSPACE_ROOT,
  });
});

test('restart responds first, then schedules the respawn', async () => {
  const originalRespawn = restartControl.respawn;
  let respawned = false;
  restartControl.respawn = () => { respawned = true; };
  try {
    const host = `127.0.0.1:${port}`;
    const response = await request({
      method: 'POST',
      path: '/api/restart',
      headers: { host, origin: `http://${host}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { ok: true, restarting: true });
    assert.equal(respawned, false, 'respawn must happen after the response is sent');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(respawned, true);
  } finally {
    restartControl.respawn = originalRespawn;
  }
});

test('restart rejects a cross-origin browser request', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/restart',
    headers: { host: `127.0.0.1:${port}`, origin: 'https://attacker.example' },
  });
  assert.equal(response.status, 403);
});

test('bounded setup mutations require same-origin JSON requests', async () => {
  const host = `127.0.0.1:${port}`;
  const wrongType = await request({
    method: 'POST', path: '/api/setup/proposal', headers: { host, origin: `http://${host}`, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const crossOrigin = await request({
    method: 'POST', path: '/api/setup/activate', headers: { host, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
});

test('pending recovery keys require same-origin JSON requests', async () => {
  const host = `127.0.0.1:${port}`;
  const wrongType = await request({
    method: 'POST', path: '/api/sync/recovery-key',
    headers: { host, origin: `http://${host}`, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const crossOrigin = await request({
    method: 'POST', path: '/api/sync/recovery-key',
    headers: { host, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
});

test('shutdown responds before scheduling process exit', async () => {
  const originalExit = shutdownControl.exit;
  let exited = false;
  shutdownControl.exit = () => { exited = true; };
  try {
    const host = `127.0.0.1:${port}`;
    const response = await request({
      method: 'POST',
      path: '/api/shutdown',
      headers: { host, origin: `http://${host}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { ok: true, shuttingDown: true });
    assert.equal(exited, false, 'exit must happen after the response is sent');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(exited, true);
  } finally {
    shutdownControl.exit = originalExit;
  }
});

test('shutdown rejects a cross-origin browser request', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/shutdown',
    headers: { host: `127.0.0.1:${port}`, origin: 'https://attacker.example' },
  });
  assert.equal(response.status, 403);
});

test('supervised scan requires a configured provider', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({ method: 'POST', path: '/api/scan', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /provider/i);
});

test('daily schedule is blocked before a healthy supervised scan', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', provider: 'codex', time: '07:30' }) });
  assert.equal(response.status, 409);
  assert.match(JSON.parse(response.text).error, /healthy supervised scan/i);
});

test('legacy CV downloads require a hash-bound explicit override', async () => {
  const slug = 'synthetic-quality';
  const app = path.join(testWorkspace, 'applications', slug);
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'cv.typ'), '#show: cv.with(name: "Example")\n');
  fs.writeFileSync(path.join(app, 'cv.pdf'), 'synthetic-pdf');

  const qualityResponse = await request({ path: `/api/cv/quality?slug=${slug}` });
  assert.equal(qualityResponse.status, 200);
  const quality = JSON.parse(qualityResponse.text);
  assert.equal(quality.status, 'legacy');

  const denied = await request({ path: `/api/cv/pdf?slug=${slug}&download=1` });
  assert.equal(denied.status, 409);
  assert.equal(JSON.parse(denied.text).overridable, true);

  const host = `127.0.0.1:${port}`;
  const accepted = await request({
    method: 'POST', path: '/api/cv/quality/override',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug, cvSha256: quality.cvSha256 }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.text).status, 'overridden');

  const downloaded = await request({ path: `/api/cv/pdf?slug=${slug}&download=1` });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.text, 'synthetic-pdf');
});
