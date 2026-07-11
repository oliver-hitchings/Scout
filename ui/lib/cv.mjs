import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SLUG = /^[a-z0-9-]+$/;

export function safeCvPath(repoRoot, relPath) {
  const rel = String(relPath).replace(/\\/g, '/');
  if (rel === 'cv/master-cv.md') return path.resolve(repoRoot, rel);
  const m = rel.match(/^applications\/([^/]+)\/(cv\.typ|outreach\.md)$/);
  if (m && SLUG.test(m[1])) return path.resolve(repoRoot, rel);
  throw new Error(`invalid CV path: ${relPath}`);
}

export function listCvFiles(repoRoot) {
  const appsDir = path.join(repoRoot, 'applications');
  let applications = [];
  let outreach = [];
  if (fs.existsSync(appsDir)) {
    const dirs = fs.readdirSync(appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SLUG.test(d.name))
      .map((d) => d.name)
      .sort();
    applications = dirs.filter((s) => fs.existsSync(path.join(appsDir, s, 'cv.typ')));
    outreach = dirs.filter((s) => fs.existsSync(path.join(appsDir, s, 'outreach.md')));
  }
  return { master: 'cv/master-cv.md', applications, outreach };
}

export function renderCv(repoRoot, slug) {
  const rel = `applications/${slug}/cv.typ`;
  try {
    safeCvPath(repoRoot, rel);
  } catch {
    return { ok: false, stdout: '', stderr: `invalid slug: ${slug}` };
  }
  const r = spawnSync('typst', ['compile', '--root', '.', rel],
    { cwd: repoRoot, encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    return { ok: false, stdout: '', stderr: 'typst not found on PATH. Install: winget install --id Typst.Typst -e (then reopen the terminal/app so PATH refreshes).' };
  }
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
