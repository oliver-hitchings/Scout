import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkForUpdate, compareVersions, downloadVerifiedUpdate, packageName, parseChecksums,
  publicDownloadedUpdate, publicIsoTimestamp, publicUpdateLocationHint,
} from './updates.mjs';

function streamedResponse(chunks, headers = {}) {
  return {
    ok: true,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(new Uint8Array(chunk)));
        controller.close();
      },
    }),
    arrayBuffer: async () => { throw new Error('package must not be buffered'); },
  };
}

test('beta versions compare numerically', () => {
  assert.equal(compareVersions('0.1.0-beta.10', '0.1.0-beta.9'), 1);
  assert.equal(compareVersions('v0.1.0-beta.7', '0.1.0-beta.7'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.99'), 1);
});

test('download projection never exposes its device-local absolute path', () => {
  const projected = publicDownloadedUpdate({
    path: ['C:', 'Users', 'Owner', 'AppData', 'Local', 'Scout', 'updates', 'Scout.exe'].join('\\'),
    name: 'Scout-0.1.0-beta.23-windows-x64.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0-beta.23',
    verifiedAt: '2026-07-29T10:00:00.000Z',
  }, { env: { LOCALAPPDATA: 'SYNTHETIC_LOCAL_APP_DATA' }, platform: 'win32' });
  assert.deepEqual(projected, {
    name: 'Scout-0.1.0-beta.23-windows-x64.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0-beta.23',
    verifiedAt: '2026-07-29T10:00:00.000Z',
    locationHint: '%LOCALAPPDATA%\\Scout\\updates\\Scout-0.1.0-beta.23-windows-x64.exe',
  });
  assert.equal('path' in projected, false);
  assert.equal(publicDownloadedUpdate({
    path: '/private/update',
    name: '../private-update.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0',
    verifiedAt: '2026-07-29T10:00:00.000Z',
  }), null);
  assert.equal(publicDownloadedUpdate({
    name: 'Private-Person.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0-private-person',
    verifiedAt: '2026-07-29T10:00:00.000Z',
  }), null);
  assert.equal(
    publicIsoTimestamp(`July 29, 2026 (${['', 'Users', 'private', 'Scout'].join('/')})`),
    null,
  );
  assert.equal(publicIsoTimestamp('2026-07-29T10:00:00Z'), '2026-07-29T10:00:00.000Z');
  assert.equal(
    publicUpdateLocationHint('Scout-0.1.0-beta.23-linux-x64.deb', {
      env: { XDG_CONFIG_HOME: 'SYNTHETIC_XDG_CONFIG' }, platform: 'linux',
    }),
    '$XDG_CONFIG_HOME/Scout/updates/Scout-0.1.0-beta.23-linux-x64.deb',
  );
  assert.equal(
    publicUpdateLocationHint('Scout-0.1.0-beta.23-macos-arm64.dmg', {
      env: { SCOUT_DEVICE_SETTINGS: 'SYNTHETIC_SETTINGS' }, platform: 'darwin',
    }),
    'the updates folder beside $SCOUT_DEVICE_SETTINGS',
  );
  assert.equal(publicUpdateLocationHint('Private-Person.exe'), null);
});

test('update check selects a newer verified Scout release and device package', async () => {
  const result = await checkForUpdate('0.1.0-beta.7', async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.1.0-beta.8', draft: false, html_url: 'https://github.com/oliver-hitchings/Scout/releases/tag/v0.1.0-beta.8', body: 'Safer updates', published_at: '2026-07-18T10:00:00Z', assets: [
      { name: 'Scout-0.1.0-beta.8-windows-x64.exe', browser_download_url: 'https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.8/Scout-0.1.0-beta.8-windows-x64.exe' },
      ...['checksums.txt', 'release-manifest.json', 'release-manifest.sig'].map((name) => ({ name, browser_download_url: `https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.8/${name}` })),
    ] },
  ] }), { platform: 'win32', arch: 'x64' });
  assert.equal(result.available, true); assert.equal(result.latestVersion, '0.1.0-beta.8');
  assert.equal(result.package.name, 'Scout-0.1.0-beta.8-windows-x64.exe');
  assert.equal(result.releaseNotes, 'Safer updates');
});

test('update check rejects a non-Scout release URL', async () => {
  const result = await checkForUpdate('0.1.0-beta.7', async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.1.0-beta.8', draft: false, html_url: 'https://example.test/release' },
  ] }));
  assert.equal(result.available, false); assert.equal(result.url, null);
});

test('platform package names are explicit and unsupported devices do not guess', () => {
  assert.equal(packageName('1.2.3', 'win32', 'x64'), 'Scout-1.2.3-windows-x64.exe');
  assert.equal(packageName('1.2.3', 'darwin', 'arm64'), 'Scout-1.2.3-macos-arm64.dmg');
  assert.equal(packageName('1.2.3', 'linux', 'x64', { preferPortable: true }), 'Scout-1.2.3-linux-x64.tar.gz');
  assert.equal(packageName('1.2.3', 'linux', 'arm64'), null);
});

test('checksum parser rejects paths and verified download is written atomically', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = signedFixture();
  assert.equal(parseChecksums(`${fixture.sha256}  ../bad.exe\n`).size, 0);
  const result = await downloadVerifiedUpdate(fixture.update, directory, { trustedKeys: fixture.trust, fetchFn: fixture.fetch });
  assert.equal(result.sha256, fixture.sha256);
  assert.deepEqual(fs.readFileSync(result.path), fixture.bytes);
  assert.deepEqual(fs.readdirSync(directory), [fixture.name]);
});

