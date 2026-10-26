import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { runProviderCommand } from './providers.mjs';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';
import { loadWorkspaceConfig } from './workspace.mjs';

export function validateOutboundConfig(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') throw new Error('outbound notification configuration is invalid');
  if (!value.enabled) return { schemaVersion: 1, enabled: false };
  const timeoutMs = value.timeoutMs ?? 8000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('notification timeout must be from 100 to 10000 milliseconds');
  if (value.type === 'command') {
    if (!path.isAbsolute(value.command || '') || !Array.isArray(value.args) || value.args.length > 32
      || value.args.some((arg) => typeof arg !== 'string' || arg.length > 2000 || arg.includes('\0'))) throw new Error('notification command requires an absolute executable and bounded argv');
    const command = fs.realpathSync(value.command);
    const stat = fs.statSync(command);
    if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o022) || !(stat.mode & 0o111)))) throw new Error('notification executable must be a protected executable file');
    return { schemaVersion: 1, enabled: true, type: 'command', command, args: value.args, timeoutMs };
  }
  if (value.type === 'webhook') {
    let url;
    try { url = new URL(value.url); } catch { throw new Error('notification webhook URL is invalid'); }
    if (url.username || url.password || url.hash || url.search) throw new Error('notification webhook must not contain credentials, a query or a fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('notification webhook requires HTTPS or a literal loopback HTTP address');
    if (url.href.length > 2000) throw new Error('notification webhook URL is too long');
    return { schemaVersion: 1, enabled: true, type: 'webhook', url: url.href, timeoutMs };
  }
  throw new Error('notification type must be command or webhook');
}

export function loadOutboundConfig(root, { file = process.env.SCOUT_NOTIFICATION_CONFIG || path.join(root, '.scout', 'outbound-notifications.json') } = {}) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, enabled: false };
  if (!process.env.SCOUT_NOTIFICATION_CONFIG && path.resolve(file) === path.join(path.resolve(root), '.scout', 'outbound-notifications.json')) {
    validatePhysicalWorkspacePath(root, file, 'outbound configuration');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('outbound configuration must be a small ordinary file');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error('outbound configuration must be owned by the Scout user with mode 0600');
  return validateOutboundConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function payloadFor(alert) {
  if (!/^[a-f0-9]{64}$/.test(alert?.id || '') || !['match', 'digest', 'provider'].includes(alert.kind)
    || !Number.isSafeInteger(alert.count) || alert.count < 1 || alert.count > 10000
    || !Number.isFinite(Date.parse(alert.createdAt || ''))) throw new Error('outbound notification is invalid');
  return { schemaVersion: 1, notification: {
    id: alert.id, kind: alert.kind, count: alert.count,
    provider: ['codex', 'claude', 'local'].includes(alert.provider) ? alert.provider : null,
    createdAt: new Date(alert.createdAt).toISOString(),
  } };
}

export async function sendHeadlessAlert(config, alert, { root, runCommand = runProviderCommand } = {}) {
  const payload = JSON.stringify(payloadFor(alert));
  if (config.type === 'command') {
    const env = { PATH: process.platform === 'win32' ? path.dirname(process.execPath) : '/usr/bin:/bin',
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const result = await runCommand(config.command, [...config.args, payload], {
      cwd: root, env, shell: false, windowsHide: true, timeoutMs: config.timeoutMs, maxOutputBytes: 4096,
    });
    return { ok: result.status === 0 && !result.error && !result.timedOut && !result.outputExceeded };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok }); } };
    const client = new URL(config.url).protocol === 'https:' ? https : http;
    const request = client.request(config.url, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'idempotency-key': alert.id,
    } }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes > 64 * 1024) { request.destroy(); finish(false); } });
      response.on('end', () => finish(response.statusCode >= 200 && response.statusCode < 300));
      response.on('error', () => finish(false));
      response.on('aborted', () => finish(false));
    });
    request.on('error', () => finish(false));
    timer = setTimeout(() => { request.destroy(); finish(false); }, config.timeoutMs);
    request.end(payload);
  });
}

// One sender per workspace, shared by the daemon and CLI. A crash preserves the
// lock for owner inspection; it never permits overlapping delivery on a guess.
export async function dispatchHeadlessNotifications(root, { file, api, config, send = sendHeadlessAlert, shouldContinue = () => true } = {}) {
  const outbound = loadOutboundConfig(root, { ...(file ? { file } : {}) });
  if (!outbound.enabled) return { enabled: false, delivered: 0, failed: 0 };
  const runtime = path.join(root, '.scout');
  validatePhysicalWorkspacePath(root, runtime, 'outbound storage');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lock = validatePhysicalWorkspacePath(root, path.join(runtime, 'outbound-dispatch.lock'), 'outbound lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') return { enabled: true, busy: true, delivered: 0, failed: 0 };
    throw error;
  }
  let delivered = 0; let failed = 0;
  try {
    api ||= await import('./notifications.mjs');
    const view = api.refreshNotificationDigest(root, config || loadWorkspaceConfig(root));
    for (const alert of view.outbox.slice(0, 16)) {
      if (!shouldContinue()) break;
      try {
        if (!(await send(outbound, alert, { root })).ok) { failed += 1; break; }
        api.markNotification(root, alert.id, 'delivered');
        delivered += 1;
      } catch { failed += 1; break; }
    }
    return { enabled: true, delivered, failed };
  } finally { fs.rmdirSync(lock); }
}
