#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import { encodeReleaseManifest, MAX_RELEASE_METADATA_BYTES, signingKeyId, verifyReleaseManifest } from '../ui/lib/releaseManifest.mjs';

function readSmallRegularFile(file, maximum = MAX_RELEASE_METADATA_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('Signing input must be a bounded regular file');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw new Error('Signing input changed');
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > maximum) throw new Error('Signing input exceeds limit');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

async function artifactRecord(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Release artifact must be a regular file');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Release artifact changed');
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file, { fd: descriptor, autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const final = fs.lstatSync(file, { bigint: true });
    for (const current of [after, final]) {
      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => current[key] !== before[key])) throw new Error('Release artifact changed while hashing');
    }
    if (BigInt(bytes) !== before.size) throw new Error('Release artifact size changed');
    return { name: path.basename(file), bytes, sha256: hash.digest('hex') };
  } finally { fs.closeSync(descriptor); }
}

export async function signRelease({ directory, version, keyFile }) {
  const privateKey = crypto.createPrivateKey(readSmallRegularFile(keyFile, 16384));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing requires Ed25519');
  const publicKey = crypto.createPublicKey(privateKey);
  const keyId = signingKeyId(publicKey);
  const names = fs.readdirSync(directory).filter((name) => name.startsWith('Scout-')).sort();
  const artifacts = [];
  for (const name of names) artifacts.push(await artifactRecord(path.join(directory, name)));
  const manifest = encodeReleaseManifest({ schemaVersion: 1, repository: 'oliver-hitchings/Scout', version, artifacts });
  const signature = Buffer.from(`${JSON.stringify({ schemaVersion: 1, algorithm: 'Ed25519', keyId,
    signature: crypto.sign(null, manifest, privateKey).toString('base64') })}\n`);
  verifyReleaseManifest(manifest, signature, { expectedVersion: version, trustedKeys: {
    schemaVersion: 1, keys: [{ keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }], revokedKeyIds: [],
  } });
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), manifest, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'release-manifest.sig'), signature, { flag: 'wx' });
  return { artifactCount: artifacts.length, keyId };
}

export async function verifyInstaller({ packageFile, manifestFile, signatureFile, version, trustFile }) {
  const verified = verifyReleaseManifest(readSmallRegularFile(manifestFile), readSmallRegularFile(signatureFile), {
    expectedVersion: version, ...(trustFile ? { trustedKeys: JSON.parse(readSmallRegularFile(trustFile).toString('utf8')) } : {}),
  });
  const actual = await artifactRecord(packageFile);
  const expected = verified.manifest.artifacts.find(({ name }) => name === actual.name);
  if (!expected || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) throw new Error('Installer SHA-256 or size verification failed');
  return { name: actual.name, signingKeyId: verified.signingKeyId, sha256: actual.sha256 };
}

if (isMainModule(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!/^--[a-z-]+$/.test(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) throw new Error('Invalid arguments');
      options[args[index]] = args[index + 1];
    }
    if (command === 'sign' && Object.keys(options).sort().join() === '--directory,--key-file,--version') {
      const result = await signRelease({ directory: options['--directory'], keyFile: options['--key-file'], version: options['--version'] });
      process.stdout.write(`Signed ${result.artifactCount} release artifacts.\n`);
    } else if (command === 'verify' && ['--package', '--manifest', '--signature', '--version'].every((key) => options[key])
      && Object.keys(options).every((key) => ['--package', '--manifest', '--signature', '--version', '--trust-file'].includes(key))) {
      await verifyInstaller({ packageFile: options['--package'], manifestFile: options['--manifest'], signatureFile: options['--signature'],
        version: options['--version'], trustFile: options['--trust-file'] });
      process.stdout.write('Verified installer signature, size and SHA-256.\n');
    } else throw new Error('Invalid arguments');
  } catch {
    // Neither private key material nor operator paths enter logs.
    process.stderr.write('Release signing or installer verification failed. Check trusted key, version and artifact integrity.\n');
    process.exitCode = 1;
  }
}
