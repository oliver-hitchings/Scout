import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_RELEASE_METADATA_BYTES, verifyReleaseManifest } from './releaseManifest.mjs';

const RELEASES_URL = 'https://api.github.com/repos/oliver-hitchings/Scout/releases?per_page=20';
const RELEASE_URL = /^https:\/\/github\.com\/oliver-hitchings\/Scout\/releases\/(?:tag|download)\//;
const MAX_PACKAGE_BYTES = 350 * 1024 * 1024;

export function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+)(?:-rc(\d+))?)?$/);
    return match ? { core: match.slice(1, 4).map(Number), beta: match[4] === undefined ? null : Number(match[4]),
      rc: match[5] === undefined ? null : Number(match[5]) } : null;
  };
  const aa = parse(a); const bb = parse(b); if (!aa || !bb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) if (aa.core[i] !== bb.core[i]) return aa.core[i] > bb.core[i] ? 1 : -1;
  if (aa.beta !== bb.beta) {
    if (aa.beta === null) return 1;
    if (bb.beta === null) return -1;
    return aa.beta > bb.beta ? 1 : -1;
  }
  if (aa.rc === bb.rc) return 0;
  if (aa.rc === null) return 1;
  if (bb.rc === null) return -1;
  return aa.rc > bb.rc ? 1 : -1;
}

export function packageName(version, platform = process.platform, arch = process.arch, { preferPortable = false } = {}) {
  if (platform === 'win32' && arch === 'x64') return `Scout-${version}-windows-x64.exe`;
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `Scout-${version}-macos-${arch}.dmg`;
  if (platform === 'linux' && arch === 'x64') return `Scout-${version}-linux-x64.${preferPortable ? 'tar.gz' : 'deb'}`;
  return null;
}

function trustedAsset(asset, version) {
  const url = String(asset?.browser_download_url || '');
  const name = String(asset?.name || '');
  return asset && url === releaseAssetUrl(version, name) ? { name, url, size: Number(asset.size || 0) } : null;
}

function releaseAssetUrl(version, name) {
  return `https://github.com/oliver-hitchings/Scout/releases/download/v${version}/${name}`;
}

export async function checkForUpdate(currentVersion, fetchFn = globalThis.fetch, options = {}) {
  const response = await fetchFn(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': `Scout/${currentVersion}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GitHub update check failed (${response.status})`);
  const releases = await response.json();
  const candidates = (Array.isArray(releases) ? releases : []).filter((item) => !item.draft && /^v?\d+\.\d+\.\d+(?:-beta\.\d+(?:-rc\d+)?)?$/.test(item.tag_name || ''));
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = candidates[0];
  const latestVersion = latest?.tag_name?.replace(/^v/, '') || currentVersion;
  const available = Boolean(latest && compareVersions(latest.tag_name, currentVersion) > 0);
  const url = available && RELEASE_URL.test(latest.html_url || '') ? latest.html_url : null;
  const wanted = packageName(latestVersion, options.platform, options.arch, options);
  const assets = (latest?.assets || []).map((item) => trustedAsset(item, latestVersion)).filter(Boolean);
  const asset = assets.find((item) => item.name === wanted) || null;
  const checksums = assets.find((item) => item.name === 'checksums.txt') || null;
  const manifest = assets.find((item) => item.name === 'release-manifest.json') || null;
  const signature = assets.find((item) => item.name === 'release-manifest.sig') || null;
  return {
    available: Boolean(url), currentVersion, latestVersion, url,
    releaseNotes: String(latest?.body || '').slice(0, 20000),
    publishedAt: latest?.published_at || null,
    package: asset && checksums && manifest && signature
      ? { ...asset, checksumsUrl: checksums.url, manifestUrl: manifest.url, signatureUrl: signature.url } : null,
  };
}

export function parseChecksums(text) {
  const entries = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(?:\.\/)?([^/\\]+)$/);
    if (match) entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function validatePackageResponse(response, label, maxBytes) {
  if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > maxBytes) throw new Error(`${label} exceeds Scout's download limit`);
  if (!response.body) throw new Error(`${label} response has no readable body`);
}

async function* responseChunks(body) {
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value?.byteLength) yield Buffer.from(value);
      }
    } finally { reader.releaseLock(); }
    return;
  }
  if (body[Symbol.asyncIterator]) {
    for await (const chunk of body) if (chunk?.length) yield Buffer.from(chunk);
    return;
  }
  throw new Error('Update package response is not streamable');
}

