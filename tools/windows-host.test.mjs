import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const host = fs.readFileSync(new URL('../installer/windows/ScoutHost.cs', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');

test('Windows host owns tray lifecycle and named runtime', () => {
  for (const label of ['Open Scout', 'Check for updates', 'Restart Scout', 'Quit Scout', 'Keep scans enabled', 'Disable and quit']) assert.match(host, new RegExp(label));
  assert.match(host, /ScoutRuntime\.exe/);
  assert.match(host, /CreateKillJob/);
  assert.match(installer, /Source: "\{#StageDir\}\\Scout\.exe"/);
  assert.match(installer, /runtime\\ScoutRuntime\.exe/);
  assert.doesNotMatch(installer, /PowerShell|ScoutLauncher\.ps1/);
});

test('Windows host checks updates after launch and on a recurring timer', () => {
  assert.match(host, /initialTimer\.Interval = 10000/);
  assert.match(host, /dailyTimer\.Interval = 60 \* 60 \* 1000/);
  assert.match(host, /api\/update\/check/);
});
