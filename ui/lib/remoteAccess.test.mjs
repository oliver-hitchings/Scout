import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseHttpsPort, detectTailscale, disableRemoteAccess, enableRemoteAccess,
  remoteAccessStatus, serveMappingPresent, servePortOccupied, tailscaleIdentity,
} from './remoteAccess.mjs';

const STATUS = {
  BackendState: 'Running', Self: { DNSName: 'olive-desktop.tailnet.ts.net.', UserID: 7 },
  User: { 7: { LoginName: 'owner@example.com' } },
};
const SERVE = { Web: { 'olive-desktop.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };

function fakeSpawn({ serve = SERVE, enableStatus = 0, enableOutput = '' } = {}) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'version') return { status: 0, stdout: '1.92.0\n' };
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify(STATUS) };
    if (args[0] === 'serve' && args[1] === 'status') return { status: 0, stdout: JSON.stringify(serve) };
    if (args[0] === 'serve' && args.at(-1) === 'off') return { status: 0, stdout: '' };
    return { status: enableStatus, stdout: enableOutput, stderr: enableStatus ? enableOutput : '' };
  };
  return { spawn, calls };
}

test('detects Tailscale and extracts the signed-in owner identity', () => {
  const { spawn } = fakeSpawn();
  assert.equal(detectTailscale({ spawn, candidates: ['tailscale'] }).installed, true);
  assert.deepEqual(tailscaleIdentity(STATUS), { running: true, ownerLogin: 'owner@example.com', dnsName: 'olive-desktop.tailnet.ts.net' });
});

test('chooses 443 when free, 8443 on conflict and refuses occupied custom ports', () => {
  assert.equal(chooseHttpsPort({}, null), 443);
  assert.equal(chooseHttpsPort(SERVE, null), 8443);
  assert.throws(() => chooseHttpsPort(SERVE, 443), /already in use/);
  assert.equal(servePortOccupied(SERVE, 443), true);
  assert.equal(servePortOccupied({ Web: { 'host:8443': { Handlers: { '/': { Proxy: 'https://localhost:3000' } } } } }, 443), false);
});

test('recognises only a mapping with both the selected port and Scout target', () => {
  assert.equal(serveMappingPresent(SERVE, 443, 8459), false);
  const scout = { Web: { 'olive-desktop.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8459' } } } } };
  assert.equal(serveMappingPresent(scout, 8443, 8459), true);
  const split = { Web: {
    'olive-desktop.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
    'olive-desktop.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8459' } } },
  } };
  assert.equal(serveMappingPresent(split, 443, 8459), false);
});

test('enables a background HTTPS mapping without a shell and records ownership', () => {
  const { spawn, calls } = fakeSpawn();
  const result = enableRemoteAccess({ schemaVersion: 2 }, {}, { spawn, candidates: ['tailscale'], now: 0 });
  assert.equal(result.state, 'enabled');
  assert.equal(result.origin, 'https://olive-desktop.tailnet.ts.net:8443');
  assert.equal(result.settings.remoteAccess.ownerLogin, 'owner@example.com');
  assert.deepEqual(calls.at(-1)[1], ['serve', '--bg', '--https=8443', '8459']);
});

test('returns an authorization URL instead of enabling on a consent challenge', () => {
  const { spawn } = fakeSpawn({ enableStatus: 1, enableOutput: 'Approve at https://login.tailscale.com/a/abc' });
  const result = enableRemoteAccess({}, {}, { spawn, candidates: ['tailscale'] });
  assert.equal(result.state, 'authorizing');
  assert.equal(result.authorizationUrl, 'https://login.tailscale.com/a/abc');
});

test('status reports a missing managed mapping as needs attention', () => {
  const { spawn } = fakeSpawn({ serve: {} });
  const settings = { remoteAccess: { enabled: true, ownerLogin: 'owner@example.com', origin: 'https://olive-desktop.tailnet.ts.net:8443', httpsPort: 8443, managedMapping: { target: 'http://127.0.0.1:8459' } } };
  assert.equal(remoteAccessStatus(settings, { spawn, candidates: ['tailscale'] }).state, 'needs-attention');
});

test('disable is idempotent and refuses to remove a changed mapping', () => {
  const disabled = disableRemoteAccess({ remoteAccess: { enabled: false } });
  assert.equal(disabled.state, 'disabled');
  const settings = { remoteAccess: { enabled: true, httpsPort: 8443, managedMapping: { target: 'http://127.0.0.1:8459' } } };
  const changed = { Web: { 'olive-desktop.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const { spawn } = fakeSpawn({ serve: changed });
  assert.throws(() => disableRemoteAccess(settings, { spawn, candidates: ['tailscale'] }), /configuration has changed/);
  const absent = fakeSpawn({ serve: {} });
  assert.equal(disableRemoteAccess(settings, { spawn: absent.spawn, candidates: ['tailscale'] }).state, 'disabled');
  assert.equal(absent.calls.some(([, args]) => args.at(-1) === 'off'), false);
});
