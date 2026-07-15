import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  confirmRecoveryKey, connectWorkspaceSync, disableWorkspaceSync, loadSyncSettings, pendingRecoveryKey,
  queueWorkspaceSync, restoreWorkspaceFromGithub, runWorkspaceSync, syncStatus, validateGithubUrl,
  verifyPrivateGithubRemote,
} from './workspaceSync.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-sync-'));
  const root = path.join(base, 'device-one');
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"opportunities":[]}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n.scout/\napplications/**/*.pdf\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=synthetic\n');
  git(base, 'init', '--bare', remote);
  return { base, root, remote };
}

const fakeCapabilities = (spawn) => ({ spawn });

test('GitHub repository URLs reject credentials and non-GitHub remotes', () => {
  assert.equal(validateGithubUrl('https://github.com/example/scout-workspace').url, 'https://github.com/example/scout-workspace.git');
  assert.throws(() => validateGithubUrl('https://token@github.com/example/repo'), /credential-free/);
  assert.throws(() => validateGithubUrl('https://example.com/example/repo'), /credential-free/);
});

test('privacy verification rejects a repository visible without authentication', async () => {
  await assert.rejects(() => verifyPrivateGithubRemote('https://github.com/example/repo', {
    fetchFn: async () => ({ status: 200 }),
  }), /public/);
});

