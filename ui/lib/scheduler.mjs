import { spawnSync } from 'node:child_process';

export const TASK_NAME = 'Scout Daily Scan';

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

export function scheduleStatus({ spawn = spawnSync } = {}) {
  if (process.platform !== 'win32') return { ok: false, supported: false, error: 'scheduled scans are currently supported on Windows only' };
  const r = spawn('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, supported: true, output: String(r.stdout || r.stderr || '').trim() };
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
  };
}

export function removeSchedule({ spawn = spawnSync } = {}) {
  const r = spawn('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}

export function runScheduledNow({ spawn = spawnSync } = {}) {
  const r = spawn('schtasks.exe', ['/Run', '/TN', TASK_NAME], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
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
