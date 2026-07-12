import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Keep the established setup-section id for existing workspaces. The Wails host
// owns cross-platform launch-at-login registration; this legacy UI prompt is the
// Windows compatibility surface until the host settings bridge replaces it.
export const DEVICE_SETUP_SECTIONS = Object.freeze({ 'windows-startup': 1 });

export function deviceSettingsPath(env = process.env, platform = process.platform) {
  if (env.SCOUT_DEVICE_SETTINGS) return path.resolve(env.SCOUT_DEVICE_SETTINGS);
  const base = platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local'))
    : (env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'));
  if (platform === 'darwin') return path.join(env.HOME || os.homedir(), 'Library', 'Application Support', 'Scout', 'host-settings.json');
  return path.join(base, platform === 'win32' ? 'Scout' : 'scout', 'host-settings.json');
}

export function loadDeviceSettings(options = {}) {
  const file = options.file || deviceSettingsPath(options.env, options.platform);
  const defaults = { schemaVersion: 1, startWithWindows: false, completedSections: {}, deferredSections: {}, updates: { lastCheckedAt: null, lastNotifiedVersion: null } };
  if (!fs.existsSync(file)) return defaults;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaults, ...value, completedSections: { ...defaults.completedSections, ...(value.completedSections || {}) }, deferredSections: { ...defaults.deferredSections, ...(value.deferredSections || {}) }, updates: { ...defaults.updates, ...(value.updates || {}) } };
  } catch { return defaults; }
}

export function saveDeviceSettings(value, options = {}) {
  const file = options.file || deviceSettingsPath(options.env, options.platform);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return value;
}

export function pendingDeviceSections(settings, { platform = process.platform, now = Date.now() } = {}) {
  if (platform !== 'win32') return [];
  return Object.entries(DEVICE_SETUP_SECTIONS).filter(([id, version]) => {
    if (Number(settings.completedSections?.[id] || 0) >= version) return false;
    return new Date(settings.deferredSections?.[id] || 0).getTime() <= now;
  }).map(([id, version]) => ({ id, version, blocking: false, title: 'Start Scout with Windows' }));
}

export function setWindowsStartup(enabled, hostPath, { spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, supported: false, error: 'Windows startup is only available on Windows' };
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const args = enabled
    ? ['add', key, '/v', 'Scout', '/t', 'REG_SZ', '/d', `"${hostPath}" --background`, '/f']
    : ['delete', key, '/v', 'Scout', '/f'];
  const result = spawn('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const missingDelete = !enabled && result.status === 1;
  return result.status === 0 || missingDelete ? { ok: true, enabled } : { ok: false, enabled: !enabled, error: String(result.stderr || result.stdout || 'registry update failed').trim() };
}
