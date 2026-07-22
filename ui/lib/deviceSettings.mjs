import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteFile } from './atomicWrite.mjs';

export const DEVICE_SETUP_SECTIONS = Object.freeze({ 'windows-startup': 1 });
export const WINDOWS_STARTUP_TASK = '\\Scout\\Scout Host';
const LEGACY_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export function deviceSettingsPath(env = process.env, platform = process.platform) {
  if (env.SCOUT_DEVICE_SETTINGS) return path.resolve(env.SCOUT_DEVICE_SETTINGS);
  const base = platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local'))
    : (env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'));
  return path.join(base, 'Scout', 'device-settings.json');
}

export function updateDownloadDirectory(env = process.env, platform = process.platform) {
  return path.join(path.dirname(deviceSettingsPath(env, platform)), 'updates');
}

export function loadDeviceSettings(options = {}) {
  const file = options.file || deviceSettingsPath(options.env, options.platform);
  const defaults = {
    schemaVersion: 3,
    startWithWindows: false,
    startup: { mechanism: 'task-scheduler', verifiedAt: null },
    remoteAccess: { enabled: false },
    completedSections: {}, deferredSections: {},
    updates: { policy: 'notify', lastCheckedAt: null, lastNotifiedVersion: null, downloaded: null },
  };
  if (!fs.existsSync(file)) return defaults;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...defaults, ...value, schemaVersion: 3,
      startup: { ...defaults.startup, ...(value.startup || {}) },
      remoteAccess: { ...defaults.remoteAccess, ...(value.remoteAccess || {}) },
      completedSections: { ...defaults.completedSections, ...(value.completedSections || {}) },
      deferredSections: { ...defaults.deferredSections, ...(value.deferredSections || {}) },
      updates: { ...defaults.updates, ...(value.updates || {}) },
    };
  } catch { return defaults; }
}

export function saveDeviceSettings(value, options = {}) {
  const file = options.file || deviceSettingsPath(options.env, options.platform);
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export function pendingDeviceSections(settings, { platform = process.platform, now = Date.now() } = {}) {
  if (platform !== 'win32') return [];
  return Object.entries(DEVICE_SETUP_SECTIONS).filter(([id, version]) => {
    if (Number(settings.completedSections?.[id] || 0) >= version) return false;
    return new Date(settings.deferredSections?.[id] || 0).getTime() <= now;
  }).map(([id, version]) => ({ id, version, blocking: false, title: 'Start Scout with Windows' }));
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function windowsStartupTaskXml(hostPath, { env = process.env } = {}) {
  const domain = env.USERDOMAIN ? `${env.USERDOMAIN}\\` : '';
  const user = `${domain}${env.USERNAME || env.USER || ''}`;
  if (!user) throw new Error('Windows user identity is unavailable');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId><Delay>PT15S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>${xml(path.resolve(hostPath))}</Command><Arguments>--background</Arguments><WorkingDirectory>${xml(path.dirname(path.resolve(hostPath)))}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

function missingTask(result) {
  return result.status === 1 && /cannot find|does not exist|not found/i.test(String(result.stderr || result.stdout || ''));
}

export function windowsStartupStatus({ spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { supported: false, enabled: false, mechanism: null };
  const result = spawn('schtasks.exe', ['/Query', '/TN', WINDOWS_STARTUP_TASK], { encoding: 'utf8', windowsHide: true });
  return {
    supported: true, enabled: result.status === 0, mechanism: 'task-scheduler',
    ...(result.status === 0 || missingTask(result) ? {} : { error: String(result.stderr || result.stdout || 'Task Scheduler query failed').trim() }),
  };
}

export function setWindowsStartup(enabled, hostPath, {
  spawn = spawnSync, platform = process.platform, env = process.env, fileSystem = fs, tempDir = os.tmpdir(), now = Date.now(),
} = {}) {
  if (platform !== 'win32') return { ok: false, supported: false, error: 'Windows startup is only available on Windows' };
  if (enabled) {
    const file = path.join(tempDir, `scout-startup-${process.pid}-${now}.xml`);
    try {
      fileSystem.writeFileSync(file, `\uFEFF${windowsStartupTaskXml(hostPath, { env })}`, { encoding: 'utf16le', mode: 0o600 });
      const create = spawn('schtasks.exe', ['/Create', '/TN', WINDOWS_STARTUP_TASK, '/XML', file, '/F'], { encoding: 'utf8', windowsHide: true });
      if (create.status !== 0) return { ok: false, enabled: false, error: String(create.stderr || create.stdout || 'Task Scheduler registration failed').trim() };
      const verify = spawn('schtasks.exe', ['/Query', '/TN', WINDOWS_STARTUP_TASK], { encoding: 'utf8', windowsHide: true });
      if (verify.status !== 0) {
        spawn('schtasks.exe', ['/Delete', '/TN', WINDOWS_STARTUP_TASK, '/F'], { encoding: 'utf8', windowsHide: true });
        return { ok: false, enabled: false, rolledBack: true, error: String(verify.stderr || verify.stdout || 'Task Scheduler verification failed').trim() };
      }
      spawn('reg.exe', ['delete', LEGACY_RUN_KEY, '/v', 'Scout', '/f'], { encoding: 'utf8', windowsHide: true });
      return { ok: true, enabled: true, mechanism: 'task-scheduler', verifiedAt: new Date(now).toISOString() };
    } finally { fileSystem.rmSync(file, { force: true }); }
  }
  const remove = spawn('schtasks.exe', ['/Delete', '/TN', WINDOWS_STARTUP_TASK, '/F'], { encoding: 'utf8', windowsHide: true });
  const legacy = spawn('reg.exe', ['delete', LEGACY_RUN_KEY, '/v', 'Scout', '/f'], { encoding: 'utf8', windowsHide: true });
  const taskOk = remove.status === 0 || missingTask(remove);
  const legacyOk = legacy.status === 0 || legacy.status === 1;
  return taskOk && legacyOk
    ? { ok: true, enabled: false, mechanism: 'task-scheduler', verifiedAt: new Date(now).toISOString() }
    : { ok: false, enabled: true, error: String(remove.stderr || remove.stdout || legacy.stderr || legacy.stdout || 'Startup removal failed').trim() };
}
