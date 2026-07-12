import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TASK_NAME = 'Scout Daily Scan';
export const MAC_LABEL = 'app.scout.daily-scan';
export const LINUX_UNIT = 'scout-daily-scan';

function validateTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('schedule time must be HH:MM');
  return value;
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

export function scheduleStatus({ spawn = spawnSync, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform === 'darwin') {
    const r = spawn('launchctl', ['print', `gui/${uid}/${MAC_LABEL}`], { encoding: 'utf8' });
    return { ok: r.status === 0, supported: true, scheduler: 'launchd', output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform === 'linux') {
    const r = spawn('systemctl', ['--user', 'is-enabled', `${LINUX_UNIT}.timer`], { encoding: 'utf8' });
    return { ok: r.status === 0, supported: r.error?.code !== 'ENOENT', scheduler: 'systemd', output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform !== 'win32') return { ok: false, supported: false, error: 'scheduled scans are not supported on this platform' };
  const r = spawn('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, supported: true, scheduler: 'windows-task-scheduler', output: String(r.stdout || r.stderr || '').trim() };
}

export function nextScheduledRun(time, now = new Date()) {
  validateTime(time);
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export function scheduleSummary(config = {}, scanHealth = null, task = null, now = new Date()) {
  const schedule = config.schedule || {};
  const enabled = Boolean(schedule.enabled && task?.ok);
  return {
    enabled,
    configured: Boolean(schedule.enabled),
    provider: schedule.provider || config.ai?.provider || null,
    time: schedule.time || null,
    nextRunAt: enabled && schedule.time ? nextScheduledRun(schedule.time, now) : null,
    lastRunAt: scanHealth?.lastRunAt || null,
    lastResult: !scanHealth?.lastRunAt ? 'never' : scanHealth.healthy ? 'healthy' : scanHealth.stale ? 'stale' : 'degraded',
    taskOk: Boolean(task?.ok),
    supported: task?.supported !== false,
    scheduler: task?.scheduler || null,
  };
}

export function removeSchedule({ spawn = spawnSync, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), fileSystem = fs } = {}) {
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
    const r = spawn('launchctl', ['bootout', `gui/${uid}/${MAC_LABEL}`], { encoding: 'utf8' }); fileSystem.rmSync(file, { force: true });
    return { ok: r.status === 0 || !fileSystem.existsSync(file), output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    spawn('systemctl', ['--user', 'disable', '--now', `${LINUX_UNIT}.timer`], { encoding: 'utf8' });
    fileSystem.rmSync(path.join(dir, `${LINUX_UNIT}.timer`), { force: true }); fileSystem.rmSync(path.join(dir, `${LINUX_UNIT}.service`), { force: true });
    const r = spawn('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' }); return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
  }
  const r = spawn('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}

export function runScheduledNow({ spawn = spawnSync, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform === 'darwin') { const r = spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${MAC_LABEL}`], { encoding: 'utf8' }); return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() }; }
  if (platform === 'linux') { const r = spawn('systemctl', ['--user', 'start', `${LINUX_UNIT}.service`], { encoding: 'utf8' }); return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() }; }
  const r = spawn('schtasks.exe', ['/Run', '/TN', TASK_NAME], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}

export function macLaunchAgent({ command, args, workingDirectory, time, pathValue = process.env.PATH || '' }) {
  validateTime(time); const [hour, minute] = time.split(':');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${MAC_LABEL}</string><key>ProgramArguments</key><array>${[command, ...args].map((v) => `<string>${quoteXml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${quoteXml(workingDirectory)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${quoteXml(pathValue)}</string></dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict><key>ProcessType</key><string>Background</string></dict></plist>`;
}

function systemdQuote(value) { const text = String(value); if (/\r|\n/.test(text)) throw new Error('schedule arguments cannot contain newlines'); return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
export function linuxSystemdUnits({ command, args, workingDirectory, time, pathValue = process.env.PATH || '' }) {
  validateTime(time);
  return {
    service: `[Unit]\nDescription=Scout daily scan\n[Service]\nType=oneshot\nWorkingDirectory=${systemdQuote(workingDirectory)}\nEnvironment=${systemdQuote(`PATH=${pathValue}`)}\nExecStart=${[command, ...args].map(systemdQuote).join(' ')}\nRuntimeMaxSec=2700\n`,
    timer: `[Unit]\nDescription=Run Scout daily\n[Timer]\nOnCalendar=*-*-* ${time}:00\nPersistent=true\nUnit=${LINUX_UNIT}.service\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function registerUnixSchedule({ platform = process.platform, command, args, workingDirectory, time, spawn = spawnSync, home = os.homedir(), uid = process.getuid?.(), fileSystem = fs }) {
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents'); fileSystem.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${MAC_LABEL}.plist`);
    fileSystem.writeFileSync(file, macLaunchAgent({ command, args, workingDirectory, time, pathValue: `/opt/homebrew/bin:/usr/local/bin:${path.join(home, '.local/bin')}:${process.env.PATH || ''}` }));
    spawn('launchctl', ['bootout', `gui/${uid}/${MAC_LABEL}`], { encoding: 'utf8' }); const r = spawn('launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
    return { ok: r.status === 0, supported: true, output: String(r.stdout || r.stderr || '').trim() };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user'); fileSystem.mkdirSync(dir, { recursive: true }); const units = linuxSystemdUnits({ command, args, workingDirectory, time, pathValue: `/usr/local/bin:${path.join(home, '.local/bin')}:${path.join(home, '.npm-global/bin')}:${process.env.PATH || ''}` });
    fileSystem.writeFileSync(path.join(dir, `${LINUX_UNIT}.service`), units.service); fileSystem.writeFileSync(path.join(dir, `${LINUX_UNIT}.timer`), units.timer);
    let r = spawn('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' }); if (r.status === 0) r = spawn('systemctl', ['--user', 'enable', '--now', `${LINUX_UNIT}.timer`], { encoding: 'utf8' });
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

export function registerDailySchedule({ scriptFile, command, argumentsText, workingDirectory, time, spawn = spawnSync }) {
  validateTime(time);
  if (process.platform !== 'win32') return { ok: false, supported: false, error: 'scheduled scans are currently supported on Windows only' };
  const r = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
    '-TaskName', TASK_NAME, '-Command', command, '-Arguments', argumentsText,
    '-WorkingDirectory', workingDirectory, '-Time', time,
  ], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, supported: true, output: String(r.stdout || r.stderr || '').trim() };
}
