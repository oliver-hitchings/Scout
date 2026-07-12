import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linuxSystemdUnits, macLaunchAgent, nextScheduledRun, registerDailySchedule, scheduleSummary, schedulerRegistrationScript, taskXml } from './scheduler.mjs';

test('scheduled task is catch-up enabled, non-overlapping and time limited', () => {
  const xml = taskXml({ command: 'node.exe', args: ['tools/scout.mjs', 'scan'], workingDirectory: 'C:\\Scout', time: '07:30', userId: 'user', now: new Date(2026, 6, 11, 8, 0) });
  assert.match(xml, /<StartBoundary>2026-07-12T07:30:00<\/StartBoundary>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT45M<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test('scheduled task rejects invalid times', () => {
  assert.throws(() => taskXml({ command: 'node', workingDirectory: '.', time: '25:00' }), /HH:MM/);
});

test('nextScheduledRun chooses today or tomorrow in local time', () => {
  const before = new Date(2026, 6, 11, 6, 0);
  const sameDay = new Date(nextScheduledRun('07:30', before));
  assert.deepEqual([sameDay.getDate(), sameDay.getHours(), sameDay.getMinutes()], [11, 7, 30]);
  const after = new Date(2026, 6, 11, 8, 0);
  const nextDay = new Date(nextScheduledRun('07:30', after));
  assert.deepEqual([nextDay.getDate(), nextDay.getHours(), nextDay.getMinutes()], [12, 7, 30]);
});

test('scheduleSummary distinguishes saved configuration from a live task', () => {
  const config = { ai: { provider: 'claude' }, schedule: { enabled: true, time: '07:30', provider: 'claude' } };
  const missing = scheduleSummary(config, { lastRunAt: null }, { ok: false, supported: true }, new Date('2026-07-11T06:00:00.000Z'));
  assert.equal(missing.configured, true);
  assert.equal(missing.enabled, false);
  const live = scheduleSummary(config, { lastRunAt: '2026-07-11T05:00:00Z', healthy: false, degraded: true }, { ok: true, supported: true }, new Date('2026-07-11T06:00:00.000Z'));
  assert.equal(live.enabled, true);
  assert.equal(live.lastResult, 'degraded');
  const next = new Date(live.nextRunAt);
  assert.deepEqual([next.getHours(), next.getMinutes()], [7, 30]);
});

test('native registration creates a persistent least-privilege daily task', () => {
  const script = schedulerRegistrationScript();
  assert.match(script, /New-ScheduledTaskTrigger -Daily/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /Register-ScheduledTask/);
  let call;
  const result = registerDailySchedule({ scriptFile: 'register.ps1', command: 'node.exe', argumentsText: 'scan', workingDirectory: 'C:\\Scout', time: '07:30', spawn(command, args) { call = { command, args }; return { status: 0, stdout: '' }; } });
  assert.equal(result.ok, process.platform === 'win32');
  if (process.platform === 'win32') { assert.equal(call.command, 'powershell.exe'); assert.ok(call.args.includes('07:30')); }
});

test('macOS launch agent uses a daily calendar and argument array', () => {
  const plist = macLaunchAgent({ command: '/app/node', args: ['/app/scout.mjs', 'scan', '--workspace', '/Users/A User/Scout'], workingDirectory: '/app', time: '07:30' });
  assert.match(plist, /app\.scout\.daily-scan/); assert.match(plist, /<key>Hour<\/key><integer>7<\/integer>/); assert.match(plist, /<key>Minute<\/key><integer>30<\/integer>/); assert.match(plist, /\/Users\/A User\/Scout/);
});

test('Linux user timer is persistent, bounded and safely quoted', () => {
  const units = linuxSystemdUnits({ command: '/opt/scout/runtime/node', args: ['/opt/scout/app/tools/scout.mjs', 'scan', '--workspace', '/home/a/Scout Workspace'], workingDirectory: '/opt/scout/app', time: '07:30' });
  assert.match(units.timer, /OnCalendar=\*-\*-\* 07:30:00/); assert.match(units.timer, /Persistent=true/); assert.match(units.service, /RuntimeMaxSec=2700/); assert.match(units.service, /"\/home\/a\/Scout Workspace"/);
});
