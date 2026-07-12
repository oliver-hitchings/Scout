import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDeviceSettings, pendingDeviceSections, saveDeviceSettings, setWindowsStartup } from './deviceSettings.mjs';

test('device settings persist outside the app and retain defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-device-')); const file = path.join(root, 'state.json');
  const initial = loadDeviceSettings({ file }); assert.equal(initial.startWithWindows, false);
  initial.startWithWindows = true; saveDeviceSettings(initial, { file });
  assert.equal(loadDeviceSettings({ file }).startWithWindows, true); fs.rmSync(root, { recursive: true, force: true });
});

test('new Windows setup section prompts once and honours deferral', () => {
  const settings = loadDeviceSettings({ file: 'missing-device-settings-fixture' });
  assert.deepEqual(pendingDeviceSections(settings, { platform: 'win32', now: 1000 }).map((s) => s.id), ['windows-startup']);
  settings.deferredSections['windows-startup'] = new Date(2000).toISOString();
  assert.equal(pendingDeviceSections(settings, { platform: 'win32', now: 1000 }).length, 0);
  settings.completedSections['windows-startup'] = 1;
  assert.equal(pendingDeviceSections(settings, { platform: 'win32', now: 3000 }).length, 0);
});

test('Windows startup registration uses a per-user Run entry', () => {
  const calls = []; const result = setWindowsStartup(true, 'C:\\Program Files\\Scout\\Scout.exe', { platform: 'win32', spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; } });
  assert.equal(result.ok, true); assert.equal(calls[0][0], 'reg.exe'); assert.ok(calls[0][1].includes('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'));
});
