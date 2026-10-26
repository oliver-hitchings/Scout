import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = new URL('./release-signing.mjs', import.meta.url);

test('release readiness skips an empty or revoked registry, validates active public keys and rejects malformed trust', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-signing-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trustFile = path.join(root, 'trust.json');
  const run = (trust) => {
    fs.writeFileSync(trustFile, JSON.stringify(trust));
    return spawnSync(process.execPath, [fileURLToPath(cli), 'readiness', '--trust-file', trustFile], { encoding: 'utf8' });
  };
  const empty = run({ schemaVersion: 1, keys: [], revokedKeyIds: [] });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, 'enrolled=false\n');
  assert.match(empty.stderr, /skipped.*no active.*enrolled/i);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const key = { keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  const enrolled = run({ schemaVersion: 1, keys: [key], revokedKeyIds: [] });
  assert.equal(enrolled.status, 0, enrolled.stderr);
  assert.equal(enrolled.stdout, 'enrolled=true\n');
  assert.doesNotMatch(enrolled.stdout + enrolled.stderr, /BEGIN PUBLIC|[a-f0-9]{64}/);
  const revoked = run({ schemaVersion: 1, keys: [key], revokedKeyIds: [keyId] });
  assert.equal(revoked.status, 0);
  assert.equal(revoked.stdout, 'enrolled=false\n');
  for (const trust of [
    { schemaVersion: 1, keys: [{ ...key, keyId: '0'.repeat(64) }], revokedKeyIds: [] },
    { schemaVersion: 1, keys: [key, key], revokedKeyIds: [] },
    { schemaVersion: 1, keys: [{ ...key, publicKey: 'invalid' }], revokedKeyIds: [] },
    { schemaVersion: 1, keys: [], revokedKeyIds: ['invalid'] },
    { schemaVersion: 1, keys: [], revokedKeyIds: [], unexpected: true },
  ]) {
    const result = run(trust);
    assert.notEqual(result.status, 0, 'Malformed enrollment must fail rather than silently skip');
    assert.doesNotMatch(result.stdout, /enrolled=/);
  }
});

test('release CLI signs each artifact and verifies installer bytes against independently trusted and revoked keys', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-signing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'artifacts'); fs.mkdirSync(output);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(root, 'ephemeral-signing.key');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const trust = { schemaVersion: 1, keys: [{ keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }], revokedKeyIds: [] };
  const trustFile = path.join(root, 'trust.json'); fs.writeFileSync(trustFile, JSON.stringify(trust));
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const names = ['windows-x64.exe', 'macos-arm64.dmg', 'macos-x64.dmg', 'linux-x64.deb', 'linux-x64.tar.gz'].map((suffix) => `Scout-${version}-${suffix}`);
  for (const name of names) fs.writeFileSync(path.join(output, name), 'synthetic package');
  const run = (args) => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: 'utf8' });
  const signed = run(['sign', '--directory', output, '--version', version, '--key-file', keyFile]);
  assert.equal(signed.status, 0, signed.stderr);
  const manifestFile = path.join(output, 'release-manifest.json');
  const signatureFile = path.join(output, 'release-manifest.sig');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.name), [...names].sort());
  assert.ok(manifest.artifacts.every((artifact) => artifact.sha256 === crypto.createHash('sha256').update('synthetic package').digest('hex')));
  const args = ['verify', '--package', path.join(output, names[0]), '--manifest', manifestFile, '--signature', signatureFile, '--version', version, '--trust-file', trustFile];
  for (const name of names) {
    const platformArgs = [...args]; platformArgs[2] = path.join(output, name);
    assert.equal(run(platformArgs).status, 0, name);
  }
  const wrongVersion = [...args]; wrongVersion[wrongVersion.indexOf('--version') + 1] = '0.1.0-beta.23';
  assert.notEqual(run(wrongVersion).status, 0, 'The candidate signature must reject the previous package version');
  fs.writeFileSync(path.join(output, names[0]), 'tampered package!');
  assert.notEqual(run(args).status, 0);
  fs.writeFileSync(path.join(output, names[0]), 'synthetic package');
  trust.revokedKeyIds.push(keyId); fs.writeFileSync(trustFile, JSON.stringify(trust));
  assert.notEqual(run(args).status, 0);
  trust.revokedKeyIds = []; trust.keys = []; fs.writeFileSync(trustFile, JSON.stringify(trust));
  assert.notEqual(run(args).status, 0);
  assert.notEqual(run(args.slice(0, -2)).status, 0, 'bundled trust never accepts the generated test key');
});
