import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { inspectWindowsNotificationExecutable, validateNotificationExecutable } from './notificationExecutable.mjs';

test('Windows command security checks run fixed PowerShell with a literal selector and bounded output', () => {
  const prior = process.env.SystemRoot;
  process.env.SystemRoot = path.resolve(os.tmpdir(), 'synthetic-windows');
  const selector = path.resolve(os.tmpdir(), 'literal-$(never)-command.exe');
  try {
    let call;
    assert.equal(inspectWindowsNotificationExecutable(selector, { spawn: (...args) => {
      call = args; return { status: 0, stdout: '{"ok":true}' };
    } }), true);
    assert.equal(call[2].shell, false);
    assert.equal(call[2].env.SCOUT_OUTBOUND_EXECUTABLE, selector);
    assert.deepEqual(Object.keys(call[2].env).sort(), ['SCOUT_OUTBOUND_EXECUTABLE', 'SystemRoot', 'WINDIR']);
    assert.equal(call[2].timeout, 5000);
    assert.equal(call[2].maxBuffer, 4096);
    const script = Buffer.from(call[1].at(-1), 'base64').toString('utf16le');
    assert.match(script, /GetOwner/);
    assert.match(script, /GetAccessRules/);
    assert.match(script, /\.Parent/);
    assert.doesNotMatch(script, /literal-\$\(never\)/);
    for (const result of [{ status: 1, stdout: '{"ok":true}' }, { status: 0, stdout: 'unsafe' }, { status: 0, stdout: '{"ok":false}' }]) {
      assert.equal(inspectWindowsNotificationExecutable(selector, { spawn: () => result }), false);
    }
  } finally { if (prior === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = prior; }
});

test('Windows validation rejects an unverified owner or DACL before returning an executable', () => {
  assert.throws(() => validateNotificationExecutable(process.execPath, { platform: 'win32', inspectWindows: () => false }), /protected/);
  assert.equal(validateNotificationExecutable(process.execPath, { platform: 'win32', inspectWindows: () => true }), fs.realpathSync(process.execPath));
});

test('an actual Windows parent DACL granting Everyone modification blocks command selection', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-command-dacl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = path.join(root, 'node.exe');
  fs.copyFileSync(process.execPath, command);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'),
    [root, '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, 'Synthetic parent ACL preparation must succeed');
  assert.equal(inspectWindowsNotificationExecutable(command), false);
  assert.throws(() => validateNotificationExecutable(command), /protected/);
});

test('an unsafe non-sticky ancestor blocks executable replacement through its protected child directory', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-command-ancestor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'private'); fs.mkdirSync(nested, { mode: 0o700 });
  const command = path.join(nested, 'node'); fs.copyFileSync(process.execPath, command); fs.chmodSync(command, 0o700);
  assert.equal(validateNotificationExecutable(command), command);
  fs.chmodSync(root, 0o770);
  assert.throws(() => validateNotificationExecutable(command), /protected/);
});
