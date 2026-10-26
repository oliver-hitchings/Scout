import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNativeScanBoundary, finishNativeInstallCleanup, nativeInstallEnvironment, nativeWorkspaceSnapshot, runIsolatedNativeCommand, uninstallWindowsNative } from './nativeInstallBoundary.mjs';

test('native installation and uninstall helpers cannot write caller-owned device state', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-command-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const foreign = path.join(temporary, 'caller-device.json');
  const before = JSON.stringify({ remoteAccess: { enabled: true, ownerLogin: 'synthetic-owner' } });
  fs.writeFileSync(foreign, before);
  const original = process.env.SCOUT_DEVICE_SETTINGS;
  process.env.SCOUT_DEVICE_SETTINGS = foreign;
  t.after(() => { if (original === undefined) delete process.env.SCOUT_DEVICE_SETTINGS; else process.env.SCOUT_DEVICE_SETTINGS = original; });
  const home = path.join(temporary, 'isolated-home'); fs.mkdirSync(home);
  const env = nativeInstallEnvironment(process.env, { temporary, home, workspace: path.join(temporary, 'workspace') });
  const code = "require('node:fs').writeFileSync(process.env.SCOUT_DEVICE_SETTINGS, 'synthetic uninstall ran');process.stdout.write(JSON.stringify({home:process.env.HOME,workspace:process.env.SCOUT_WORKSPACE}));";
  const result = runIsolatedNativeCommand(process.execPath, ['-e', code], { env });
  assert.equal(fs.readFileSync(foreign, 'utf8'), before, 'installation helpers must never inherit the caller device file');
  assert.equal(fs.readFileSync(env.SCOUT_DEVICE_SETTINGS, 'utf8'), 'synthetic uninstall ran');
  assert.deepEqual(JSON.parse(result.stdout), { home, workspace: env.SCOUT_WORKSPACE });
});

test('uninstall verification detects career-file changes, deletion and unexpected additions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-career-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, text) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put('workspace.json', '{"schemaVersion":2}');
  put('cv/master-cv.md', 'Synthetic confirmed CV');
  put('profile/context.md', 'Synthetic profile');
  put('data/opportunities.json', '{"opportunities":[]}');
  put('reports/synthetic.md', 'Synthetic report');
  put('.scout/notification-receipts.json', '{"schemaVersion":1}');
  const before = nativeWorkspaceSnapshot(root);
  for (const relative of ['cv/master-cv.md', 'profile/context.md', 'data/opportunities.json', 'reports/synthetic.md', '.scout/notification-receipts.json']) {
    const file = path.join(root, relative); const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, 'corrupted by synthetic uninstall');
    assert.notDeepEqual(nativeWorkspaceSnapshot(root), before, relative);
    fs.writeFileSync(file, bytes);
    fs.unlinkSync(file);
    assert.notDeepEqual(nativeWorkspaceSnapshot(root), before, `${relative} deletion`);
    fs.writeFileSync(file, bytes);
  }
  put('cv/unexpected.md', 'Unexpected synthetic addition');
  assert.notDeepEqual(nativeWorkspaceSnapshot(root), before, 'unexpected addition');
});

test('native cleanup preserves the first acceptance failure while still failing a cleanup-only error', async () => {
  const primary = new Error('Synthetic native scan failed.');
  const cleanup = Object.assign(new Error('Synthetic cleanup path must not escape.'), { code: 'EPERM' });
  let observed;
  try {
    try { throw primary; }
    finally { await finishNativeInstallCleanup(async () => { throw cleanup; }, { primaryError: primary }); }
  } catch (error) { observed = error; }
  assert.equal(observed, primary);
  assert.match(primary.message, /cleanup.*EPERM/i);
  assert.doesNotMatch(primary.message, /path must not escape/);
  await assert.rejects(finishNativeInstallCleanup(async () => { throw cleanup; }), /cleanup.*EPERM/i);
});

test('a synthetic scan route failure reaches the owning acceptance flow without an unhandled route rejection', async () => {
  const failure = new Error('Synthetic installed scan failed.');
  let cleaned = false;
  let reply;
  const boundary = createNativeScanBoundary(async () => { throw failure; }, { id: 'synthetic-scan' });
  const response = { fulfill: async (value) => { reply = value; } };
  await assert.doesNotReject(boundary.route(response));
  try { await assert.rejects(boundary.completion, (error) => error === failure); }
  finally { cleaned = true; }
  assert.equal(cleaned, true);
  assert.equal(reply.status, 500);
});

test('Windows native uninstall waits for its owned helper before temporary files can be removed', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-uninstall-wait-'));
  const home = path.join(temporary, 'home'); fs.mkdirSync(home);
  const env = nativeInstallEnvironment(process.env, { home, temporary, workspace: path.join(temporary, 'workspace') });
  const receipt = path.join(temporary, 'receipt');
  const gate = path.join(temporary, 'release-helper');
  const executable = path.join(temporary, 'synthetic-uninstaller.mjs');
  const child = "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);fs.writeFileSync(process.argv[2],'closed');}},10);setTimeout(()=>process.exit(88),5000).unref();";
  fs.writeFileSync(executable, `import fs from 'node:fs';import {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(gate)},${JSON.stringify(receipt)}],{stdio:'ignore'});\nif(process.argv.slice(2).some(arg=>arg.startsWith('_?='))){fs.writeFileSync(${JSON.stringify(gate)},'release');child.on('close',code=>{process.exitCode=code});}else child.unref();\n`);
  t.after(async () => {
    fs.writeFileSync(gate, 'release');
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(receipt) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  uninstallWindowsNative(path.join(temporary, 'installed'), {
    env,
    run(command, args, options) {
      assert.equal(path.basename(command), 'unins000.exe');
      return runIsolatedNativeCommand(process.execPath, [executable, ...args], options);
    },
  });
  assert.equal(fs.existsSync(receipt), true, 'Uninstall must await the helper, not only its initial launcher');
});
