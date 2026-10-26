import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mergeWorkspaceDefaults, seedWorkspace, writeWorkspaceConfig } from '../../ui/lib/workspace.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROVIDER_FIXTURE = fs.readFileSync(new URL('./fixtures/provider.mjs', import.meta.url), 'utf8');
const OFFLINE_FIXTURE = new URL('./fixtures/offline.mjs', import.meta.url).href;
const RUNTIME_CONTROL = new URL('./fixtures/runtime-control.mjs', import.meta.url).href;
const OPPORTUNITY_ID = 'synthetic-acceptance-role';
const REQUEST = 'Review this synthetic opportunity.';
const wait = (duration = 25) => new Promise((resolve) => setTimeout(resolve, duration));

async function until(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function command(args, { runtimeControl = false, ...options }) {
  const preloads = ['--import', OFFLINE_FIXTURE, ...(runtimeControl ? ['--import', RUNTIME_CONTROL] : [])];
  const child = spawn(process.execPath, [...preloads, ...args], { ...options, windowsHide: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe', ...(runtimeControl ? ['ipc'] : [])] });
  const result = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (value) => { result.stdout += value; });
  child.stderr.setEncoding('utf8').on('data', (value) => { result.stderr += value; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ ...result, status, signal }));
  });
  return { child, result, closed };
}

function events(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    event: block.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}'),
  }));
}

