import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const host = fs.readFileSync(new URL('../desktop/cmd/scout-host/main.go', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');

test('Windows host owns tray lifecycle and named runtime', () => {
  for (const label of ['Open Scout', 'Check for updates', 'Restart Scout', 'Settings', 'Quit Scout', 'quit and keep scheduled scans running', 'turn off scheduled scans, then quit', 'Cancel — keep Scout open']) assert.match(host, new RegExp(label));
  assert.match(host, /SingleInstance/);
  assert.match(host, /ProxyHandler/);
  assert.match(host, /go:embed scout-icon\.ico/);
  assert.match(host, /Icon: scoutIcon/);
  assert.match(host, /tray\.SetIcon\(scoutIcon\)/);
  assert.match(installer, /Source: "\{#StageDir\}\\Scout\.exe"/);
  assert.match(installer, /runtime\\ScoutRuntime\.exe/);
  assert.match(installer, /SetupIconFile=\.\.\\ui\\assets\\scout-icon\.ico/);
  assert.doesNotMatch(installer, /PowerShell|ScoutLauncher\.ps1/);
});

test('quit confirmation uses Windows-supported response IDs and waits to disable schedules', () => {
  for (const label of ['AddButton("Yes")', 'AddButton("No")', 'AddButton("Cancel")', 'disableSchedules(sup.Port)', 'client.Do(req)', 'resp.StatusCode < 200']) assert.match(host, new RegExp(label.replace(/[()]/g, '\\$&')));
});

test('the native host embeds the established favicon unchanged', () => {
  const source = fs.readFileSync(new URL('../ui/assets/scout-icon.ico', import.meta.url));
  const embedded = fs.readFileSync(new URL('../desktop/cmd/scout-host/scout-icon.ico', import.meta.url));
  assert.deepEqual(embedded, source);
});

test('Windows host checks updates after launch and on a recurring timer', () => {
  assert.match(host, /Check\(true\)/);
  assert.match(host, /v1\/updates\/check/);
});
