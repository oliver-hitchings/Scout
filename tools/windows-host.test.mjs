import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const host = fs.readFileSync(new URL('../desktop/cmd/scout-host/main.go', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

test('Windows host owns tray lifecycle and named runtime', () => {
  for (const label of ['Open Scout', 'Check for updates', 'Restart Scout', 'Settings', 'Quit Scout', 'Scheduled scans can continue after Scout closes.', 'Yes, keep scheduled scans running', 'Yes, turn off scheduled scans', 'No, cancel']) assert.match(host, new RegExp(label));
  assert.match(host, /SingleInstance/);
  assert.match(host, /ProxyHandler/);
  assert.match(host, /go:embed scout-icon\.ico/);
  assert.match(host, /Icon: scoutIcon/);
  assert.match(host, /tray\.SetIcon\(scoutIcon\)/);
  assert.match(fs.readFileSync(new URL('../tools/build-release.mjs', import.meta.url), 'utf8'), /-H=windowsgui/);
  assert.match(installer, /Source: "\{#StageDir\}\\Scout\.exe"/);
  assert.match(installer, /runtime\\ScoutRuntime\.exe/);
  assert.match(installer, /SetupIconFile=\.\.\\ui\\assets\\scout-icon\.ico/);
  assert.doesNotMatch(installer, /PowerShell|ScoutLauncher\.ps1/);
});

test('quit confirmation uses the Scout webview and private host bridge', () => {
  for (const label of ['showQuitSheet(mainWindow)', '/api/host/quit', '/v1/window/quit', 'control.onQuit = app.Quit', 'document.documentElement.append(sheet)', "setProperty('z-index', '2147483647', 'important')", 'event.stopPropagation()', 'type="button"', 'disableSchedule']) assert.match(host, new RegExp(label.replace(/[()]/g, '\\$&')));
  assert.match(index, /<script type="module" src="\/wails\/runtime\.js"/);
});

test('the native host embeds the established favicon unchanged', () => {
  const source = fs.readFileSync(new URL('../ui/assets/scout-icon.ico', import.meta.url));
  const embedded = fs.readFileSync(new URL('../desktop/cmd/scout-host/scout-icon.ico', import.meta.url));
  assert.deepEqual(embedded, source);
  assert.equal(fs.existsSync(new URL('../desktop/cmd/scout-host/rsrc_windows_amd64.syso', import.meta.url)), true);
});

test('Windows host checks updates after launch and on a recurring timer', () => {
  assert.match(host, /Check\(true\)/);
  assert.match(host, /v1\/updates\/check/);
});
