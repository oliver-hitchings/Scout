import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSafeModel,
  commandInvocation,
  providerEnvironment,
  providerCandidates,
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

test('Codex candidates include the official OpenAI Windows installation', () => {
  const candidates = providerCandidates('codex', {
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\Oli', LOCALAPPDATA: 'C:\\Users\\Oli\\AppData\\Local', APPDATA: 'C:\\Users\\Oli\\AppData\\Roaming', Path: '' },
    exists: (candidate) => candidate.endsWith('Programs\\OpenAI\\Codex\\bin\\codex.exe'),
    resolve: () => 'codex.cmd',
  });
  assert.equal(candidates[0], 'C:\\Users\\Oli\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
});

test('provider status exposes bounded structured-output compatibility', () => {
  const spawn = (command, args) => {
    if (args.includes('--version')) return { status: 0, stdout: '2.1.205' };
    if (args[0] === 'auth') return { status: 0, stdout: 'logged in' };
    return { status: 0, stdout: '--json-schema --no-session-persistence' };
  };
  const compatible = providerStatus('claude', { spawn, platform: 'linux' });
  assert.equal(compatible.authenticated, true);
  assert.equal(compatible.capabilities.structuredOutput, true);

  const old = providerStatus('claude', {
    spawn: (command, args) => args.includes('--version') || args[0] === 'auth'
      ? { status: 0, stdout: 'old' } : { status: 0, stdout: '--print only' },
    platform: 'linux',
  });
  assert.equal(old.authenticated, true);
  assert.equal(old.capabilities.structuredOutput, false);
});

test('Windows provider candidates tolerate lowercase packaged-runtime environment keys', () => {
  const candidates = providerCandidates('codex', {
    platform: 'win32',
    env: { userprofile: 'C:\\Users\\ScoutQA', localappdata: 'C:\\Users\\ScoutQA\\AppData\\Local', path: '' },
    exists: (candidate) => candidate.toLowerCase().endsWith('programs\\openai\\codex\\bin\\codex.exe'),
    resolve: () => null,
  });
  assert.equal(candidates[0], 'C:\\Users\\ScoutQA\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
});

test('Windows provider candidates recover the user home from LocalAppData', () => {
  const candidates = providerCandidates('claude', {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\ScoutQA\\AppData\\Local', Path: '' },
    exists: (candidate) => candidate.toLowerCase().endsWith('.local\\bin\\claude.exe'),
    resolve: () => null,
  });
  assert.equal(candidates[0], 'C:\\Users\\ScoutQA\\.local\\bin\\claude.exe');
});

test('packaged Scout derives LocalAppData from its own runtime path', () => {
  const candidates = providerCandidates('codex', {
    platform: 'win32',
    env: { Path: '' },
    runtimePath: 'C:\\Users\\ScoutQA\\AppData\\Local\\Programs\\Scout\\runtime\\ScoutRuntime.exe',
    exists: () => false,
    resolve: () => null,
  });
  assert.equal(candidates[0], 'C:\\Users\\ScoutQA\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
});

test('packaged Scout gives provider turns the interactive user home', () => {
  const env = providerEnvironment(
    { Path: 'C:\\Windows\\System32' },
    'win32',
    'C:\\Users\\ScoutQA\\AppData\\Local\\Programs\\Scout\\runtime\\ScoutRuntime.exe',
  );
  assert.equal(env.USERPROFILE, 'C:\\Users\\ScoutQA');
  assert.equal(env.HOME, 'C:\\Users\\ScoutQA');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\ScoutQA\\AppData\\Local');
  assert.equal(env.APPDATA, 'C:\\Users\\ScoutQA\\AppData\\Roaming');
  assert.match(env.Path, /C:\\Users\\ScoutQA\\\.local\\bin/i);
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
    env: { USERPROFILE: 'C:\\Users\\example', APPDATA: 'C:\\Users\\example\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local', Path: 'C:\\Windows\\System32' },
    exists: () => false,
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
  assert.doesNotMatch(JSON.stringify(result), /USERPROFILE|ComSpec|SystemRoot/);
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