test('connecting an existing remote is rejected before origin is changed', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  await assert.rejects(() => connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/existing', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), spawn }), /Use Restore existing workspace/);
  assert.equal(git(f.root, 'remote'), '');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('sync refuses sensitive files already tracked by Git', async () => {
  const f = fixture();
  git(f.root, 'init');
  git(f.root, 'config', 'user.name', 'Test');
  git(f.root, 'config', 'user.email', 'test@example.invalid');
  git(f.root, 'add', '-f', '.env');
  git(f.root, 'commit', '-m', 'unsafe fixture');
  await assert.rejects(() => runWorkspaceSync(f.root, 'unsafe sync'), /sensitive ignored files are already tracked: \.env/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('local-only checkpoints never contact a Git remote', async () => {
  const f = fixture();
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push(args);
    return spawnSync(command, args, options);
  };
  git(f.root, 'init');
  const result = await runWorkspaceSync(f.root, 'local only change', { spawn });
  assert.equal(result.state, 'disabled');
  assert.match(git(f.root, 'log', '-1', '--pretty=%s'), /local only change/);
  assert.equal(calls.some((args) => ['fetch', 'push', 'pull', 'ls-remote'].includes(args[0])), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('optional sync commits, pushes, restores ignored state, and can be disabled', async () => {
  const f = fixture();
  const verifyRemote = async () => ({ url: f.remote, empty: true, owner: 'test', repo: 'test' });
  const spawn = (command, args, options) => {
    if (args[0] === '--version') return spawnSync(command, args, options);
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote, ...fakeCapabilities(spawn) });
  assert.equal(connected.status.state, 'synced');
  assert.equal(loadSyncSettings(f.root).enabled, true);
  assert.equal(pendingRecoveryKey(f.root), connected.recoveryKey);
  assert.doesNotMatch(JSON.stringify(syncStatus(f.root, fakeCapabilities(spawn))), new RegExp(connected.recoveryKey));
  assert.deepEqual(confirmRecoveryKey(f.root), { ok: true, confirmed: true });
  assert.equal(pendingRecoveryKey(f.root), null);
  assert.match(git(f.root, 'log', '-1', '--pretty=%s'), /enable private backup/);

  fs.writeFileSync(path.join(f.root, 'data', 'chats.json'), '{"message":"hello"}\n');
  await queueWorkspaceSync(f.root, 'save chat', fakeCapabilities(spawn));
  assert.equal(syncStatus(f.root, fakeCapabilities(spawn)).state, 'synced');

  const target = path.join(f.base, 'device-two');
  const restored = await restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: target, secret: connected.recoveryKey,
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), ...fakeCapabilities(spawn) });
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'SECRET=synthetic\n');
  assert.match(fs.readFileSync(path.join(target, 'data', 'chats.json'), 'utf8'), /hello/);
  assert.equal(loadSyncSettings(target).enabled, true);
  assert.equal(disableWorkspaceSync(target).state, 'disabled');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('two devices fast-forward safely and divergence never resets, rebases, or force-pushes', async () => {
  const f = fixture();
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push(args);
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  const deviceTwo = path.join(f.base, 'device-two');
  await restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: deviceTwo, secret: connected.recoveryKey,
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), spawn });

  fs.writeFileSync(path.join(f.root, 'data', 'from-one.json'), '{}\n');
  fs.writeFileSync(path.join(f.root, '.env'), 'SECRET=updated-on-one\n');
  assert.equal((await runWorkspaceSync(f.root, 'device one change', { spawn })).state, 'synced');
  const pulled = await runWorkspaceSync(deviceTwo, 'check remote', {
    spawn,
    deviceSettings: { startWithWindows: false, completedSections: { 'windows-startup': 1 } },
  });
  assert.equal(pulled.state, 'synced');
  assert.equal(pulled.pulled, true);
  assert.equal(fs.existsSync(path.join(deviceTwo, 'data', 'from-one.json')), true);
  assert.equal(fs.readFileSync(path.join(deviceTwo, '.env'), 'utf8'), 'SECRET=updated-on-one\n');

  const refreshedOne = await runWorkspaceSync(f.root, 'refresh device one', { spawn });
  assert.equal(refreshedOne.state, 'synced');
  assert.equal(refreshedOne.pulled, true);
  fs.writeFileSync(path.join(f.root, 'data', 'remote-change.json'), '{}\n');
  await runWorkspaceSync(f.root, 'remote change', { spawn });
  fs.writeFileSync(path.join(deviceTwo, 'data', 'local-change.json'), '{}\n');
  const diverged = await runWorkspaceSync(deviceTwo, 'local change', { spawn });
  assert.equal(diverged.state, 'needs-attention');
  assert.equal(diverged.conflict, true);
  assert.equal(fs.existsSync(path.join(deviceTwo, 'data', 'local-change.json')), true);
  assert.equal(fs.existsSync(path.join(deviceTwo, 'data', 'remote-change.json')), false);
  assert.equal(calls.some((args) => args.includes('rebase') || args.includes('reset') || args.some((arg) => /^--force/.test(arg))), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('offline sync keeps a local commit pending', async () => {
  const f = fixture();
  const realSpawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn: realSpawn });
  fs.writeFileSync(path.join(f.root, 'data', 'offline.json'), '{}\n');
  const offlineSpawn = (command, args, options) => args[0] === 'fetch'
    ? { status: 1, stdout: '', stderr: 'synthetic offline' }
    : realSpawn(command, args, options);
  const result = await runWorkspaceSync(f.root, 'offline change', { spawn: offlineSpawn });
  assert.equal(result.state, 'offline');
  assert.equal(result.pending, true);
  assert.match(git(f.root, 'log', '-1', '--pretty=%s'), /offline change/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('backup setup still returns the recovery key when the first checkpoint needs attention', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'synthetic commit failure' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  assert.match(connected.recoveryKey, /^SCOUT-1-/);
  assert.equal(connected.status.state, 'needs-attention');
  assert.equal(connected.status.pending, true);
  assert.match(connected.status.error, /synthetic commit failure/);
  assert.equal(loadSyncSettings(f.root).enabled, true);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('restore validation fails before installing the target workspace', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  const target = path.join(f.base, 'rejected-device');
  await assert.rejects(() => restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: target, secret: connected.recoveryKey,
  }, {
    verifyRemote: async () => ({ url: f.remote, empty: false }), spawn,
    validateWorkspace: () => ({ ok: false }),
  }), /did not pass Scout doctor/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(f.base).some((name) => name.startsWith('.scout-restore-')), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});
