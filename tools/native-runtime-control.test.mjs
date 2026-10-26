import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeInstallEnvironment } from './nativeInstallBoundary.mjs';
import { createNativeRuntimeControl, nativeControlIdentity, readNativeControlRecord } from './nativeRuntimeControl.mjs';
import { readScanLease } from '../ui/lib/scanLease.mjs';
import { withWorkspaceMutationAuthorityAsync } from '../ui/lib/workspaceMutationAuthority.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-control-')));
  const workspace = path.join(temporary, 'workspace');
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  const env = nativeInstallEnvironment(process.env, { home, temporary, workspace });
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, workspace, home, env };
}

test('native runtime control accepts only the isolated native environment and protects bounded records', async (t) => {
  const f = fixture(t);
  assert.throws(() => createNativeRuntimeControl({ ...f, env: { ...f.env, SCOUT_WORKSPACE: os.tmpdir() } }), /control is unavailable/);
  const control = createNativeRuntimeControl(f);
  const directory = f.env.SCOUT_NATIVE_CONTROL_DIR;
  const identity = nativeControlIdentity(directory);
  try {
    await assert.rejects(control.request('unknown-action'), /control is unavailable/);
    const record = path.join(directory, 'oversized.json');
    fs.writeFileSync(record, 'x'.repeat(17 * 1024));
    assert.throws(() => readNativeControlRecord(directory, identity, 'oversized.json'), /control is unavailable/);
    assert.throws(() => readNativeControlRecord(directory, identity, '../outside.json'), /control is unavailable/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(directory, 'session.json')).mode & 0o777, 0o600);
    }
  } finally { await control.close(); }
  assert.equal(fs.existsSync(directory), false);
  assert.equal(f.env.NODE_OPTIONS, undefined);
});

test('native preload skips unrelated worker and provider entry points', async (t) => {
  const f = fixture(t);
  const control = createNativeRuntimeControl(f);
  const unrelated = path.join(f.temporary, 'unrelated-worker.mjs');
  fs.writeFileSync(unrelated, "console.log('synthetic worker completed');\n");
  try {
    const result = spawnSync(process.execPath, [unrelated], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'synthetic worker completed');
    assert.equal(fs.existsSync(path.join(f.env.SCOUT_NATIVE_CONTROL_DIR, 'ready.json')), false);
  } finally { await control.close(); }
});

test('an explicit foreign workspace is rejected before native server startup', async (t) => {
  const f = fixture(t);
  const other = path.join(f.temporary, 'other-workspace');
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  f.env.PORT = String(socket.address().port);
  await new Promise((resolve) => socket.close(resolve));
  const control = createNativeRuntimeControl(f);
  const child = spawn(process.execPath, [path.join(app, 'ui/server.mjs'), '--workspace', other], {
    cwd: app, env: f.env, stdio: 'ignore', windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once('close', (status) => resolve(status)));
  let timer;
  try {
    const status = await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve('still-running'), 5000); })]);
    assert.notEqual(status, 'still-running', 'a mismatched runtime must never start');
    assert.notEqual(status, 0);
    assert.equal(fs.existsSync(path.join(f.env.SCOUT_NATIVE_CONTROL_DIR, 'ready.json')), false);
    assert.equal(fs.existsSync(other), false);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await control.close();
  }
});

test('owned native server drain orders actual import after its held real checkpoint without weakening the fence', async (t) => {
  const f = fixture(t);
  // The real provider adapters can inspect only synthetic executables/homes.
  const bin = path.join(f.home, process.platform === 'win32' ? 'AppData/Roaming/npm' : '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const provider of ['codex', 'claude']) {
    const script = path.join(bin, `${provider}.mjs`);
    fs.writeFileSync(script, 'process.exit(1);\n');
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${provider}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
    else fs.writeFileSync(path.join(bin, provider), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  }
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  f.env.PORT = String(socket.address().port);
  await new Promise((resolve) => socket.close(resolve));
  const control = createNativeRuntimeControl(f);
  const child = spawn(process.execPath, [path.join(app, 'ui/server.mjs')], {
    cwd: app, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolve) => child.once('close', resolve));
  const base = `http://127.0.0.1:${f.env.PORT}`;
  const post = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      try { if ((await fetch(`${base}/api/app-info`)).ok) break; } catch {}
      assert.ok(Date.now() < deadline && child.exitCode === null, 'owned native server must start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await post('/api/workspace/create', {})).status, 200);
    await control.drain();
    assert.equal((await post('/api/setup/config', { mode: 'background', profile: { displayName: 'Synthetic Profile' },
      search: { roleFamilies: ['Synthetic Engineer'], locations: ['Remote'] } })).status, 200);
    await control.drain();
    await control.request('hold-checkpoint');
    assert.equal(readScanLease(f.workspace).operation.kind, 'backup');
    await assert.rejects(withWorkspaceMutationAuthorityAsync(f.workspace, { kind: 'cv-import', phase: 'import-cv' }, async () => {}),
      (error) => error.name === 'WorkspaceMutationBusyError' && error.reasonCode === 'mutation-busy');
    const input = { name: 'synthetic.md', base64: Buffer.from('Delivered reliable synthetic systems. '.repeat(70)).toString('base64') };
    const blocked = await post('/api/setup/import-cv', input);
    assert.deepEqual(blocked, { status: 400, body: { error: 'CV import could not be completed.', reasonCode: 'request-failed' } });
    assert.equal(fs.existsSync(path.join(f.workspace, 'imports/synthetic.md')), false);
    await control.drain();
    const accepted = await post('/api/setup/import-cv', input);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.ok, true);
    await Promise.all([control.drain(), control.drain()]);
    const directory = f.env.SCOUT_NATIVE_CONTROL_DIR;
    assert.deepEqual(fs.readdirSync(directory).sort(), ['ready.json', 'session.json']);
    if (process.platform !== 'win32') for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
  } finally {
    await control.drain().catch(() => {});
    await post('/api/shutdown', {}).catch(() => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await closed; }
    finally { clearTimeout(timer); await control.close(); }
  }
});
