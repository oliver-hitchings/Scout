import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeInstallEnvironment, nativeWorkspaceSnapshot, runIsolatedNativeCommand } from './nativeInstallBoundary.mjs';

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
