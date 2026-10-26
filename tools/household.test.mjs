import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('household CLI creates isolated workspaces, lists and switches the next process without copying data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-'));
  const env = { ...process.env, SCOUT_WORKSPACE: '', SCOUT_HOUSEHOLD_SETTINGS: path.join(directory, 'household.json'), SCOUT_DEVICE_SETTINGS: path.join(directory, 'device.json') };
  const cli = (...args) => {
    const result = spawnSync(process.execPath, ['tools/scout.mjs', ...args], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  try {
    const first = cli('household', 'create', 'person-a', '--directory', path.join(directory, 'workspaces'), '--port', '8460');
    const second = cli('household', 'create', 'person-b', '--directory', path.join(directory, 'workspaces'), '--port', '8461');
    fs.writeFileSync(path.join(first.workspace, 'profile', 'context.md'), 'PRIVATE A SENTINEL');
    cli('household', 'switch', 'person-b');
    const listed = cli('household', 'list');
    assert.equal(listed.active, 'person-b');
    assert.equal(listed.instances.length, 2);
    assert.doesNotMatch(fs.readFileSync(path.join(second.workspace, 'profile', 'context.md'), 'utf8'), /PRIVATE A/);
    const selected = spawnSync(process.execPath, ['--input-type=module', '-e', "import {resolveWorkspaceRoot} from './ui/lib/workspace.mjs';console.log(resolveWorkspaceRoot({appRoot:process.cwd()}))"], { env, encoding: 'utf8' });
    assert.equal(selected.stdout.trim(), second.workspace);
    assert.notEqual(first.deviceSettings, second.deviceSettings);
    const duplicate = spawnSync(process.execPath, ['tools/scout.mjs', 'household', 'create', 'person-c', '--directory', path.join(directory, 'workspaces'), '--port', '8461'], { env, encoding: 'utf8' });
    assert.notEqual(duplicate.status, 0);
    assert.equal(fs.existsSync(path.join(directory, 'workspaces', 'workspace-person-c')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('household rejects traversal, linked roots and replacing an existing workspace', async () => {
  const { createHouseholdInstance } = await import('../ui/lib/household.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-links-'));
  const options = { appRoot: process.cwd(), directory, file: path.join(directory, 'registry.json'), initialise() {} };
  try {
    assert.throws(() => createHouseholdInstance({ ...options, id: '../escape', port: 8460 }), /id/);
    fs.mkdirSync(path.join(directory, 'workspace-person-a'));
    assert.throws(() => createHouseholdInstance({ ...options, id: 'person-a', port: 8460 }), /exists/);
    fs.symlinkSync(directory, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createHouseholdInstance({ ...options, directory: path.join(directory, 'linked'), id: 'person-b', port: 8461 }), /symbolic|linked/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('selected household runtime isolates provider homes and honours explicit workspace over selection', async () => {
  const { activateHouseholdRuntime, createHouseholdInstance } = await import('../ui/lib/household.mjs');
  const { resolveWorkspaceRoot } = await import('../ui/lib/workspace.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-env-'));
  const file = path.join(directory, 'registry.json');
  const env = { SCOUT_HOUSEHOLD_SETTINGS: file, HOME: '/synthetic/shared-home', CODEX_HOME: '/synthetic/shared-codex' };
  const credentialName = ['OPENAI', 'API', 'KEY'].join('_');
  env[credentialName] = 'synthetic-unshared-value';
  try {
    const first = createHouseholdInstance({ appRoot: process.cwd(), directory, id: 'person-a', port: 8460, file, initialise() {} });
    const second = createHouseholdInstance({ appRoot: process.cwd(), directory, id: 'person-b', port: 8461, file, initialise() {} });
    activateHouseholdRuntime(second.workspace, { env });
    assert.equal(env.HOME, second.providerHome);
    assert.equal(env.SCOUT_DEVICE_SETTINGS, second.deviceSettings);
    assert.equal(env.PORT, '8461');
    assert.equal(env[credentialName], undefined);
    assert.notEqual(env.CODEX_HOME, '/synthetic/shared-codex');
    assert.ok(env.CODEX_HOME.startsWith(second.providerHome));
    assert.equal(resolveWorkspaceRoot({ appRoot: process.cwd(), argv: ['--workspace', first.workspace], env }), first.workspace);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a real process switching from another household environment writes only the selected device settings', async () => {
  const { createHouseholdInstance, householdSettingsPath } = await import('../ui/lib/household.mjs');
  const { seedWorkspace } = await import('../ui/lib/workspace.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-inherited-'));
  const file = path.join(directory, 'registry.json');
  try {
    const options = { appRoot: process.cwd(), directory, file, initialise: (root) => seedWorkspace(process.cwd(), root) };
    const first = createHouseholdInstance({ ...options, id: 'person-a', port: 8460 });
    const second = createHouseholdInstance({ ...options, id: 'person-b', port: 8461 });
    fs.writeFileSync(first.deviceSettings, JSON.stringify({ schemaVersion: 3, updates: { policy: 'notify' } }));
    const before = fs.readFileSync(first.deviceSettings, 'utf8');
    assert.equal(householdSettingsPath({ XDG_CONFIG_HOME: directory, LOCALAPPDATA: directory, SCOUT_DEVICE_SETTINGS: first.deviceSettings }), path.join(directory, 'Scout', 'household.json'), 'an inherited device path cannot relocate the host registry');
    const script = "const s=await import('./ui/server.mjs');const d=await import('./ui/lib/deviceSettings.mjs');d.saveDeviceSettings({schemaVersion:3,updates:{policy:'download'}});console.log(JSON.stringify({workspace:s.WORKSPACE_ROOT,device:d.deviceSettingsPath()}));";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, 'synthetic-entry', '--workspace', second.workspace], {
      env: { ...process.env, SCOUT_HOUSEHOLD_SETTINGS: file, SCOUT_WORKSPACE: first.workspace, SCOUT_DEVICE_SETTINGS: first.deviceSettings }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(first.deviceSettings, 'utf8'), before, 'person A settings must not be changed by person B');
    assert.deepEqual(JSON.parse(result.stdout), { workspace: second.workspace, device: second.deviceSettings });
    assert.equal(JSON.parse(fs.readFileSync(second.deviceSettings)).updates.policy, 'download');
    const { deviceSettingsPath } = await import('../ui/lib/deviceSettings.mjs');
    assert.equal(deviceSettingsPath({ SCOUT_HOUSEHOLD_SETTINGS: file, SCOUT_WORKSPACE: second.workspace, SCOUT_DEVICE_SETTINGS: first.deviceSettings }), second.deviceSettings);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
