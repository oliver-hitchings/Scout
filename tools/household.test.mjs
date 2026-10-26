import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

test('an unavailable sibling does not block a healthy instance and list reports each availability', async (t) => {
  const { activateHouseholdRuntime, createHouseholdInstance, readHousehold, switchHouseholdInstance } = await import('../ui/lib/household.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-unavailable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'registry.json');
  const options = { appRoot: process.cwd(), directory, file, initialise() {} };
  const first = createHouseholdInstance({ ...options, id: 'synthetic-first', port: 8460 });
  const second = createHouseholdInstance({ ...options, id: 'synthetic-second', port: 8461 });
  switchHouseholdInstance(second.id, { file });
  fs.renameSync(second.workspace, `${second.workspace}-held`);
  fs.mkdirSync(second.workspace);
  const env = { ...process.env, SCOUT_HOUSEHOLD_SETTINGS: file };
  assert.equal(activateHouseholdRuntime(first.workspace, { env: { ...env } }).id, first.id);
  assert.throws(() => activateHouseholdRuntime(second.workspace, { env: { ...env } }), /identity changed|unavailable/i);
  const startup = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const server=await import('./ui/server.mjs');console.log(JSON.stringify({workspace:server.WORKSPACE_ROOT}));"], {
    env: { ...env, SCOUT_WORKSPACE: first.workspace }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(startup.status, 0, startup.stderr);
  assert.equal(JSON.parse(startup.stdout).workspace, first.workspace);
  assert.equal(readHousehold({ file }).instances.length, 2);
  const listed = spawnSync(process.execPath, ['tools/scout.mjs', 'household', 'list'], {
    env: { ...env, SCOUT_WORKSPACE: '', SCOUT_DEVICE_SETTINGS: path.join(directory, 'device.json') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).instances.map(({ id, availability }) => ({ id, availability })), [
    { id: first.id, availability: 'available' }, { id: second.id, availability: 'unavailable' },
  ]);
  assert.throws(() => switchHouseholdInstance(second.id, { file }), /identity changed|unavailable/i);
  assert.equal(switchHouseholdInstance(first.id, { file }).id, first.id);
  const registry = readHousehold({ file });
  registry.instances[1].workspace = path.join(first.workspace, 'nested');
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.throws(() => readHousehold({ file }), /overlap|isolated/i, 'structurally unsafe registries still fail closed');
});

test('household updates reclaim an old empty legacy lock without deleting any registry data', async (t) => {
  const { createHouseholdInstance, switchHouseholdInstance } = await import('../ui/lib/household.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-old-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'registry.json');
  const instance = createHouseholdInstance({ appRoot: process.cwd(), directory, file, id: 'synthetic-first', port: 8460, initialise() {} });
  const before = JSON.parse(fs.readFileSync(file));
  fs.rmSync(`${file}.lock`, { recursive: true, force: true });
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.equal(switchHouseholdInstance(instance.id, { file }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), before);
});

test('a crashed household command releases its lock while a live command stays fenced even when aged', async (t) => {
  const { createHouseholdInstance, switchHouseholdInstance } = await import('../ui/lib/household.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-crash-lock-'));
  const file = path.join(directory, 'registry.json');
  const ready = path.join(directory, 'ready');
  let child;
  const closeChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  };
  t.after(async () => { await closeChild(); fs.rmSync(directory, { recursive: true, force: true }); });
  const first = createHouseholdInstance({ appRoot: process.cwd(), directory, file, id: 'synthetic-first', port: 8460, initialise() {} });
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { createHouseholdInstance } from './ui/lib/household.mjs';
    createHouseholdInstance({appRoot:process.cwd(),directory:${JSON.stringify(directory)},file:${JSON.stringify(file)},id:'synthetic-second',port:8461,initialise(){
      fs.writeFileSync(${JSON.stringify(ready)},'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    }});
  `], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, 'the real child must hold the registry mutation lock');
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.throws(() => switchHouseholdInstance(first.id, { file }), /busy|in progress/i);
  await closeChild();
  assert.equal(switchHouseholdInstance(first.id, { file }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).instances.length, 1, 'the interrupted new instance was not committed');
  assert.equal(fs.existsSync(path.join(directory, 'workspace-synthetic-second')), true, 'partial workspace data is preserved');
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