async function metadataBytes(response, label) {
  if (!response?.ok) throw new Error(`${label} download failed`);
  const chunks = [];
  let bytes = 0;
  // A real fetch always supplies a stream. The text fallback supports existing
  // injected transports while retaining the same validation boundary.
  const stream = response.body ? responseChunks(response.body) : [Buffer.from(await response.text())];
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_RELEASE_METADATA_BYTES) throw new Error(`${label} exceeds its signed metadata limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeComplete(fileSystem, descriptor, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const written = fileSystem.writeSync(descriptor, chunk, offset, chunk.length - offset);
    if (!written) throw new Error('Update package could not be written completely');
    offset += written;
  }
}

export async function downloadVerifiedUpdate(update, directory, {
  fetchFn = globalThis.fetch,
  fileSystem = fs,
  maxPackageBytes = MAX_PACKAGE_BYTES,
  trustedKeys,
} = {}) {
  const pkg = update?.package;
  if (!update?.available || !pkg || !RELEASE_URL.test(pkg.url || '') || !RELEASE_URL.test(pkg.checksumsUrl || '')) {
    throw new Error('No verified package is available for this device');
  }
  if (path.basename(pkg.name) !== pkg.name || !/^Scout-[0-9A-Za-z.-]+-(?:windows-x64\.exe|macos-(?:arm64|x64)\.dmg|linux-x64\.(?:deb|tar\.gz))$/.test(pkg.name)) {
    throw new Error('The release package name is invalid');
  }
  for (const [key, name] of [['url', pkg.name], ['checksumsUrl', 'checksums.txt'],
    ['manifestUrl', 'release-manifest.json'], ['signatureUrl', 'release-manifest.sig']]) {
    if (pkg[key] !== releaseAssetUrl(update.latestVersion, name)) throw new Error('No signed verified package is available for this release');
  }
  if (Number(pkg.size || 0) > maxPackageBytes) throw new Error("Update package exceeds Scout's download limit");
  const headers = { 'user-agent': `Scout/${update.currentVersion}`, accept: 'application/octet-stream' };
  const [checksumResponse, manifestResponse, signatureResponse] = await Promise.all([
    fetchFn(pkg.checksumsUrl, { headers, signal: AbortSignal.timeout(30000) }),
    fetchFn(pkg.manifestUrl, { headers, signal: AbortSignal.timeout(30000) }),
    fetchFn(pkg.signatureUrl, { headers, signal: AbortSignal.timeout(30000) }),
  ]);
  const [checksums, manifest, signature] = await Promise.all([
    metadataBytes(checksumResponse, 'Checksum manifest'), metadataBytes(manifestResponse, 'Release manifest'),
    metadataBytes(signatureResponse, 'Release signature'),
  ]);
  const verified = verifyReleaseManifest(manifest, signature, { expectedVersion: update.latestVersion, trustedKeys });
  const artifact = verified.manifest.artifacts.find((item) => item.name === pkg.name);
  const expected = parseChecksums(checksums.toString('utf8')).get(pkg.name);
  if (!expected) throw new Error('The package is missing from checksums.txt');
  if (!artifact || artifact.sha256 !== expected || (Number(pkg.size || 0) && pkg.size !== artifact.bytes)) {
    throw new Error('Package checksum or size disagrees with its signed manifest');
  }
  if (artifact.bytes > maxPackageBytes) throw new Error("Update package exceeds Scout's download limit");
  const packageResponse = await fetchFn(pkg.url, { headers, signal: AbortSignal.timeout(120000) });
  validatePackageResponse(packageResponse, 'Update package', maxPackageBytes);
  fileSystem.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, pkg.name);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.part`;
  const hash = crypto.createHash('sha256');
  let descriptor;
  let byteLength = 0;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
    for await (const chunk of responseChunks(packageResponse.body)) {
      byteLength += chunk.length;
      if (byteLength > maxPackageBytes) throw new Error("Update package exceeds Scout's download limit");
      hash.update(chunk);
      writeComplete(fileSystem, descriptor, chunk);
    }
    if (!byteLength || byteLength !== artifact.bytes) throw new Error('Update package has an invalid signed size');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    const actual = hash.digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Update checksum verification failed');
    fileSystem.renameSync(temporary, target);
    return { path: target, name: pkg.name, sha256: actual, signingKeyId: verified.signingKeyId,
      version: update.latestVersion, verifiedAt: new Date().toISOString() };
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    fileSystem.rmSync(temporary, { force: true });
  }
}

export function publicIsoTimestamp(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) return null;
  const milliseconds = Date.parse(text);
  return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
}

export function publicUpdateLocationHint(name, {
  env = process.env, platform = process.platform,
} = {}) {
  const packageName = String(name || '');
  if (!/^Scout-\d+\.\d+\.\d+(?:-beta\.\d+(?:-rc\d+)?)?-(?:windows-x64\.exe|macos-(?:arm64|x64)\.dmg|linux-x64\.(?:deb|tar\.gz))$/.test(packageName)) return null;
  if (env.SCOUT_DEVICE_SETTINGS) {
    return platform === 'win32'
      ? 'the updates folder beside %SCOUT_DEVICE_SETTINGS%'
      : 'the updates folder beside $SCOUT_DEVICE_SETTINGS';
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ? '%LOCALAPPDATA%' : '%USERPROFILE%\\AppData\\Local';
    return `${base}\\Scout\\updates\\${packageName}`;
  }
  if (env.XDG_CONFIG_HOME) return `$XDG_CONFIG_HOME/Scout/updates/${packageName}`;
  return `~/.config/Scout/updates/${packageName}`;
}

export function publicDownloadedUpdate(downloaded, options = {}) {
  if (!downloaded || typeof downloaded !== 'object') return null;
  const name = String(downloaded.name || '');
  const sha256 = String(downloaded.sha256 || '');
  const version = String(downloaded.version || '');
  const verifiedAt = publicIsoTimestamp(downloaded.verifiedAt);
  const safeVersion = /^\d+\.\d+\.\d+(?:-beta\.\d+(?:-rc\d+)?)?$/.test(version);
  const expectedName = safeVersion
    ? new RegExp(`^Scout-${version.replaceAll('.', '\\.')}-(?:windows-x64\\.exe|macos-(?:arm64|x64)\\.dmg|linux-x64\\.(?:deb|tar\\.gz))$`)
    : null;
  if (!expectedName?.test(name)
      || path.basename(name) !== name
      || !/^[a-f0-9]{64}$/i.test(sha256)
      || !verifiedAt) return null;
  return {
    name, sha256, version, verifiedAt,
    locationHint: publicUpdateLocationHint(name, options),
  };
}
