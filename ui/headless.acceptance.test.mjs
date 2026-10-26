import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch { /* process is still starting */ }
    await pause(25);
  }
  throw new Error('synthetic headless acceptance timed out');
}

test('real headless daemon delivers without a tray and keeps its workspace when household selection changes', async () => {
  const { createHouseholdInstance, switchHouseholdInstance } = await import('./lib/household.mjs');
  const { seedWorkspace } = await import('./lib/workspace.mjs');
  const n = await import('./lib/notifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-headless-process-'));
  const registry = path.join(root, 'household.json');
  const deliveries = [];
  const receiver = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { deliveries.push(JSON.parse(body)); res.writeHead(204); res.end(); });
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
    child = spawn(process.execPath, ['ui/server.mjs'], { env, stdio: 'ignore', shell: false });
    closed = once(child, 'close');
    const base = `http://127.0.0.1:${port}`;
    await until(() => deliveries.length === 1);
    const firstSummary = await until(async () => {
      const response = await fetch(`${base}/api/summary`);
      if (!response.ok) return null;
      const body = await response.json();
      return body.pendingAlerts[0]?.delivered ? body : null;
    });
    assert.equal(firstSummary.newMatches[0].id, 'synthetic-first');
    assert.doesNotMatch(JSON.stringify(deliveries), /Synthetic role|workspace|profile|cv/i);
    switchHouseholdInstance(second.id, { file: registry });
    const stillFirst = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(stillFirst.newMatches[0].id, 'synthetic-first');
    const next = spawnSync(process.execPath, ['--input-type=module', '-e', "const s=await import('./ui/server.mjs');console.log(JSON.stringify({workspace:s.WORKSPACE_ROOT,port:s.PORT}));"], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(JSON.parse(next.stdout), { workspace: second.workspace, port: second.port });
    assert.equal(n.notificationView(n.readNotifications(first.workspace)).outbox.length, 0);
    assert.equal(n.readNotifications(second.workspace).alerts.length, 0);
  } finally {
    if (child) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      timer.unref();
      child.kill('SIGTERM');
      try { await closed; } finally { clearTimeout(timer); }
    }
    await new Promise((resolve) => receiver.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
