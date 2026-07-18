import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELEASES_URL = 'https://api.github.com/repos/oliver-hitchings/Scout/releases?per_page=20';
const RELEASE_URL = /^https:\/\/github\.com\/oliver-hitchings\/Scout\/releases\/(?:tag|download)\//;
const MAX_PACKAGE_BYTES = 350 * 1024 * 1024;

export function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
    return match ? { core: match.slice(1, 4).map(Number), beta: match[4] === undefined ? null : Number(match[4]) } : null;
  };
  const aa = parse(a); const bb = parse(b); if (!aa || !bb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) if (aa.core[i] !== bb.core[i]) return aa.core[i] > bb.core[i] ? 1 : -1;
  if (aa.beta === bb.beta) return 0;
  if (aa.beta === null) return 1;
  if (bb.beta === null) return -1;
  return aa.beta > bb.beta ? 1 : -1;
}

export function packageName(version, platform = process.platform, arch = process.arch, { preferPortable = false } = {}) {
  if (platform === 'win32' && arch === 'x64') return `Scout-${version}-windows-x64.exe`;
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `Scout-${version}-macos-${arch}.dmg`;
  if (platform === 'linux' && arch === 'x64') return `Scout-${version}-linux-x64.${preferPortable ? 'tar.gz' : 'deb'}`;
  return null;
}

function trustedAsset(asset) {
  const url = String(asset?.browser_download_url || '');
  return asset && RELEASE_URL.test(url) ? { name: String(asset.name || ''), url, size: Number(asset.size || 0) } : null;
}

export async function checkForUpdate(currentVersion, fetchFn = globalThis.fetch, options = {}) {
  const response = await fetchFn(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': `Scout/${currentVersion}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GitHub update check failed (${response.status})`);
  const releases = await response.json();
  const candidates = (Array.isArray(releases) ? releases : []).filter((item) => !item.draft && /^v?\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(item.tag_name || ''));
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = candidates[0];
  const latestVersion = latest?.tag_name?.replace(/^v/, '') || currentVersion;
  const available = Boolean(latest && compareVersions(latest.tag_name, currentVersion) > 0);
  const url = available && RELEASE_URL.test(latest.html_url || '') ? latest.html_url : null;
  const wanted = packageName(latestVersion, options.platform, options.arch, options);
  const assets = (latest?.assets || []).map(trustedAsset).filter(Boolean);
  const asset = assets.find((item) => item.name === wanted) || null;
  const checksums = assets.find((item) => item.name === 'checksums.txt') || null;
  return {
    available: Boolean(url), currentVersion, latestVersion, url,
    releaseNotes: String(latest?.body || '').slice(0, 20000),
    publishedAt: latest?.published_at || null,
    package: asset && checksums ? { ...asset, checksumsUrl: checksums.url } : null,
  };
}

export function parseChecksums(text) {
  const entries = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?([^/\\]+)$/);
    if (match) entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

async function responseBytes(response, label) {
  if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_PACKAGE_BYTES) throw new Error(`${label} exceeds Scout's download limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES) throw new Error(`${label} has an invalid size`);
  return bytes;
}

export async function downloadVerifiedUpdate(update, directory, { fetchFn = globalThis.fetch, fileSystem = fs } = {}) {
  const pkg = update?.package;
  if (!update?.available || !pkg || !RELEASE_URL.test(pkg.url || '') || !RELEASE_URL.test(pkg.checksumsUrl || '')) {
    throw new Error('No verified package is available for this device');
  }
  if (path.basename(pkg.name) !== pkg.name || !/^Scout-[0-9A-Za-z.-]+-(?:windows-x64\.exe|macos-(?:arm64|x64)\.dmg|linux-x64\.(?:deb|tar\.gz))$/.test(pkg.name)) {
    throw new Error('The release package name is invalid');
  }
  const headers = { 'user-agent': `Scout/${update.currentVersion}`, accept: 'application/octet-stream' };
  const [manifestResponse, packageResponse] = await Promise.all([
    fetchFn(pkg.checksumsUrl, { headers, signal: AbortSignal.timeout(30000) }),
    fetchFn(pkg.url, { headers, signal: AbortSignal.timeout(120000) }),
  ]);
  if (!manifestResponse.ok) throw new Error(`Checksum download failed (${manifestResponse.status})`);
  const manifest = await manifestResponse.text();
  if (manifest.length > 100000) throw new Error('Checksum manifest is unexpectedly large');
  const expected = parseChecksums(manifest).get(pkg.name);
  if (!expected) throw new Error('The package is missing from checksums.txt');
  const bytes = await responseBytes(packageResponse, 'Update package');
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Update checksum verification failed');
  fileSystem.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, pkg.name);
  const temporary = `${target}.${process.pid}.part`;
  try {
    fileSystem.writeFileSync(temporary, bytes, { mode: 0o600 });
    fileSystem.renameSync(temporary, target);
  } finally { fileSystem.rmSync(temporary, { force: true }); }
  return { path: target, name: pkg.name, sha256: actual, version: update.latestVersion, verifiedAt: new Date().toISOString() };
}
