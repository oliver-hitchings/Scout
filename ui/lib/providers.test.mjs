import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSafeModel,
  commandInvocation,
  providerEnvironment,
  providerCommand,
  providerStatus,
} from './providers.mjs';

test('provider commands allow Windows resolution to choose native executables or cmd shims', () => {
  assert.equal(providerCommand('codex', 'win32'), 'codex.cmd');
  assert.equal(providerCommand('claude', 'linux'), 'claude');
});

test('provider status distinguishes install and authentication', () => {
  const calls = [];
  const spawn = (command, args) => { calls.push([command, args]); return { status: calls.length === 1 ? 0 : 1, stdout: '1.2.3', stderr: 'not logged in' }; };
  const result = providerStatus('codex', { spawn, platform: 'linux' });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, false);
  assert.deepEqual(calls[1][1], ['login', 'status']);
});

test('Windows provider environment includes standard Codex and Claude install locations', () => {
  const env = providerEnvironment({
    USERPROFILE: 'C:\\Users\\example',
    APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
    Path: 'C:\\Windows\\System32',
  }, 'win32');
  assert.match(env.Path, /C:\\Users\\example\\AppData\\Roaming\\npm/i);
  assert.match(env.Path, /C:\\Program Files\\nodejs/i);
  assert.match(env.Path, /C:\\Users\\example\\\.local\\bin/i);
  assert.match(env.Path, /C:\\Windows\\System32/i);
});

test('provider checks receive the augmented environment', () => {
  const calls = [];
  const spawn = (command, args, options) => { calls.push(options); return { status: 0, stdout: 'ok', stderr: '' }; };
  providerStatus('codex', {
    spawn, platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\example', APPDATA: 'C:\\Users\\example\\AppData\\Roaming', Path: 'C:\\Windows\\System32' },
    resolve: (command, options) => { assert.match(options.env.Path, /AppData\\Roaming\\npm/i); return 'codex.exe'; },
  });
  assert.match(calls[0].env.Path, /AppData\\Roaming\\npm/i);
  assert.match(calls[1].env.Path, /\.local\\bin/i);
});

test('Windows provider status uses a resolved native executable directly', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, args, options]);
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const result = providerStatus('claude', {
    spawn,
    platform: 'win32',
    resolve: () => 'C:\\Users\\example\\.local\\bin\\claude.exe',
  });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, true);
  assert.equal(calls[0][0], 'C:\\Users\\example\\.local\\bin\\claude.exe');
  assert.equal(calls[0][2].shell, false);
});

test('provider status does not expose authenticated account metadata', () => {
  let call = 0;
  const spawn = () => (++call === 1
    ? { status: 0, stdout: '1.2.3', stderr: '' }
    : { status: 0, stdout: '{"loggedIn":true,"email":"person@example.test"}', stderr: '' });
  const result = providerStatus('claude', { spawn, platform: 'linux' });
  assert.equal(result.authMessage, 'Logged in');
  assert.doesNotMatch(JSON.stringify(result), /person@example\.test/);
});

test('Windows cmd shims use cmd.exe without enabling a Node shell', () => {
  const invocation = commandInvocation('codex', ['exec', 'value & literal'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    resolve: () => 'C:\\Program Files\\npm\\codex.cmd',
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.shell, false);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /^""C:\\Program Files\\npm\\codex\.cmd"/);
  assert.match(invocation.args[3], /"value \^& literal""$/);
});

test('model overrides reject shell metacharacters', () => {
  assert.equal(assertSafeModel('gpt-example-1'), 'gpt-example-1');
  assert.throws(() => assertSafeModel('model & calc'), /invalid model/);
});
