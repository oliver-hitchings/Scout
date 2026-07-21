import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTypstRuntime } from './typstRuntime.mjs';

const SLUG = /^[a-z0-9-]+$/;
const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  const entries = applications.map((slug) => {
    const directory = path.join(appsDir, slug);
    return {
      slug,
      source: true,
      pdf: fs.existsSync(path.join(directory, 'cv.pdf')),
      outreach: fs.existsSync(path.join(directory, 'outreach.md')),
      evidence: fs.existsSync(path.join(directory, 'cv-evidence.json')),
      quality: fs.existsSync(path.join(directory, 'cv-quality.json')),
    };
  });
  return { master: 'cv/master-cv.md', applications, outreach, entries };
}

export function renderCv(repoRoot, slug, {
  appRoot = DEFAULT_APP_ROOT,
  runtimeResolver = resolveTypstRuntime,
  spawn = spawnSync,
} = {}) {
  const rel = `applications/${slug}/cv.typ`;
  try {
    safeCvPath(repoRoot, rel);
  } catch {
    return { ok: false, stdout: '', stderr: `invalid slug: ${slug}` };
  }
  const runtime = runtimeResolver({ appRoot });
  if (!runtime.available) return { ok: false, stdout: '', stderr: runtime.error, runtime };
  const r = spawn(runtime.command, ['compile', '--root', '.', rel],
    { cwd: repoRoot, encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    return { ok: false, stdout: '', stderr: 'Scout\'s Typst runtime disappeared while rendering. Repair or reinstall Scout.', runtime };
  }
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), runtime };
}
