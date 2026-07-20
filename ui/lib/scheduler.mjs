import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TASK_NAME = 'Scout Daily Scan';
export const MAC_LABEL = 'app.scout.daily-scan';
export const LINUX_UNIT = 'scout-daily-scan';

function validateJobId(value = 'primary') {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value))) throw new Error('schedule job id must use lower-case letters, numbers and hyphens');
  return String(value);
}

export function nativeScheduleNames(id = 'primary') {
  const jobId = validateJobId(id);
  return {
    task: `${TASK_NAME} - ${jobId}`,
    mac: `${MAC_LABEL}.${jobId}`,
    linux: `${LINUX_UNIT}-${jobId}`,
  };
}

function systemdUserOptions(uid, options = {}) {
  const id = uid ?? process.getuid?.();
  return {
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
      ...(id === undefined ? {} : {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${id}`,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${id}/bus`,
      }),
    },
  };
}

function validateTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('schedule time must be HH:MM');
  return value;
}

function validateTimezone(value) {
  const timezone = String(value || '');
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timezone)) throw new Error('schedule timezone must be a valid IANA timezone');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date()); }
  catch { throw new Error('schedule timezone must be a valid IANA timezone'); }
  return timezone;
}

function quoteXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function localDateTime(value) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:00`;
}

export function taskXml({ command, args = [], workingDirectory, time, userId = process.env.USERNAME, now = new Date() }) {
  validateTime(time);
  const start = localDateTime(new Date(nextScheduledRun(time, now)));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${quoteXml(userId || '')}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT45M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>${quoteXml(command)}</Command><Arguments>${quoteXml(args.join(' '))}</Arguments><WorkingDirectory>${quoteXml(workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

export function scheduleStatus({ id = 'primary', spawn = spawnSync, platform = process.platform, uid = process.getuid?.() } = {}) {
  const names = nativeScheduleNames(id);
  if (platform === 'darwin') {
    const r = spawn('launchctl', ['print', `gui/${uid}/${names.mac}`], { encoding: 'utf8' });
    return { ok: r.status === 0, supported: true, scheduler: 'launchd', output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform === 'linux') {
    const r = spawn('systemctl', ['--user', 'is-enabled', `${names.linux}.timer`], systemdUserOptions(uid, { encoding: 'utf8' }));
    return { ok: r.status === 0, supported: r.error?.code !== 'ENOENT', scheduler: 'systemd', output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform !== 'win32') return { ok: false, supported: false, error: 'scheduled scans are not supported on this platform' };
  const r = spawn('schtasks.exe', ['/Query', '/TN', names.task, '/FO', 'LIST'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, supported: true, scheduler: 'windows-task-scheduler', output: String(r.stdout || r.stderr || '').trim() };
}

function zonedParts(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zonedInstant({ year, month, day, hour, minute }, timezone) {
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = wallTime;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const actualWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += wallTime - actualWallTime;
  }
  return new Date(candidate);
}

export function nextScheduledRun(time, now = new Date(), timezone = null) {
  validateTime(time);
  const [hours, minutes] = time.split(':').map(Number);
  if (timezone) {
    const zone = validateTimezone(timezone);
    const today = zonedParts(now, zone);
    let next = zonedInstant({ year: today.year, month: today.month, day: today.day, hour: hours, minute: minutes }, zone);
    if (next <= now) {
      const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      next = zonedInstant({
        year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(),
        hour: hours, minute: minutes,
      }, zone);
    }
    return next.toISOString();
  }
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export function scheduleSummary(config = {}, scanHealth = null, tasks = [], now = new Date()) {
  const jobs = config.schedule?.jobs || [];
  const taskList = Array.isArray(tasks) ? tasks : jobs.map(() => tasks);
  const runs = jobs.map((job, index) => {
    const task = taskList[index] || {};
    const enabled = Boolean(job.enabled && task.ok);
    return {
      ...job,
      enabled,
      configured: Boolean(job.enabled),
      nextRunAt: enabled ? nextScheduledRun(job.time, now, config.timezone || null) : null,
      lastRunAt: scanHealth?.runs?.[job.id]?.lastRunAt || null,
      lastResult: scanHealth?.runs?.[job.id]?.lastResult || 'never',
      taskOk: Boolean(task.ok),
      supported: task.supported !== false,
      scheduler: task.scheduler || null,
    };
  });
  const enabled = runs.some((job) => job.enabled);
  return {
    enabled,
    configured: runs.some((job) => job.configured),
    runs,
    provider: runs[0]?.provider || config.ai?.provider || null,
    time: runs[0]?.time || null,
    nextRunAt: runs.filter((job) => job.nextRunAt).map((job) => job.nextRunAt).sort()[0] || null,
    lastRunAt: scanHealth?.lastRunAt || null,
    lastResult: !scanHealth?.lastRunAt ? 'never' : scanHealth.healthy ? 'healthy' : scanHealth.stale ? 'stale' : 'degraded',
    taskOk: runs.some((job) => job.configured) && runs.filter((job) => job.configured).every((job) => job.taskOk),
    supported: runs.filter((job) => job.configured).every((job) => job.supported),
    scheduler: runs.find((job) => job.scheduler)?.scheduler || null,
  };
}

export function removeSchedule({ id = 'primary', spawn = spawnSync, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), fileSystem = fs } = {}) {
  const names = nativeScheduleNames(id);
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${names.mac}.plist`);
    const r = spawn('launchctl', ['bootout', `gui/${uid}/${names.mac}`], { encoding: 'utf8' }); fileSystem.rmSync(file, { force: true });
    return { ok: r.status === 0 || !fileSystem.existsSync(file), output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    spawn('systemctl', ['--user', 'disable', '--now', `${names.linux}.timer`], systemdUserOptions(uid, { encoding: 'utf8' }));
    fileSystem.rmSync(path.join(dir, `${names.linux}.timer`), { force: true }); fileSystem.rmSync(path.join(dir, `${names.linux}.service`), { force: true });
    const r = spawn('systemctl', ['--user', 'daemon-reload'], systemdUserOptions(uid, { encoding: 'utf8' })); return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
  }
  const r = spawn('schtasks.exe', ['/Delete', '/TN', names.task, '/F'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}

export function runScheduledNow({ id = 'primary', spawn = spawnSync, platform = process.platform, uid = process.getuid?.() } = {}) {
  const names = nativeScheduleNames(id);
  if (platform === 'darwin') { const r = spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${names.mac}`], { encoding: 'utf8' }); return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() }; }
  if (platform === 'linux') { const r = spawn('systemctl', ['--user', 'start', `${names.linux}.service`], systemdUserOptions(uid, { encoding: 'utf8' })); return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() }; }
  const r = spawn('schtasks.exe', ['/Run', '/TN', names.task], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}

export function macLaunchAgent({ id = 'primary', command, args, workingDirectory, time, pathValue = process.env.PATH || '' }) {
  const names = nativeScheduleNames(id);
  validateTime(time); const [hour, minute] = time.split(':');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${names.mac}</string><key>ProgramArguments</key><array>${[command, ...args].map((v) => `<string>${quoteXml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${quoteXml(workingDirectory)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${quoteXml(pathValue)}</string></dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict><key>ProcessType</key><string>Background</string></dict></plist>`;
}

export function removeLegacySchedule({ spawn = spawnSync, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), fileSystem = fs } = {}) {
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
    spawn('launchctl', ['bootout', `gui/${uid}/${MAC_LABEL}`], { encoding: 'utf8' });
    fileSystem.rmSync(file, { force: true });
    return { ok: !fileSystem.existsSync(file) };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    spawn('systemctl', ['--user', 'disable', '--now', `${LINUX_UNIT}.timer`], systemdUserOptions(uid, { encoding: 'utf8' }));
    fileSystem.rmSync(path.join(dir, `${LINUX_UNIT}.timer`), { force: true });
    fileSystem.rmSync(path.join(dir, `${LINUX_UNIT}.service`), { force: true });
    const reload = spawn('systemctl', ['--user', 'daemon-reload'], systemdUserOptions(uid, { encoding: 'utf8' }));
    return { ok: reload.status === 0, output: String(reload.stdout || reload.stderr || '').trim() };
  }
  if (platform === 'win32') {
    const result = spawn('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8', windowsHide: true });
    return { ok: result.status === 0 || /cannot find|does not exist/i.test(String(result.stderr || result.stdout || '')) };
  }
  return { ok: true };
}

function systemdQuote(value) { const text = String(value); if (/\r|\n/.test(text)) throw new Error('schedule arguments cannot contain newlines'); return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
export function linuxSystemdUnits({ id = 'primary', command, args, workingDirectory, time, timezone = 'Europe/London', pathValue = process.env.PATH || '' }) {
  const names = nativeScheduleNames(id);
  validateTime(time);
  const zone = validateTimezone(timezone);
  return {
    service: `[Unit]\nDescription=Scout daily scan\n[Service]\nType=exec\nWorkingDirectory=${systemdQuote(workingDirectory)}\nEnvironment=${systemdQuote(`PATH=${pathValue}`)}\nExecStart=${[command, ...args].map(systemdQuote).join(' ')}\nRuntimeMaxSec=2700\n`,
    timer: `[Unit]\nDescription=Run Scout daily (${id})\n[Timer]\nOnCalendar=*-*-* ${time}:00 ${zone}\nPersistent=true\nUnit=${names.linux}.service\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function registerUnixSchedule({ id = 'primary', platform = process.platform, command, args, workingDirectory, time, timezone = 'Europe/London', spawn = spawnSync, home = os.homedir(), uid = process.getuid?.(), fileSystem = fs }) {
  const names = nativeScheduleNames(id);
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents'); fileSystem.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${names.mac}.plist`);
    fileSystem.writeFileSync(file, macLaunchAgent({ id, command, args, workingDirectory, time, pathValue: `/opt/homebrew/bin:/usr/local/bin:${path.join(home, '.local/bin')}:${process.env.PATH || ''}` }));
    spawn('launchctl', ['bootout', `gui/${uid}/${names.mac}`], { encoding: 'utf8' }); const r = spawn('launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
    return { ok: r.status === 0, supported: true, output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user'); fileSystem.mkdirSync(dir, { recursive: true }); const units = linuxSystemdUnits({ id, command, args, workingDirectory, time, timezone, pathValue: `/usr/local/bin:${path.join(home, '.local/bin')}:${path.join(home, '.npm-global/bin')}:${process.env.PATH || ''}` });
    const serviceFile = path.join(dir, `${names.linux}.service`);
    const timerFile = path.join(dir, `${names.linux}.timer`);
    fileSystem.writeFileSync(serviceFile, units.service); fileSystem.writeFileSync(timerFile, units.timer);
    let r = spawn('systemd-analyze', ['--user', 'verify', serviceFile, timerFile], systemdUserOptions(uid, { encoding: 'utf8' }));
    if (r.error?.code === 'ENOENT') r = { status: 0, stdout: '' };
    if (r.status === 0) r = spawn('systemctl', ['--user', 'daemon-reload'], systemdUserOptions(uid, { encoding: 'utf8' }));
    if (r.status === 0) r = spawn('systemctl', ['--user', 'enable', '--now', `${names.linux}.timer`], systemdUserOptions(uid, { encoding: 'utf8' }));
    return { ok: r.status === 0, supported: r.error?.code !== 'ENOENT', output: String(r.stdout || r.stderr || '').trim() };
  }
  return { ok: false, supported: false, error: 'Unix scheduling requires macOS or Linux' };
}

export function schedulerRegistrationScript() {
  return `param(
  [Parameter(Mandatory=$true)][string]$TaskName,
  [Parameter(Mandatory=$true)][string]$Command,
  [Parameter(Mandatory=$true)][string]$Arguments,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$Time
)
$ErrorActionPreference = 'Stop'
$at = [datetime]::Today.Add([timespan]::Parse($Time))
if ($at -le (Get-Date)) { $at = $at.AddDays(1) }
$action = New-ScheduledTaskAction -Execute $Command -Argument $Arguments -WorkingDirectory $WorkingDirectory
$trigger = New-ScheduledTaskTrigger -Daily -At $at
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
`;
}

export function registerDailySchedule({ id = 'primary', scriptFile, command, argumentsText, workingDirectory, time, spawn = spawnSync }) {
  validateTime(time);
  const names = nativeScheduleNames(id);
  if (process.platform !== 'win32') return { ok: false, supported: false, error: 'scheduled scans are currently supported on Windows only' };
  const r = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
    '-TaskName', names.task, '-Command', command, '-Arguments', argumentsText,
    '-WorkingDirectory', workingDirectory, '-Time', time,
  ], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, supported: true, output: String(r.stdout || r.stderr || '').trim() };
}
