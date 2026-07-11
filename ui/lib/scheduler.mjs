import { spawnSync } from 'node:child_process';

export const TASK_NAME = 'Scout Daily Scan';

function validateTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('schedule time must be HH:MM');
  return value;
}

function quoteXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function taskXml({ command, args = [], workingDirectory, time, userId = process.env.USERNAME }) {
  validateTime(time);
  const start = `${new Date().toISOString().slice(0, 10)}T${time}:00`;
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

export function removeSchedule({ spawn = spawnSync } = {}) {
  const r = spawn('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}

export function runScheduledNow({ spawn = spawnSync } = {}) {
  const r = spawn('schtasks.exe', ['/Run', '/TN', TASK_NAME], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim() };
}
