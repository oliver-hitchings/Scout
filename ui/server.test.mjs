import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const previousWorkspace = process.env.SCOUT_WORKSPACE;
const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-server-test-'));
process.env.SCOUT_WORKSPACE = testWorkspace;
const { APP_ROOT, APP_VERSION, WORKSPACE_ROOT, createServer, restartControl } = await import('./server.mjs');

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
  fs.rmSync(testWorkspace, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('local server rejects a non-loopback Host header', async () => {
  const response = await request({ headers: { host: 'attacker.example' } });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'loopback host required' });
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

test('native quit does not use the public schedule action API', async () => {
  const host = `127.0.0.1:${port}`;
  const priorURL = process.env.SCOUT_HOST_CONTROL_URL;
  const priorToken = process.env.SCOUT_HOST_CONTROL_TOKEN;
  delete process.env.SCOUT_HOST_CONTROL_URL;
  delete process.env.SCOUT_HOST_CONTROL_TOKEN;
  try {
    const response = await request({
      method: 'POST', path: '/api/host/quit',
      headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
      body: JSON.stringify({ disableSchedule: false }),
    });
    assert.equal(response.status, 503);
    assert.match(JSON.parse(response.text).error, /desktop host is unavailable/i);
  } finally {
    if (priorURL === undefined) delete process.env.SCOUT_HOST_CONTROL_URL;
    else process.env.SCOUT_HOST_CONTROL_URL = priorURL;
    if (priorToken === undefined) delete process.env.SCOUT_HOST_CONTROL_TOKEN;
    else process.env.SCOUT_HOST_CONTROL_TOKEN = priorToken;
  }
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
