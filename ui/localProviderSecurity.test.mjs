import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { localProviderStatus, runLocalTurn, validateLocalProviderConfig } from './lib/localProvider.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-local-boundary-'));
const root = path.join(temporary, 'workspace');
fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
const previousWorkspace = process.env.SCOUT_WORKSPACE;
const previousDevice = process.env.SCOUT_DEVICE_SETTINGS;
process.env.SCOUT_WORKSPACE = root;
process.env.SCOUT_DEVICE_SETTINGS = path.join(temporary, 'device-settings.json');
const { APP_ROOT, createServer, drainScheduledCheckpoints, providerDetection, providerLoginControl } = await import('./server.mjs');
const { loadWorkspaceConfig, seedWorkspace, writeWorkspaceConfig } = await import('./lib/workspace.mjs');
const { saveSyncSettings } = await import('./lib/workspaceSync.mjs');
let server;
let port;
before(async () => {
  providerDetection.detect = async () => ({});
  seedWorkspace(APP_ROOT, root);
  fs.writeFileSync(process.env.SCOUT_DEVICE_SETTINGS, JSON.stringify({ schemaVersion: 2, remoteAccess: {
    enabled: true, ownerLogin: 'synthetic-owner@example.test', origin: 'https://scout.example.test',
  } }));
  // A synthetic enabled backup admits the real remote-owner route. No remote
  // is configured, so scheduled checkpoints cannot contact any repository.
  saveSyncSettings(root, { enabled: true, remoteUrl: null });
  server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(async () => {
  await drainScheduledCheckpoints();
  if (server) await new Promise((resolve) => server.close(resolve));
  await providerLoginControl.shutdown();
  if (previousWorkspace === undefined) delete process.env.SCOUT_WORKSPACE;
  else process.env.SCOUT_WORKSPACE = previousWorkspace;
  if (previousDevice === undefined) delete process.env.SCOUT_DEVICE_SETTINGS;
  else process.env.SCOUT_DEVICE_SETTINGS = previousDevice;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function settings(body, { remote = false } = {}) {
  const data = JSON.stringify(body);
  const headers = {
    host: remote ? 'scout.example.test' : `127.0.0.1:${port}`,
    origin: remote ? 'https://scout.example.test' : `http://127.0.0.1:${port}`,
    ...(remote ? { 'tailscale-user-login': 'synthetic-owner@example.test' } : {}),
    'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/setup/config', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }));
    });
    req.once('error', reject);
    req.end(data);
  });
}

test('remote-owner settings cannot change local transport or key selectors, including mixed updates', async () => {
  const config = loadWorkspaceConfig(root);
  config.ai.local = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'synthetic/model' };
  writeWorkspaceConfig(root, config);
  const before = fs.readFileSync(path.join(root, 'workspace.json'), 'utf8');
  for (const local of [
    { ...config.ai.local, baseUrl: 'https://model.example.test/v1' },
    { ...config.ai.local, apiKeyFile: '.scout/synthetic-credential' },
    {}, null,
  ]) {
    const response = await settings({ profile: { tone: 'Changed remotely' }, ai: { local } }, { remote: true });
    assert.equal(response.status, 403);
    assert.equal(response.body.reasonCode, 'local-provider-settings-local-only');
    assert.equal(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'), before);
  }
  // JSON object ordering must not turn an unchanged settings roundtrip into
  // an attempted transport change.
  const unchanged = await settings({ profile: { tone: 'Synthetic reviewed tone' }, ai: {
    local: { model: config.ai.local.model, baseUrl: config.ai.local.baseUrl },
  } }, { remote: true });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(loadWorkspaceConfig(root).ai.local, config.ai.local);
  await drainScheduledCheckpoints();
});

test('local settings reject an outside credential selector and public clear-text endpoint before saving', async () => {
  for (const local of [
    { baseUrl: 'http://127.0.0.1:8000/v1', model: 'synthetic/model', apiKeyFile: path.join(temporary, 'outside-credential') },
    { baseUrl: 'http://198.51.100.12/v1', model: 'synthetic/model' },
  ]) {
    const before = fs.readFileSync(path.join(root, 'workspace.json'), 'utf8');
    const response = await settings({ ai: { local } });
    assert.equal(response.status, 400);
    assert.equal(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'), before);
    assert.doesNotMatch(response.text, new RegExp(temporary));
  }
});

test('local key reads cannot forward readable files outside the approved secret directory', async (t) => {
  const key = randomBytes(24).toString('hex');
  const outside = path.join(temporary, 'outside-credential');
  fs.writeFileSync(outside, key, { mode: 0o600 });
  let calls = 0;
  const endpoint = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic response.' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { endpoint.closeAllConnections(); await new Promise((resolve) => endpoint.close(resolve)); });
  const local = { baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, model: 'synthetic/model', apiKeyFile: outside };
  const status = localProviderStatus({ local, root });
  assert.equal(status.authenticated, false);
  assert.equal(status.reasonCode, 'authentication-required');
  const result = await runLocalTurn({ status, prompt: 'Synthetic provider request.' }).finished;
  assert.equal(result.reasonCode, 'authentication-required');
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify({ status, result }), new RegExp(`${key}|${temporary}`));
});