function workspaceContents(root) {
  return fs.readdirSync(root, { withFileTypes: true }).map((entry) => {
    const file = path.join(root, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    return entry.isDirectory() ? workspaceContents(file) : fs.readFileSync(file, 'utf8');
  }).join('\n');
}

async function fixture(t, provider, remote) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-acceptance-')));
  let server;
  t.after(async () => {
    if (server && server.child.exitCode === null) {
      // The real shutdown route drains managed login/provider children on
      // Windows too; terminating only the server would orphan those children.
      try { await request('/api/shutdown', { method: 'POST', body: {} }); } catch { /* bounded fallback below */ }
      const timer = setTimeout(() => server.child.kill('SIGKILL'), 10_000);
      timer.unref();
      try { await server.closed; } finally { clearTimeout(timer); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'provider-home');
  const bin = path.join(home, process.platform === 'win32' ? 'AppData/Roaming/npm' : '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const controlFile = path.join(bin, 'control.json');
  const deviceCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const privateDiagnostic = `synthetic-private-diagnostic-${randomUUID()}`;
  const control = {
    codex: { remote: 'ready', loginSucceeds: false, deviceApproved: false },
    claude: { remote: 'ready', loginSucceeds: false, deviceApproved: false },
    deviceCode, privateDiagnostic,
  };
  control[provider].remote = remote;
  fs.writeFileSync(controlFile, JSON.stringify(control));
  for (const name of ['codex', 'claude']) {
    const script = path.join(bin, `${name}.mjs`);
    fs.writeFileSync(script, PROVIDER_FIXTURE);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      // A provider-owned executable in an isolated home is resolved before any
      // system installation. Its shebang launches Node without a shell shim.
      fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${PROVIDER_FIXTURE}`.replace(
        "const provider = path.basename(file, '.mjs');", "const provider = path.basename(file).replace(/\\.mjs$/, '');",
      ), { mode: 0o700 });
    }
  }
  seedWorkspace(APP_ROOT, workspace);
  writeWorkspaceConfig(workspace, mergeWorkspaceDefaults({
    mode: 'active', timezone: 'UTC',
    profile: { displayName: 'Synthetic profile' },
    ai: { provider, model: null },
    search: { roleFamilies: ['Synthetic Engineer'], locations: ['Remote'], exclusions: [], salaryMinimum: null },
    schedule: { jobs: [{ id: `${provider}-primary`, enabled: true, time: '00:00', days: [0, 1, 2, 3, 4, 5, 6], provider, mode: 'primary', model: null }] },
  }));
  fs.writeFileSync(path.join(workspace, 'profile/context.md'), 'Synthetic profile evidence. '.repeat(12));
  fs.writeFileSync(path.join(workspace, 'profile/calibration.md'), 'Synthetic calibration evidence. '.repeat(8));
  fs.writeFileSync(path.join(workspace, 'cv/master-cv.md'), 'Synthetic CV evidence. '.repeat(30));
  fs.writeFileSync(path.join(workspace, 'data/opportunities.json'), JSON.stringify({ opportunities: [{
    id: OPPORTUNITY_ID, company: 'Synthetic Studio', role: 'Synthetic Engineer', status: 'new',
    sources: ['https://example.test/synthetic-role'], score: 90,
  }] }));
  const port = await freePort();
  // Never inherit provider credentials or the real home. The fake CLIs are the
  // first installed candidates on every supported operating system.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => [
    'path', 'systemroot', 'comspec', 'pathext', 'windir', 'programfiles', 'programfiles(x86)',
  ].includes(key.toLowerCase())));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    TMPDIR: root, TEMP: root, TMP: root, SCOUT_WORKSPACE: workspace,
    SCOUT_DEVICE_SETTINGS: path.join(root, 'device-settings.json'), PORT: String(port),
  });
  const remoteLogin = remote === 'refresh-failed';
  if (remoteLogin) fs.writeFileSync(env.SCOUT_DEVICE_SETTINGS, JSON.stringify({
    remoteAccess: { enabled: true, ownerLogin: 'synthetic-owner', origin: 'https://scout.example.test' },
  }));
  server = command(['ui/server.mjs'], { cwd: APP_ROOT, env, runtimeControl: true });
  await until(() => {
    if (server.child.exitCode !== null) throw new Error('Synthetic Scout server exited before listening');
    return server.result.stdout.includes('Scout UI on');
  }, 'the synthetic Scout HTTP listener');
  const responses = [];
  function request(route, { method = 'GET', body, headers = {} } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
        host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(remoteLogin && route.startsWith('/api/provider-login/') ? {
          host: 'scout.example.test', origin: 'https://scout.example.test', 'tailscale-user-login': 'synthetic-owner',
        } : {}), ...headers,
      } }, (res) => {
        let output = '';
        res.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
        res.on('end', () => {
          const response = { status: res.statusCode, text: output, json: () => JSON.parse(output) };
          responses.push(output);
          resolve(response);
        });
      });
      req.setTimeout(20_000, () => req.destroy(new Error('Synthetic HTTP request timed out')));
      req.once('error', reject);
      req.end(text);
    });
  }
  const calls = () => fs.existsSync(path.join(bin, 'calls.jsonl'))
    ? fs.readFileSync(path.join(bin, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const change = (patch) => {
    const state = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    Object.assign(state[provider], patch);
    fs.writeFileSync(`${controlFile}.next`, JSON.stringify(state));
    fs.renameSync(`${controlFile}.next`, controlFile);
  };
  const health = () => JSON.parse(fs.readFileSync(path.join(workspace, '.scout/provider-health/v1', `${provider}.json`), 'utf8'));
  let controlId = 0;
  const runtimeControl = (action) => new Promise((resolve, reject) => {
    const id = ++controlId;
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Acceptance runtime control timed out: ${action}`)); }, 20_000);
    const onExit = () => { cleanup(); reject(new Error('Acceptance server exited during runtime control')); };
    const onMessage = (message) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      server.child.off('message', onMessage);
      server.child.off('exit', onExit);
    }
    server.child.on('message', onMessage);
    server.child.once('exit', onExit);
    server.child.send({ id, action });
  });
  const scheduled = async () => {
    await runtimeControl('hold-checkpoint');
    // These assertions exercise provider preflight with an idle workspace.
    // Settle the owned server's startup/coalesced backup before launching the
    // real scheduled command, which otherwise correctly queues on that fence.
    await runtimeControl('drain-checkpoints');
    const scan = command(['tools/scout.mjs', 'scan', '--workspace', workspace, '--provider', provider,
      '--mode', 'primary', '--scheduled', '--schedule-id', `${provider}-primary`], { cwd: APP_ROOT, env });
    const timer = setTimeout(() => scan.child.kill('SIGKILL'), 20_000);
    timer.unref();
    try { return await scan.closed; } finally {
      clearTimeout(timer);
      await runtimeControl('drain-checkpoints');
    }
  };
  return { root, workspace, env, server, responses, deviceCode, privateDiagnostic, request, calls, change, health, scheduled };
}

