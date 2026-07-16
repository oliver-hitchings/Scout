import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SCOUT_LOCAL_PORT = 8459;
export const DEFAULT_HTTPS_PORTS = Object.freeze([443, 8443]);

function resultOf(result) {
  return {
    ok: result?.status === 0,
    status: result?.status,
    stdout: String(result?.stdout || '').trim(),
    stderr: String(result?.stderr || '').trim(),
    error: String(result?.stderr || result?.stdout || 'Tailscale command failed').trim(),
  };
}

function run(executable, args, options = {}) {
  return resultOf((options.spawn || spawnSync)(executable, args, {
    encoding: 'utf8', windowsHide: true, timeout: options.timeout || 15000,
  }));
}

function candidates(platform = process.platform, env = process.env) {
  const values = ['tailscale'];
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    values.push(path.win32.join(programFiles, 'Tailscale', 'tailscale.exe'));
  } else if (platform === 'darwin') {
    values.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  }
  return [...new Set(values)];
}

export function detectTailscale(options = {}) {
  for (const executable of options.candidates || candidates(options.platform, options.env)) {
    const version = run(executable, ['version'], options);
    if (version.ok) return { installed: true, executable, version: version.stdout.split(/\r?\n/, 1)[0] };
  }
  return { installed: false, executable: null, version: null };
}

function parseJson(result, label) {
  if (!result.ok) throw new Error(result.error || `${label} failed`);
  try { return JSON.parse(result.stdout || '{}'); }
  catch { throw new Error(`${label} returned unreadable JSON`); }
}

export function tailscaleIdentity(status) {
  const self = status?.Self || status?.self || {};
  const users = status?.User || status?.user || {};
  const user = users[String(self.UserID ?? self.userId ?? '')] || self.User || self.user || {};
  const ownerLogin = String(user.LoginName || user.loginName || self.UserLogin || self.userLogin || '').trim();
  const dnsName = String(self.DNSName || self.dnsName || '').trim().replace(/\.$/, '');
  return {
    running: String(status?.BackendState || status?.backendState || '').toLowerCase() === 'running',
    ownerLogin,
    dnsName,
  };
}

function walk(value, visit, trail = []) {
  if (Array.isArray(value)) return value.forEach((item, index) => walk(item, visit, [...trail, String(index)]));
  if (!value || typeof value !== 'object') return visit(value, trail);
  for (const [key, child] of Object.entries(value)) walk(child, visit, [...trail, key]);
}

function mentionsPort(value, trail, port) {
  const wanted = String(port);
  if (trail.some((part) => {
    if (part === wanted || part.endsWith(`:${wanted}`) || part.includes(`:${wanted}/`)) return true;
    try {
      const url = new URL(part);
      return url.protocol === 'https:' && Number(url.port || 443) === port;
    } catch { return false; }
  })) return true;
  if (typeof value !== 'string') return false;
  return value === wanted || value.includes(`:${wanted}`);
}

export function servePortOccupied(status, port) {
  let occupied = false;
  walk(status, (value, trail) => { if (mentionsPort(value, trail, port)) occupied = true; });
  return occupied;
}

export function serveMappingPresent(status, port, targetPort = SCOUT_LOCAL_PORT) {
  let present = false;
  walk(status, (value, trail) => {
    if (typeof value === 'string'
        && /127\.0\.0\.1|localhost/i.test(value)
        && value.includes(`:${targetPort}`)
        && mentionsPort(value, trail, port)) present = true;
  });
  return present;
}

export function chooseHttpsPort(serveStatus, requestedPort) {
  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== '') {
    const value = Number(requestedPort);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('HTTPS port must be between 1 and 65535');
    if (servePortOccupied(serveStatus, value)) throw new Error(`Tailscale Serve port ${value} is already in use`);
    return value;
  }
  const available = DEFAULT_HTTPS_PORTS.find((port) => !servePortOccupied(serveStatus, port));
  if (!available) throw new Error('Tailscale Serve ports 443 and 8443 are already in use; choose another HTTPS port');
  return available;
}

function authorizationUrl(result) {
  const match = `${result.stdout}\n${result.stderr}`.match(/https:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.;]+$/, '') : null;
}

function originFor(dnsName, port) {
  return `https://${dnsName}${port === 443 ? '' : `:${port}`}`;
}