test('local endpoint policy uses canonical IP addresses and rejects public HTTP aliases', () => {
  for (const baseUrl of [
    'http://198.51.100.12/v1', 'http://0xc633640c/v1', 'http://0306.063.0144.014/v1',
    'http://model.example.test/v1', 'http://127.model.example.test/v1', 'http://model.local/v1',
    'http://[::ffff:c633:640c]/v1', 'http://[2001:db8::1]/v1',
    'http://100.128.0.1/v1', 'http://172.32.0.1/v1', 'http://192.169.0.1/v1',
  ]) assert.throws(() => validateLocalProviderConfig({ baseUrl, model: 'synthetic/model' }), /HTTPS|private|loopback/);
  for (const baseUrl of [
    'https://model.example.test/v1', 'http://localhost:8000/v1', 'http://127.1/v1',
    'http://0x7f000001/v1', 'http://10.10.2.1/v1', 'http://172.16.0.1/v1',
    'http://192.168.2.1/v1', 'http://100.64.0.1/v1', 'http://100.127.255.254/v1',
    'http://[::1]/v1', 'http://[::ffff:c0a8:201]/v1', 'http://[fd7a:115c:a1e0::123]/v1',
  ]) assert.doesNotThrow(() => validateLocalProviderConfig({ baseUrl, model: 'synthetic/model' }));
});

test('local key selectors reject a linked ancestor escaping the owning workspace', { skip: process.platform === 'win32' }, () => {
  const external = path.join(temporary, 'external-secrets');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'credential'), randomBytes(24).toString('hex'));
  const link = path.join(root, '.scout', 'linked-secret-directory');
  fs.symlinkSync(external, link);
  const status = localProviderStatus({ root, local: {
    baseUrl: 'http://127.0.0.1:8000/v1', model: 'synthetic/model', apiKeyFile: path.join(link, 'credential'),
  } });
  assert.equal(status.authenticated, false);
  assert.equal(status.reasonCode, 'authentication-required');
});

test('legacy untrusted local settings remain readable for host repair without provider traffic', async (t) => {
  await drainScheduledCheckpoints();
  const file = path.join(root, 'workspace.json');
  const before = fs.readFileSync(file);
  const config = JSON.parse(before);
  config.ai.local = { baseUrl: 'http://198.51.100.12/v1', model: 'synthetic/model', apiKeyFile: path.join(temporary, 'outside-credential') };
  fs.writeFileSync(file, JSON.stringify(config));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected external provider request'); };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await drainScheduledCheckpoints();
    fs.writeFileSync(file, before);
  });
  assert.equal(loadWorkspaceConfig(root).ai.local.baseUrl, config.ai.local.baseUrl);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(config), 'reading cannot silently rewrite the workspace');
  const status = localProviderStatus({ local: config.ai.local, root });
  assert.equal(status.installed, false);
  assert.equal((await runLocalTurn({ status, prompt: 'Synthetic request.' }).finished).ok, false);
  assert.equal(calls, 0);
  const remote = await settings({ ai: { local: config.ai.local }, profile: { tone: 'Synthetic remote edit' } }, { remote: true });
  assert.equal(remote.status, 400, 'an unchanged legacy value must not acquire new persisted authority');
  const repaired = await settings({ ai: { local: { baseUrl: 'https://model.example.test/v1', model: 'synthetic/model' } } });
  assert.equal(repaired.status, 200);
  assert.equal(loadWorkspaceConfig(root).ai.local.baseUrl, 'https://model.example.test/v1');
  assert.equal(calls, 0);
});

test('case-insensitive Windows key containment cannot hang its ancestor walk', () => {
  // Exercise the real adapter/physical guard in a bounded child, modelling a
  // valid Windows filesystem whose selector and workspace differ only in case.
  // Before the fix the accepted path reaches the drive root and loops forever.
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { randomBytes } from 'node:crypto';
    import { localProviderStatus } from ${JSON.stringify(new URL('./lib/localProvider.mjs', import.meta.url).href)};
    const root = 'c:\\\\synthetic\\\\workspace';
    const file = 'C:\\\\SYNTHETIC\\\\WORKSPACE\\\\.scout\\\\model-key';
    const key = randomBytes(24).toString('hex');
    const fileStat = { dev: 1n, ino: 3n, size: BigInt(key.length), mtimeNs: 1n, ctimeNs: 1n,
      isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
    for (const name of ['resolve', 'relative', 'dirname', 'basename', 'join', 'isAbsolute']) path[name] = path.win32[name];
    path.sep = '\\\\';
    fs.existsSync = () => true;
    fs.realpathSync.native = (value) => String(value).toLowerCase();
    fs.lstatSync = (value) => path.basename(String(value)) === 'model-key' ? fileStat : {
      dev: 1n, ino: 2n, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
    fs.openSync = () => 42;
    fs.fstatSync = () => fileStat;
    fs.readSync = (_fd, buffer) => buffer.write(key);
    fs.closeSync = () => {};
    const status = localProviderStatus({ root, local: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'synthetic/model', apiKeyFile: file } });
    process.stdout.write(JSON.stringify({ authenticated: status.authenticated, reasonCode: status.reasonCode }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.status, 0, `Windows case-variant selector must settle: ${child.error?.code || child.stderr}`);
  assert.deepEqual(JSON.parse(child.stdout), { authenticated: true });
});
