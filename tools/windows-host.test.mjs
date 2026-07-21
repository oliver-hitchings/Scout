import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const host = fs.readFileSync(new URL('../installer/windows/ScoutHost.cs', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');

test('Windows host owns tray lifecycle and named runtime', () => {
  for (const label of ['Open Scout', 'Check for updates', 'Restart Scout', 'Quit Scout', 'Keep scans enabled', 'Disable and quit']) assert.match(host, new RegExp(label));
  assert.match(host, /ScoutRuntime\.exe/);
  assert.match(host, /api\/shutdown/);
  assert.doesNotMatch(host, /AssignProcessToJobObject|CreateKillJob/);
  assert.match(installer, /Source: "\{#StageDir\}\\Scout\.exe"/);
  assert.match(installer, /runtime\\\*/);
  assert.match(installer, /recursesubdirs/);
  assert.doesNotMatch(installer, /PowerShell|ScoutLauncher\.ps1/);
});

test('Windows host checks updates after launch and on a recurring timer', () => {
  assert.match(host, /initialTimer\.Interval = 10000/);
  assert.match(host, /dailyTimer\.Interval = 60 \* 60 \* 1000/);
  assert.match(host, /api\/update\/check/);
});

test('Windows host supervises runtime recovery and warns before remote access stops', () => {
  assert.match(host, /watchdogTimer\.Interval = 30000/);
  assert.match(host, /WatchdogTick/);
  assert.match(host, /new\[\] \{ 30, 60, 120, 300 \}/);
  assert.match(host, /api\/remote-access\/status/);
  assert.match(host, /Remote access will stop until Scout is relaunched or your next Windows sign-in/);
});

test('Windows uninstall removes only Scout managed hosting and both startup mechanisms', () => {
  assert.match(installer, /tools\\remote-access\.mjs/);
  assert.match(installer, /schtasks\.exe/);
  assert.match(installer, /\\Scout\\Scout Host/);
  assert.match(installer, /CurrentVersion\\Run \/v Scout/);
  assert.doesNotMatch(installer, /tailscale serve reset/i);
});