test('verified download refuses a checksum mismatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-update-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = signedFixture(Buffer.from('good'));
  await assert.rejects(downloadVerifiedUpdate(fixture.update, directory, {
    trustedKeys: fixture.trust,
    fetchFn: (url) => url.endsWith('.exe') ? streamedResponse([Buffer.from('evil')]) : fixture.fetch(url),
  }), /checksum verification failed/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('verified download enforces its byte limit while streaming and removes the partial file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-update-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = signedFixture(Buffer.from('good'));
  await assert.rejects(downloadVerifiedUpdate(fixture.update, directory, {
    trustedKeys: fixture.trust, maxPackageBytes: 5,
    fetchFn: (url) => url.endsWith('.exe') ? streamedResponse([Buffer.from('abc'), Buffer.from('def')]) : fixture.fetch(url),
  }), /download limit/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

function signedFixture(bytes = Buffer.from('synthetic installer')) {
  const version = '0.1.0-beta.12';
  const name = `Scout-${version}-windows-x64.exe`;
  const base = `https://github.com/oliver-hitchings/Scout/releases/download/v${version}`;
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = `${JSON.stringify({ schemaVersion: 1, repository: 'oliver-hitchings/Scout', version,
    artifacts: [{ name, bytes: bytes.length, sha256 }] })}\n`;
  const signature = `${JSON.stringify({ schemaVersion: 1, algorithm: 'Ed25519', keyId,
    signature: crypto.sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') })}\n`;
  const trust = { schemaVersion: 1, keys: [{ keyId, publicKey }], revokedKeyIds: [] };
  return { bytes, name, base, manifest, signature, keyId, trust, sha256,
    update: { available: true, currentVersion: '0.1.0-beta.11', latestVersion: version,
      package: { name, size: bytes.length, url: `${base}/${name}`, checksumsUrl: `${base}/checksums.txt`,
        manifestUrl: `${base}/release-manifest.json`, signatureUrl: `${base}/release-manifest.sig` } },
    fetch: async (url) => {
      if (url.endsWith('/checksums.txt')) return new Response(`${sha256}  ${name}\n`);
      if (url.endsWith('/release-manifest.json')) return new Response(manifest);
      if (url.endsWith('/release-manifest.sig')) return new Response(signature);
      return streamedResponse([bytes]);
    },
  };
}

test('updater refuses unsigned installer downloads before requesting installer bytes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-unsigned-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = signedFixture();
  delete fixture.update.package.manifestUrl;
  delete fixture.update.package.signatureUrl;
  let requestedPackage = false;
  await assert.rejects(downloadVerifiedUpdate(fixture.update, directory, {
    trustedKeys: fixture.trust,
    fetchFn: async (url) => { if (url === `${fixture.base}/${fixture.name}`) requestedPackage = true; return fixture.fetch(url); },
  }), /signed|signature|verified package/i);
  assert.equal(requestedPackage, false);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('updater rejects forged, revoked, replayed and oversized signed metadata before installer transfer', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-forged-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const variant of ['forged', 'revoked', 'unknown-key', 'version-replay', 'oversized']) {
    const fixture = signedFixture();
    if (variant === 'revoked') fixture.trust.revokedKeyIds.push(fixture.keyId);
    if (variant === 'unknown-key') fixture.trust.keys = [];
    if (variant === 'version-replay') fixture.update.latestVersion = '0.1.0-beta.13';
    let packageRequests = 0;
    await assert.rejects(downloadVerifiedUpdate(fixture.update, directory, {
      trustedKeys: fixture.trust,
      fetchFn: async (url) => {
        if (url.endsWith('/release-manifest.json') && variant === 'forged') return new Response(fixture.manifest.replace(fixture.sha256, '0'.repeat(64)));
        if (url.endsWith('/release-manifest.json') && variant === 'oversized') return new Response('x'.repeat(131073));
        if (url === `${fixture.base}/${fixture.name}`) packageRequests += 1;
        return fixture.fetch(url);
      },
    }), undefined, variant);
    assert.equal(packageRequests, 0, variant);
    assert.deepEqual(fs.readdirSync(directory), [], variant);
  }
});

test('a trusted signed installer still streams and returns its verified signing identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-signed-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = signedFixture();
  const result = await downloadVerifiedUpdate(fixture.update, directory, { trustedKeys: fixture.trust, fetchFn: fixture.fetch });
  assert.deepEqual(fs.readFileSync(result.path), fixture.bytes);
  assert.equal(result.signingKeyId, fixture.keyId);
});

test('an installed release candidate discovers the final beta and orders candidate numbers numerically', async () => {
  const result = await checkForUpdate('0.1.0-beta.24-rc1', async () => ({ ok: true, json: async () => [{
    tag_name: '0.1.0-beta.24', draft: false,
    html_url: 'https://github.com/oliver-hitchings/Scout/releases/tag/0.1.0-beta.24', assets: [],
  }] }));
  assert.equal(result.available, true, 'the final release must be offered to an installed candidate');
  assert.equal(result.latestVersion, '0.1.0-beta.24');
  assert.equal(compareVersions('0.1.0-beta.24', '0.1.0-beta.24-rc1'), 1);
  assert.equal(compareVersions('0.1.0-beta.24-rc10', '0.1.0-beta.24-rc2'), 1);
  assert.equal(compareVersions('0.1.0-beta.25-rc1', '0.1.0-beta.24'), 1);

});