export function loadTailscaleState(options = {}) {
  const detected = detectTailscale(options);
  if (!detected.installed) return { detected, state: 'setup-required', blocker: 'Install Tailscale on this computer' };
  const statusResult = run(detected.executable, ['status', '--json'], options);
  let status;
  try { status = parseJson(statusResult, 'Tailscale status'); }
  catch (error) { return { detected, state: 'setup-required', blocker: error.message }; }
  const identity = tailscaleIdentity(status);
  if (!identity.running || !identity.ownerLogin || !identity.dnsName) {
    return { detected, identity, state: 'setup-required', blocker: 'Sign in to Tailscale and wait for it to connect' };
  }
  const serveResult = run(detected.executable, ['serve', 'status', '--json'], options);
  let serveStatus = {};
  if (!serveResult.ok && !/no serve (?:config|configuration)|not configured/i.test(serveResult.error)) {
    return { detected, identity, state: 'needs-attention', blocker: serveResult.error || 'Tailscale Serve status failed' };
  }
  if (serveResult.ok && serveResult.stdout) {
    try { serveStatus = JSON.parse(serveResult.stdout); }
    catch { return { detected, identity, state: 'needs-attention', blocker: 'Tailscale Serve status returned unreadable JSON' }; }
  }
  return { detected, identity, serveStatus, state: 'disabled' };
}

export function remoteAccessStatus(settings, options = {}) {
  const remote = settings?.remoteAccess || {};
  const state = loadTailscaleState(options);
  if (!remote.enabled || !remote.managedMapping) {
    if (state.serveStatus) {
      try { return { ...state, enabled: false, suggestedPort: chooseHttpsPort(state.serveStatus), customPortRequired: false }; }
      catch { return { ...state, enabled: false, suggestedPort: null, customPortRequired: true }; }
    }
    return { ...state, enabled: false };
  }
  if (!state.serveStatus) return { ...state, enabled: true };
  const present = serveMappingPresent(state.serveStatus, remote.httpsPort, SCOUT_LOCAL_PORT);
  return {
    ...state,
    enabled: true,
    state: present ? 'enabled' : 'needs-attention',
    origin: remote.origin,
    ownerLogin: remote.ownerLogin,
    httpsPort: remote.httpsPort,
    ...(present ? {} : { blocker: "Scout's Tailscale Serve mapping is missing or has changed" }),
  };
}

export function enableRemoteAccess(settings, { httpsPort } = {}, options = {}) {
  const current = settings?.remoteAccess || {};
  const state = loadTailscaleState(options);
  if (!state.detected?.installed || !state.identity || !state.serveStatus) return { ...state, enabled: false };
  if (current.enabled && current.managedMapping
      && serveMappingPresent(state.serveStatus, current.httpsPort, SCOUT_LOCAL_PORT)) {
    return { state: 'enabled', enabled: true, settings, origin: current.origin, ownerLogin: current.ownerLogin, httpsPort: current.httpsPort };
  }
  const port = chooseHttpsPort(state.serveStatus, httpsPort);
  const result = run(state.detected.executable, ['serve', '--bg', `--https=${port}`, String(SCOUT_LOCAL_PORT)], options);
  if (!result.ok) {
    const url = authorizationUrl(result);
    if (url) return { state: 'authorizing', enabled: false, authorizationUrl: url, blocker: 'Approve Tailscale HTTPS, then retry' };
    throw new Error(result.error);
  }
  const origin = originFor(state.identity.dnsName, port);
  const next = {
    ...settings,
    remoteAccess: {
      enabled: true,
      ownerLogin: state.identity.ownerLogin,
      origin,
      httpsPort: port,
      managedMapping: { protocol: 'https', port, target: `http://127.0.0.1:${SCOUT_LOCAL_PORT}` },
      configuredAt: new Date(options.now || Date.now()).toISOString(),
    },
  };
  return { state: 'enabled', enabled: true, settings: next, origin, ownerLogin: state.identity.ownerLogin, httpsPort: port };
}

export function disableRemoteAccess(settings, options = {}) {
  const remote = settings?.remoteAccess || {};
  if (!remote.enabled || !remote.managedMapping) {
    return { state: 'disabled', enabled: false, settings: { ...settings, remoteAccess: { enabled: false } } };
  }
  const state = loadTailscaleState(options);
  if (!state.detected?.installed) throw new Error('Tailscale is not installed; remove the Scout Serve mapping manually before uninstalling');
  if (state.serveStatus && !serveMappingPresent(state.serveStatus, remote.httpsPort, SCOUT_LOCAL_PORT)) {
    if (!servePortOccupied(state.serveStatus, remote.httpsPort)) {
      return { state: 'disabled', enabled: false, settings: { ...settings, remoteAccess: { enabled: false } } };
    }
    throw new Error('Scout will not remove this mapping because the Tailscale Serve configuration has changed');
  }
  const result = run(state.detected.executable, ['serve', `--https=${remote.httpsPort}`, String(SCOUT_LOCAL_PORT), 'off'], options);
  if (!result.ok) throw new Error(result.error);
  return { state: 'disabled', enabled: false, settings: { ...settings, remoteAccess: { enabled: false } } };
}
