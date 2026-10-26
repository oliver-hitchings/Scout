import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createHouseholdInstance } from '../ui/lib/household.mjs';
import { seedWorkspace } from '../ui/lib/workspace.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-household-native-'));
  const registry = path.join(directory, 'household.json');
  const options = { appRoot: process.cwd(), directory, file: registry, initialise: (root) => seedWorkspace(process.cwd(), root) };
  const first = createHouseholdInstance({ ...options, id: 'person-a', port: 8460 });
  const second = createHouseholdInstance({ ...options, id: 'person-b', port: 8461 });
  const job = { id: 'codex-primary', provider: 'codex', mode: 'primary', enabled: true, model: null, time: '07:30', days: [1, 2, 3, 4, 5] };
  for (const instance of [first, second]) {
    const file = path.join(instance.workspace, 'workspace.json');
    const config = JSON.parse(fs.readFileSync(file)); config.schedule.jobs = [job];
    fs.writeFileSync(file, JSON.stringify(config));
  }
  const callLog = path.join(directory, 'native-calls.log');
  const hook = path.join(directory, 'fake-native.mjs');
  fs.writeFileSync(hook, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';cp.spawnSync=(command,args)=>{fs.appendFileSync(process.env.SCOUT_NATIVE_CALL_LOG,JSON.stringify({command,args}));return {status:0,stdout:'',stderr:''};};syncBuiltinESMExports();`);
  const env = { ...process.env, SCOUT_HOUSEHOLD_SETTINGS: registry, SCOUT_WORKSPACE: first.workspace, SCOUT_DEVICE_SETTINGS: first.deviceSettings,
    SCOUT_NATIVE_CALL_LOG: callLog, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` };
  const before = [first, second].map((instance) => fs.readFileSync(path.join(instance.workspace, 'workspace.json'), 'utf8'));
  const checkUntouched = () => {
    assert.equal(fs.existsSync(callLog), false, 'no native scheduler/system command may be invoked');
    assert.deepEqual([first, second].map((instance) => fs.readFileSync(path.join(instance.workspace, 'workspace.json'), 'utf8')), before, 'neither person’s saved schedule may change');
  };
  return { directory, first, second, env, checkUntouched };
}

for (const action of ['install', 'remove', 'run-now']) {
  test(`household CLI rejects native schedule ${action} before any injected system command`, () => {
    const data = fixture();
    try {
      const result = spawnSync(process.execPath, ['tools/scout.mjs', 'schedule', action, '--provider', 'codex', '--id', 'codex-primary', '--workspace', data.first.workspace], { env: data.env, encoding: 'utf8', timeout: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /server owner|system timers/i);
      data.checkUntouched();
    } finally { fs.rmSync(data.directory, { recursive: true, force: true }); }
  });
}

test('household CLI reports owner-managed schedules without querying native task state', () => {
  const data = fixture();
  try {
    const result = spawnSync(process.execPath, ['tools/scout.mjs', 'schedule', 'status', '--workspace', data.first.workspace], { env: data.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.managedExternally, true);
    assert.equal(status.runs[0].supported, false);
    data.checkUntouched();
  } finally { fs.rmSync(data.directory, { recursive: true, force: true }); }
});

test('real household HTTP schedule actions fail closed and status explains owner system timers', async () => {
  const data = fixture();
  const script = "const {createServer}=await import('./ui/server.mjs');const server=createServer();server.listen(0,'127.0.0.1',()=>console.log(server.address().port));";
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, 'synthetic-entry', '--workspace', data.first.workspace], { env: data.env, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
  const closed = once(child, 'close');
  let timer;
  try {
    const port = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('synthetic server startup timed out')), 8000);
      child.stdout.once('data', (chunk) => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
    });
    for (const action of ['install', 'remove', 'run-now']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: 'codex-primary', provider: 'codex', mode: 'primary' }) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).reasonCode, 'household-system-timer-required');
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/opportunities`);
    assert.equal(response.status, 200);
    const status = (await response.json()).schedule;
    assert.equal(status.managedExternally, true);
    assert.equal(status.supported, false);
    assert.match(status.managementMessage, /server owner|system timers/i);
    data.checkUntouched();
  } finally {
    clearTimeout(timer); child.kill('SIGTERM'); await closed;
    fs.rmSync(data.directory, { recursive: true, force: true });
  }
});

test('explicit headless systemd instances reject desktop schedule actions even with their registry hidden', () => {
  const data = fixture();
  try {
    const env = { ...data.env, SCOUT_HOUSEHOLD_SETTINGS: path.join(data.directory, 'hidden-registry.json'), SCOUT_HEADLESS: '1' };
    for (const action of ['install', 'remove', 'run-now']) {
      const result = spawnSync(process.execPath, ['tools/scout.mjs', 'schedule', action, '--provider', 'codex', '--id', 'codex-primary', '--workspace', data.first.workspace], { env, encoding: 'utf8', timeout: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /server owner|system timers/i);
    }
    data.checkUntouched();
  } finally { fs.rmSync(data.directory, { recursive: true, force: true }); }
});

test('direct desktop schedule installation also rejects household roots before native commands', () => {
  const data = fixture();
  try {
    const script = "try{const {installSchedule}=await import('./tools/scout.mjs');installSchedule(process.env.SCOUT_WORKSPACE,'07:30','codex');}catch(e){console.error(e.message);process.exitCode=1;}";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: data.env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /server owner|system timers/i);
    data.checkUntouched();
  } finally { fs.rmSync(data.directory, { recursive: true, force: true }); }
});
