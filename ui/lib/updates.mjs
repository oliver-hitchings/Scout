const RELEASES_URL = 'https://api.github.com/repos/oliver-hitchings/Scout/releases?per_page=20';

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

export async function checkForUpdate(currentVersion, fetchFn = globalThis.fetch) {
  const response = await fetchFn(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': `Scout/${currentVersion}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GitHub update check failed (${response.status})`);
  const releases = await response.json();
  const candidates = (Array.isArray(releases) ? releases : []).filter((item) => !item.draft && /^v?\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(item.tag_name || ''));
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = candidates[0];
  const available = Boolean(latest && compareVersions(latest.tag_name, currentVersion) > 0);
  const url = available && /^https:\/\/github\.com\/oliver-hitchings\/Scout\/releases\//.test(latest.html_url || '') ? latest.html_url : null;
  return { available: Boolean(url), currentVersion, latestVersion: latest?.tag_name?.replace(/^v/, '') || currentVersion, url };
}