for (const [provider, failure] of [['claude', 'expired'], ['codex', 'revoked'], ['codex', 'refresh-failed']]) {
  test(`${provider} ${failure}: real processes preserve provider truth, scheduled evidence and explicit recovery`, { timeout: 90_000 }, async (t) => {
    const h = await fixture(t, provider, failure);
    const send = (body) => h.request('/api/chat/send', { method: 'POST', body: { id: OPPORTUNITY_ID, engine: provider, text: REQUEST, ...body } });
    const failed = await send();
    assert.equal(failed.status, 200);
    const error = events(failed.text).find((event) => event.event === 'error')?.data;
    assert.equal(error?.reasonCode, 'authentication-required', 'the HTTP response must identify the actual remote authentication failure');
    assert.ok(error.retry?.id, 'the failed request must have an explicit saved resend action');
    assert.equal(h.health().remoteAuthBarrier, true);
    assert.equal(h.health().state, 'sign-in-required');
    const firstAlert = h.health().alert;
    const turns = () => h.calls().filter((call) => call.provider === provider && call.kind === 'chat-turn').length;
    assert.equal(turns(), 1);
    for (let n = 0; n < 2; n += 1) {
      assert.equal((await h.request('/api/setup/status')).status, 200);
      assert.equal(h.health().remoteAuthBarrier, true, 'local credentials cannot clear remote revocation');
      const blocked = await h.scheduled();
      assert.equal(blocked.status, 1, 'the actual scheduler command must fail preflight');
      const blockedResult = JSON.parse(blocked.stdout);
      assert.equal(blockedResult.reason, 'sign-in-required', JSON.stringify({
        status: ['queued', 'skipped', 'failed'].includes(blockedResult.status) ? blockedResult.status : 'other',
        queued: blockedResult.status === 'queued',
        reason: blockedResult.reason === 'sign-in-required' ? 'sign-in-required' : blockedResult.reason == null ? 'missing' : 'other',
      }));
      assert.equal(turns(), 1, 'a blocked scheduler command must not send any provider work');
    }
    const banner = (await h.request('/api/provider-health')).json().providers.find((item) => item.provider === provider);
    assert.equal(banner.signInRequired, true);
    assert.deepEqual(banner.missedJobIds, [`${provider}-primary`]);
    assert.equal(h.health().alert.id, firstAlert.id);
    assert.equal(h.health().alert.createdAt, firstAlert.createdAt, 'repeated preflight belongs to one failure episode');
    const notifications = (await h.request('/api/notifications')).json();
    assert.equal(notifications.alerts.filter((item) => item.kind === 'provider' && item.provider === provider).length, 1);

    async function login({ retry = null, succeeds = false } = {}) {
      h.change({ loginSucceeds: succeeds, deviceApproved: false });
      const status = (await h.request(`/api/provider-login/status?provider=${provider}`)).json();
      const body = retry ? { provider, sessionId: retry } : { provider };
      const route = retry ? '/api/provider-login/retry' : '/api/provider-login/start';
      assert.equal((await h.request(route, { method: 'POST', body })).status, 403, 'login requires an owner-bound CSRF token');
      const started = await h.request(route, { method: 'POST', body, headers: { 'x-scout-provider-login-csrf': status.csrfToken } });
      assert.equal(started.status, 202);
      const sessionId = started.json().session.sessionId;
      const session = await until(async () => {
        const current = (await h.request(`/api/provider-login/status?provider=${provider}&sessionId=${sessionId}`)).json().session;
        return provider === 'claude' ? current.codeRequired && current : current.userCode && current;
      }, 'the actual provider login process');
      assert.equal(h.health().remoteAuthBarrier, true, 'starting sign-in must preserve authoritative remote expiry');
      const rejected = await h.request('/api/provider-login/code', { method: 'POST', body: { sessionId, code: randomUUID() }, headers: { origin: 'https://example.invalid' } });
      assert.equal(rejected.status, 403);
      if (provider === 'claude') {
        assert.equal((await h.request('/api/provider-login/code', { method: 'POST', body: { sessionId, code: randomUUID() },
          headers: { 'x-scout-provider-login-csrf': status.csrfToken } })).status, 200);
      } else {
        assert.equal(session.userCode, h.deviceCode);
        h.change({ deviceApproved: true });
      }
      return until(async () => {
        const current = (await h.request(`/api/provider-login/status?provider=${provider}&sessionId=${sessionId}`)).json().session;
        return ['succeeded', 'failed', 'cancelled', 'expired'].includes(current.state) && current;
      }, 'remote sign-in verification');
    }
    const rejectedLogin = await login();
    assert.equal(rejectedLogin.state, 'failed', 'local CLI login success alone must not authenticate expired credentials');
    assert.equal(rejectedLogin.reasonCode, provider === 'claude' ? 'credentials-expired' : 'health-confirmation-failed');
    assert.equal(h.health().remoteAuthBarrier, true);
    const recovered = await login({ retry: rejectedLogin.sessionId, succeeds: true });
    assert.equal(recovered.state, 'succeeded');
    assert.equal(h.health().state, 'ready');
    assert.equal(h.health().remoteAuthBarrier, false);
    assert.equal(turns(), 1, 'guided reconnection must never automatically resend chat');
    const readyBanner = (await h.request('/api/provider-health')).json().providers.find((item) => item.provider === provider);
    assert.equal(readyBanner.signInRequired, false);
    assert.deepEqual(readyBanner.missedJobIds, [`${provider}-primary`], 'missed scheduled work waits for an explicit choice');
    const resent = await send({ retryId: error.retry.id });
    assert.equal(events(resent.text).at(-1).event, 'done');
    assert.equal(turns(), 2);
    const replay = await send({ retryId: error.retry.id });
    assert.equal(replay.status, 409);
    assert.equal(turns(), 2, 'replaying a consumed resend action must not execute provider work');
    const transcript = JSON.parse(fs.readFileSync(path.join(h.workspace, 'data/chats', `${OPPORTUNITY_ID}.json`), 'utf8'));
    assert.equal(transcript.messages.filter((item) => item.role === 'user').length, 1);
    assert.equal(transcript.retry, undefined);
    assert.equal((await h.request('/api/notifications')).json().alerts.filter((item) => item.kind === 'provider' && item.provider === provider).length, 1);
    assert.equal(h.calls().filter((call) => call.kind === 'unexpected').length, 0);
    for (const call of h.calls().filter((item) => item.kind === 'login')) {
      assert.deepEqual(call.args, provider === 'claude' ? ['auth', 'login'] : ['login', '--device-auth']);
      assert.notEqual(call.pid, process.pid, 'login must run as an actual child process');
    }
    assert.equal(h.calls().filter((call) => call.provider === provider && call.kind === 'health-turn').length, 2);
    const resumedScan = await h.scheduled();
    assert.equal(resumedScan.status, 0, 'an explicit invocation after reconnecting must resume scheduled work');
    assert.equal(JSON.parse(resumedScan.stdout).ok, true);
    const cleared = (await h.request('/api/provider-health')).json().providers.find((item) => item.provider === provider);
    assert.deepEqual(cleared?.missedJobIds || [], []);
    const durable = workspaceContents(h.workspace);
    for (const marker of [h.deviceCode, h.privateDiagnostic]) {
      assert.equal(durable.includes(marker), false, 'ephemeral login codes and raw provider diagnostics must not be persisted');
      assert.equal((h.server.result.stdout + h.server.result.stderr).includes(marker), false, 'provider diagnostics must not reach server logs');
    }
    assert.equal(h.responses.some((response) => response.includes(h.privateDiagnostic)), false, 'raw provider diagnostics must not reach HTTP responses');
  });
}
