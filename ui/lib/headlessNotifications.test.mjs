import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';
// Hosted Node tool caches may be group-writable. Exercise the production
// protected-executable boundary with an owner-only disposable copy instead.
const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-protected-runtime-'));
const protectedRuntime = process.platform === 'win32' ? process.execPath : path.join(runtimeDirectory, 'node');
if (process.platform !== 'win32') { fs.copyFileSync(process.execPath, protectedRuntime); fs.chmodSync(protectedRuntime, 0o700); }
after(() => fs.rmSync(runtimeDirectory, { recursive: true, force: true }));
const alert = { id: 'a'.repeat(64), kind: 'digest', provider: null, count: 2, createdAt: '2026-10-26T08:00:00.000Z', title: 'PRIVATE', body: 'PRIVATE' };

test('headless notification dispatch is off by default and does not touch the outbox', async () => {
  const { dispatchHeadlessNotifications } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-off-'));
  try {
    assert.deepEqual(await dispatchHeadlessNotifications(root, { api: { refreshNotificationDigest() { throw new Error('must not read'); } } }), { enabled: false, delivered: 0, failed: 0 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('headless webhook sends only allowlisted alert data, rejects redirects, and receipts only success', async () => {
  const { dispatchHeadlessNotifications } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-http-'));
  let status = 302;
  const received = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ body: JSON.parse(body), key: req.headers['idempotency-key'] }); res.writeHead(status, { Location: 'http://example.invalid' }); res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const file = path.join(root, 'outbound.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, type: 'webhook', url: `http://127.0.0.1:${server.address().port}/notify` }), { mode: 0o600 });
  const marked = [];
  const api = { refreshNotificationDigest: () => ({ outbox: [alert] }), markNotification: (...args) => marked.push(args) };
  try {
    const failed = await dispatchHeadlessNotifications(root, { file, api, config: {} });
    assert.equal(failed.failed, 1); assert.equal(marked.length, 0);
    status = 204;
    const result = await dispatchHeadlessNotifications(root, { file, api, config: {} });
    assert.equal(result.delivered, 1); assert.equal(marked.length, 1);
    assert.equal(marked[0][1], alert.id); assert.equal(marked[0][2], 'delivered');
    assert.equal(received[0].key, alert.id);
    assert.doesNotMatch(JSON.stringify(received), /PRIVATE/);
    assert.equal(received[0].body.schemaVersion, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('headless command uses fixed argv with shell disabled and a minimal environment', async () => {
  const { sendHeadlessAlert, validateOutboundConfig } = await import('./headlessNotifications.mjs');
  let call;
  const config = validateOutboundConfig({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime, args: ['--synthetic', '$(never)'] });
  const result = await sendHeadlessAlert(config, alert, { root: os.tmpdir(), runCommand: async (...args) => { call = args; return { status: 0 }; } });
  assert.equal(result.ok, true);
  assert.equal(call[2].shell, false);
  assert.deepEqual(call[1].slice(0, 2), ['--synthetic', '$(never)']);
  assert.equal(JSON.parse(call[1][2]).notification.id, alert.id);
  assert.equal(call[2].env.OPENAI_API_KEY, undefined);
  assert.doesNotMatch(call[1][2], /PRIVATE/);
  assert.throws(() => validateOutboundConfig({ schemaVersion: 1, enabled: true, type: 'webhook', url: 'http://example.test/notify' }), /HTTPS|loopback/);
  assert.throws(() => validateOutboundConfig({ schemaVersion: 1, enabled: true, type: 'webhook', url: 'https://owner:secret@example.test/notify' }), /credentials/);
});

test('headless command delivery runs a real process with literal arguments and limits its lifetime', async () => {
  const { sendHeadlessAlert, validateOutboundConfig } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-command-'));
  try {
    const receipt = path.join(root, 'received.json');
    const config = validateOutboundConfig({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime,
      args: ['--input-type=module', '-e', 'import fs from "node:fs";fs.writeFileSync(process.argv[1],process.argv[2]);', receipt] });
    assert.equal((await sendHeadlessAlert(config, alert, { root })).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(receipt)).notification.id, alert.id);
    const hangs = validateOutboundConfig({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime,
      args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 });
    assert.equal((await sendHeadlessAlert(hangs, alert, { root })).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a protected executable in a writable directory cannot be selected for outbound delivery', { skip: process.platform === 'win32' }, async () => {
  const { validateOutboundConfig } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-writable-parent-'));
  try {
    const command = path.join(root, 'command');
    fs.copyFileSync(process.execPath, command); fs.chmodSync(command, 0o700);
    fs.chmodSync(root, 0o770);
    assert.throws(() => validateOutboundConfig({ schemaVersion: 1, enabled: true, type: 'command', command, args: [] }), /protected.*director/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('outbound configuration cannot be borrowed through a linked workspace directory', async () => {
  const { loadOutboundConfig } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-links-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-other-'));
  try {
    fs.writeFileSync(path.join(other, 'outbound-notifications.json'), JSON.stringify({ schemaVersion: 1, enabled: false }), { mode: 0o600 });
    fs.symlinkSync(other, path.join(root, '.scout'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => loadOutboundConfig(root), /symlink|junction|linked/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('overlapping headless senders do not both deliver the same notification', async () => {
  const { dispatchHeadlessNotifications } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-overlap-'));
  const file = path.join(root, 'outbound.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime, args: [] }), { mode: 0o600 });
  let finish; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const api = { refreshNotificationDigest: () => ({ outbox: [alert] }), markNotification() {} };
  const first = dispatchHeadlessNotifications(root, { file, api, config: {}, send: () => new Promise((resolve) => { finish = resolve; started(); }) });
  try {
    await ready;
    assert.equal((await dispatchHeadlessNotifications(root, { file, api, config: {} })).busy, true);
    finish({ ok: true });
    assert.equal((await first).delivered, 1);
  } finally { finish?.({ ok: false }); await first; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a killed headless sender does not permanently lock subsequent delivery', async () => {
  const { dispatchHeadlessNotifications } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-crash-'));
  const file = path.join(root, 'outbound.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime, args: [] }), { mode: 0o600 });
  const moduleUrl = new URL('./headlessNotifications.mjs', import.meta.url).href;
  const source = `import { dispatchHeadlessNotifications } from ${JSON.stringify(moduleUrl)};
    setInterval(() => {}, 1000);
    await dispatchHeadlessNotifications(process.argv[1], { file: process.argv[2], config: {},
      api: { refreshNotificationDigest: () => ({ outbox: [${JSON.stringify(alert)}] }), markNotification() {} },
      send: async () => { process.send('sending'); return new Promise(() => {}); } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, file], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic sender did not acquire its lock')), 10000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', reject);
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
    const result = await dispatchHeadlessNotifications(root, { file, config: {},
      api: { refreshNotificationDigest: () => ({ outbox: [alert] }), markNotification() {} },
      send: async () => ({ ok: true }),
    });
    assert.equal(result.busy, undefined);
    assert.equal(result.delivered, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL'); await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime quiescence stops further outbound alerts after the current child closes', async () => {
  const { dispatchHeadlessNotifications } = await import('./headlessNotifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-outbound-drain-'));
  const file = path.join(root, 'outbound.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime, args: [] }), { mode: 0o600 });
  let admission = true; let sent = 0;
  try {
    const result = await dispatchHeadlessNotifications(root, { file, config: {},
      api: { refreshNotificationDigest: () => ({ outbox: [alert, { ...alert, id: 'b'.repeat(64) }] }), markNotification() {} },
      shouldContinue: () => admission,
      send: async () => { sent += 1; admission = false; return { ok: true }; },
    });
    assert.equal(sent, 1); assert.equal(result.delivered, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real notification digest reaches a headless hook once and preserves its delivery receipt', async () => {
  const { dispatchHeadlessNotifications } = await import('./headlessNotifications.mjs');
  const n = await import('./notifications.mjs');
  const { seedWorkspace } = await import('./workspace.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-real-outbound-'));
  try {
    seedWorkspace(path.resolve('.'), root);
    const state = n.notificationsForAssessment(n.emptyNotifications(), { mode: 'active' }, [{ id: 'synthetic-job', score: 80, outcome: 'kept' }], '2026-01-01T08:00:00.000Z');
    fs.writeFileSync(n.notificationFile(root), JSON.stringify(state));
    const file = path.join(root, '.scout', 'outbound-notifications.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, type: 'command', command: protectedRuntime, args: [] }), { mode: 0o600 });
    const sent = [];
    const options = { config: { mode: 'active' }, send: async (_config, value) => { sent.push(value); return { ok: true }; } };
    assert.equal((await dispatchHeadlessNotifications(root, options)).delivered, 1);
    assert.equal(sent[0].kind, 'digest');
    assert.equal((await dispatchHeadlessNotifications(root, options)).delivered, 0);
    const view = n.notificationView(n.readNotifications(root));
    assert.equal(view.outbox.length, 0); assert.equal(view.alerts.length, 1);
    assert.ok(view.alerts[0].deliveredAt); assert.equal(view.alerts[0].acknowledgedAt, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local provider failures use the real notification outbox and retain a provider-specific label', async () => {
  const n = await import('./notifications.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-local-outbound-'));
  try {
    n.enqueueProviderNotificationUnderFence(root, { provider: 'local', state: 'network-unavailable', alert: { createdAt: '2026-10-26T08:00:00.000Z' } });
    const view = n.notificationView(n.readNotifications(root));
    assert.equal(view.outbox.length, 1); assert.equal(view.outbox[0].provider, 'local');
    assert.equal(view.outbox[0].title, 'Local model provider warning');
    n.markNotification(root, view.outbox[0].id, 'delivered');
    assert.equal(n.notificationView(n.readNotifications(root)).outbox.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
