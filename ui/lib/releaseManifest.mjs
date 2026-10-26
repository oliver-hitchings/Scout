import crypto from 'node:crypto';
import fs from 'node:fs';

export const MAX_RELEASE_METADATA_BYTES = 128 * 1024;
export const MAX_RELEASE_ARTIFACT_BYTES = 350 * 1024 * 1024;
const REPOSITORY = 'oliver-hitchings/Scout';
const VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+(?:-rc\d+)?)?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ARTIFACT = /^Scout-[0-9A-Za-z.-]+-(?:windows-x64\.exe|macos-(?:arm64|x64)\.dmg|linux-x64\.(?:deb|tar\.gz))$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedJson(bytes, label) {
  const input = Buffer.from(bytes);
  if (!input.length || input.length > MAX_RELEASE_METADATA_BYTES) throw new Error(`${label} exceeds its signed metadata limit`);
  try { return JSON.parse(input.toString('utf8')); }
  catch { throw new Error(`${label} is invalid`); }
}

export function signingKeyId(publicKey) {
  const key = typeof publicKey === 'object' && publicKey?.type === 'public'
    ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release signing requires an Ed25519 key');
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

export function validateReleaseManifest(manifest, expectedVersion) {
  if (!exactKeys(manifest, ['schemaVersion', 'repository', 'version', 'artifacts'])
    || manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY
    || !VERSION.test(manifest.version) || (expectedVersion && manifest.version !== expectedVersion)
    || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 32) {
    throw new Error('Signed release manifest has an invalid version or schema');
  }
  let previous = '';
  for (const artifact of manifest.artifacts) {
    if (!exactKeys(artifact, ['name', 'bytes', 'sha256']) || !ARTIFACT.test(artifact.name)
      || !artifact.name.startsWith(`Scout-${manifest.version}-`) || artifact.name <= previous
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_RELEASE_ARTIFACT_BYTES
      || !DIGEST.test(artifact.sha256)) throw new Error('Signed release artifact is invalid or duplicated');
    previous = artifact.name;
  }
  return manifest;
}

export function encodeReleaseManifest(manifest) {
  validateReleaseManifest(manifest);
  // One fixed serialization makes the signed bytes inspectable and rejects
  // duplicate JSON keys, alternate encodings and unsigned extensions.
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, version: manifest.version,
    artifacts: manifest.artifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) })}\n`);
}

export function bundledReleaseTrust() {
  return JSON.parse(fs.readFileSync(new URL('./releaseKeys.json', import.meta.url), 'utf8'));
}

export function verifyReleaseManifest(manifestBytes, signatureBytes, {
  expectedVersion, trustedKeys = bundledReleaseTrust(),
} = {}) {
  const signature = boundedJson(signatureBytes, 'Release signature');
  if (!exactKeys(signature, ['schemaVersion', 'algorithm', 'keyId', 'signature'])
    || signature.schemaVersion !== 1 || signature.algorithm !== 'Ed25519'
    || !DIGEST.test(signature.keyId) || !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature)) {
    throw new Error('Release signature is invalid');
  }
  if (!exactKeys(trustedKeys, ['schemaVersion', 'keys', 'revokedKeyIds']) || trustedKeys.schemaVersion !== 1
    || !Array.isArray(trustedKeys.keys) || trustedKeys.keys.length > 32
    || !Array.isArray(trustedKeys.revokedKeyIds) || trustedKeys.revokedKeyIds.length > 256
    || trustedKeys.revokedKeyIds.some((id) => !DIGEST.test(id))) throw new Error('Release signing trust is invalid');
  if (trustedKeys.revokedKeyIds.includes(signature.keyId)) throw new Error('Release signing key has been revoked');
  const matches = trustedKeys.keys.filter((key) => key.keyId === signature.keyId);
  if (matches.length !== 1) throw new Error('No trusted release signing key is configured for this signature');
  const key = matches[0];
  if (!exactKeys(key, ['keyId', 'publicKey']) || typeof key.publicKey !== 'string'
    || key.publicKey.length > 2048 || signingKeyId(key.publicKey) !== key.keyId) throw new Error('Release signing trust is invalid');
  const manifest = validateReleaseManifest(boundedJson(manifestBytes, 'Release manifest'), expectedVersion);
  const encoded = encodeReleaseManifest(manifest);
  if (!encoded.equals(Buffer.from(manifestBytes))
    || !crypto.verify(null, encoded, key.publicKey, Buffer.from(signature.signature, 'base64'))) {
    throw new Error('Release signature verification failed');
  }
  return { manifest, signingKeyId: signature.keyId };
}
