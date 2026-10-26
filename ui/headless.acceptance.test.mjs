import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label = 'headless acceptance', state = () => ({})) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = state();
    if (Number.isInteger(current.exitCode) || typeof current.signal === 'string') {
      throw new Error(`synthetic headless process exited: ${label} ${JSON.stringify(current)}`);
    }
    try { const value = await fn(); if (value) return value; } catch { /* process is still starting */ }
    await pause(25);
  }
  throw new Error(`synthetic headless acceptance timed out: ${label} ${JSON.stringify(state())}`);
}

const RUNTIME_CONTROL = new URL('../tests/acceptance/fixtures/runtime-control.mjs', import.meta.url).href;
const RECEIPT_OBSERVER = `data:text/javascript,${encodeURIComponent(`
  import fs from 'node:fs';
  const read = fs.readFileSync;
  let observed = false;
  fs.readFileSync = (file, ...args) => {
    if (!observed && /scan-lease\\.json$/.test(String(file))
      && new Error().stack.includes('markNotification')) {
      observed = true;
      process.send?.({ event: 'receipt-attempt' });
    }
    return read(file, ...args);
  };
`)}`;

function control(child, action) {
  const id = `${action}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`headless control timed out: ${action}`)); }, 10000);
    const onExit = () => { cleanup(); reject(new Error(`headless process exited during ${action}`)); };
    const onMessage = (message) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(`headless control rejected: ${action}`));
      else resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ id, action });
  });
}

test('real headless daemon delivers without a tray and keeps its workspace when household selection changes', async () => {
  const { createHouseholdInstance, switchHouseholdInstance } = await import('./lib/household.mjs');
  const { seedWorkspace } = await import('./lib/workspace.mjs');
  const n = await import('./lib/notifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-headless-process-'));
  const registry = path.join(root, 'household.json');
  const deliveries = [];
  let acknowledge;
  const receiver = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      deliveries.push(JSON.parse(body));
      acknowledge = () => { res.writeHead(204); res.end(); };
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const portProbe = http.createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  let child; let closed;
  try {
    const options = { appRoot: path.resolve('.'), directory: root, file: registry, initialise: (directory) => seedWorkspace(path.resolve('.'), directory) };
    const first = createHouseholdInstance({ ...options, id: 'person-a', port });
    const second = createHouseholdInstance({ ...options, id: 'person-b', port: port === 65535 ? port - 1 : port + 1 });
    fs.writeFileSync(path.join(first.workspace, 'data', 'opportunities.json'), JSON.stringify({ opportunities: [
      { id: 'synthetic-first', company: 'Example', role: 'Synthetic role', score: 99, status: 'new', firstSeen: '2026-10-26' },
    ] }));
    n.enqueueProviderNotificationUnderFence(first.workspace, { provider: 'claude', state: 'network-unavailable', alert: { createdAt: '2026-10-26T08:00:00.000Z' } });
    fs.writeFileSync(path.join(first.workspace, '.scout', 'outbound-notifications.json'), JSON.stringify({ schemaVersion: 1, enabled: true, type: 'webhook', url: `http://127.0.0.1:${receiver.address().port}/notify` }), { mode: 0o600 });
    const env = { ...process.env, SCOUT_WORKSPACE: '', SCOUT_DEVICE_SETTINGS: '', PORT: '', SCOUT_HOUSEHOLD_SETTINGS: registry, SCOUT_NOTIFICATION_CONFIG: '' };
    child = spawn(process.execPath, ['--import', RUNTIME_CONTROL, '--import', RECEIPT_OBSERVER, 'ui/server.mjs'], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false });
    closed = once(child, 'close');
    let receiptAttempted = false; let healthReady = false;
    child.on('message', (message) => { if (message.event === 'receipt-attempt') receiptAttempted = true; });
    const base = `http://127.0.0.1:${port}`;
    const context = () => ({ healthReady, deliveries: deliveries.length, receiptAttempted, exitCode: child.exitCode, signal: child.signalCode });
    await until(async () => {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
      const body = await response.json();
      healthReady = body.schemaVersion === 1 && body.status === 'ready';
      return healthReady;
    }, 'real daemon health readiness', context);
    await until(() => deliveries.length === 1, 'webhook request from real daemon', context);
    // Force the exact CI interleaving: transport succeeds while the real
    // checkpoint child owns the workspace fence. The receipt must settle after
    // that fence closes, without another webhook request.
    await control(child, 'hold-checkpoint');
    acknowledge(); acknowledge = null;
    await until(() => receiptAttempted, 'delivery receipt attempt under checkpoint fence', context);
    await control(child, 'drain-checkpoints');
    const firstSummary = await until(async () => {
      const response = await fetch(`${base}/api/summary`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return null;
      const body = await response.json();
      return body.pendingAlerts[0]?.delivered ? body : null;
    }, 'persisted delivery receipt after checkpoint', context);
    assert.equal(firstSummary.newMatches[0].id, 'synthetic-first');
    assert.doesNotMatch(JSON.stringify(deliveries), /Synthetic role|workspace|profile|cv/i);
    switchHouseholdInstance(second.id, { file: registry });
    const stillFirst = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(stillFirst.newMatches[0].id, 'synthetic-first');
    const next = spawnSync(process.execPath, ['--input-type=module', '-e', "const s=await import('./ui/server.mjs');console.log(JSON.stringify({workspace:s.WORKSPACE_ROOT,port:s.PORT}));"], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(JSON.parse(next.stdout), { workspace: second.workspace, port: second.port });
    assert.equal(n.notificationView(n.readNotifications(first.workspace)).outbox.length, 0);
    assert.equal(deliveries.length, 1, 'receipt contention must not resend a successful webhook');
    assert.equal(n.readNotifications(second.workspace).alerts.length, 0);
  } finally {
    if (child) {
      acknowledge?.();
      if (child.exitCode === null) await control(child, 'drain-checkpoints').catch(() => {});
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      timer.unref();
      child.kill('SIGTERM');
      try { await closed; } finally { clearTimeout(timer); }
    }
    await new Promise((resolve) => receiver.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
