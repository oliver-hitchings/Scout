#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeviceSettings, windowsStartupStatus } from '../ui/lib/deviceSettings.mjs';
import { remoteAccessStatus } from '../ui/lib/remoteAccess.mjs';
import { isMainModule } from '../ui/lib/mainModule.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function item(id, status, summary, detail) {
  return { id, status, summary, ...(detail ? { detail } : {}) };
}

function header(response, name) {
  return String(response?.headers?.get?.(name) || '').trim();
}

function validateLocalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK_NAMES.has(url.hostname)) {
    throw new Error('preflight URL must use HTTP on localhost or a loopback address');
  }
  return url;
}

function codeSafetyCheck(appRoot) {
  try {
    const server = fs.readFileSync(path.join(appRoot, 'ui', 'server.mjs'), 'utf8');
    const remote = fs.readFileSync(path.join(appRoot, 'ui', 'lib', 'remoteAccess.mjs'), 'utf8');
    const loopback = /server\.listen\(PORT,\s*['"]127\.0\.0\.1['"]\)/.test(server);
    const publicBind = /server\.listen\(PORT,\s*['"](?:0\.0\.0\.0|::)['"]\)/.test(server);
    const funnelCommand = /\[['"]funnel['"]|\[['"]serve['"],\s*['"]funnel['"]/.test(remote);
    return loopback && !publicBind && !funnelCommand
      ? item('network-policy', 'pass', 'Scout is configured for loopback-only hosting and no Funnel command')
      : item('network-policy', 'fail', 'Scout network policy could not be verified');
  } catch (error) {
    return item('network-policy', 'fail', 'Scout network policy files could not be inspected', error.message);
  }
}

async function localHttpChecks(base, fetchFn) {
  const checks = [];
  try {
    const response = await fetchFn(new URL('/api/remote-access/status', base), {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    let body = {};
    try { body = await response.json(); } catch { /* reported by the health check below */ }
    checks.push(response.ok && body.requestAccess === 'local'
      ? item('local-api', 'pass', 'Local Scout API is reachable and classified as local')
      : item('local-api', 'fail', `Local Scout API returned HTTP ${response.status || 'unknown'} or an unexpected access class`));
    const missing = [
      ['content-security-policy', 'CSP'], ['x-frame-options', 'frame blocking'],
      ['x-content-type-options', 'MIME-sniffing protection'], ['referrer-policy', 'referrer policy'],
    ].filter(([name]) => !header(response, name)).map(([, label]) => label);
    checks.push(missing.length
      ? item('security-headers', 'fail', `Missing security headers: ${missing.join(', ')}`)
      : item('security-headers', 'pass', 'Security headers are present'));
    checks.push(/(?:^|,)\s*no-store\b/i.test(header(response, 'cache-control'))
      ? item('private-cache-policy', 'pass', 'API responses are marked no-store')
      : item('private-cache-policy', 'fail', 'API response is not marked no-store'));
  } catch (error) {
    checks.push(item('local-api', 'fail', 'Local Scout API is unavailable', error.message));
  }

  try {
    const response = await fetchFn(new URL('/manifest.webmanifest', base), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const contentType = header(response, 'content-type');
    const manifest = response.ok ? await response.json() : {};
    checks.push(response.ok && /manifest\+json/i.test(contentType) && manifest.start_url
      ? item('pwa-manifest', 'pass', 'Installable web-app manifest is available')
      : item('pwa-manifest', 'fail', 'Installable web-app manifest is missing or invalid'));
  } catch (error) {
    checks.push(item('pwa-manifest', 'fail', 'Installable web-app manifest is unavailable', error.message));
  }
  return checks;
}

export async function runRemoteHostingPreflight({
  url = 'http://127.0.0.1:8459', requireEnabled = false, fetchFn = globalThis.fetch,
  loadSettings = loadDeviceSettings, remoteStatus = remoteAccessStatus,
  startupStatus = windowsStartupStatus, platform = process.platform, appRoot = APP_ROOT,
} = {}) {
  const base = validateLocalUrl(url);
  const checks = [codeSafetyCheck(appRoot)];
  let remote = null;
  try {
    remote = remoteStatus(loadSettings());
    if (remote.state === 'enabled') checks.push(item('tailscale-mapping', 'pass', 'Scout-owned Tailscale Serve mapping is present'));
    else if (requireEnabled) checks.push(item('tailscale-mapping', 'fail', 'Private Remote Access is not ready', remote.blocker || remote.state));
    else checks.push(item('tailscale-mapping', 'warn', 'Private Remote Access is not enabled', remote.blocker || remote.state));
  } catch (error) {
    checks.push(item('tailscale-mapping', requireEnabled ? 'fail' : 'warn', 'Tailscale state could not be verified', error.message));
  }

  if (platform === 'win32') {
    const startup = startupStatus();
    if (startup.enabled) checks.push(item('windows-startup', 'pass', 'Supervised Windows startup task is registered'));
    else checks.push(item('windows-startup', remote?.state === 'enabled' ? 'warn' : 'skip', 'Automatic Windows startup is not enabled', startup.error));
  } else {
    checks.push(item('windows-startup', 'skip', 'Windows startup task does not apply on this host'));
  }

  checks.push(...await localHttpChecks(base, fetchFn));
  const counts = Object.fromEntries(['pass', 'warn', 'fail', 'skip'].map((status) => [status, checks.filter((check) => check.status === status).length]));
  return {
    ok: counts.fail === 0,
    generatedAt: new Date().toISOString(),
    target: base.origin,
    requireEnabled: Boolean(requireEnabled),
    summary: counts,
    checks,
    remainingManualChecks: [
      'Connect from a phone on mobile data',
      'Confirm a different Tailscale identity receives 403',
      'Kill ScoutRuntime.exe and confirm watchdog recovery',
      'Reboot, sign in, and confirm access within 90 seconds',
    ],
  };
}

function argument(name, argv) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  runRemoteHostingPreflight({
    url: argument('--url', argv) || 'http://127.0.0.1:8459',
    requireEnabled: argv.includes('--require-enabled'),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
