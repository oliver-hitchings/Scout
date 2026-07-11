// Commits exactly the named files. Never throws — commit failure is non-fatal upstream.
import { spawnSync } from 'node:child_process';

export function gitCommit(repoRoot, files, message) {
  const add = spawnSync('git', ['add', '--', ...files], { cwd: repoRoot, encoding: 'utf8' });
  if (add.status !== 0) return { ok: false, error: (add.stderr || 'git add failed').trim() };
  const commit = spawnSync('git', ['commit', '-m', message], { cwd: repoRoot, encoding: 'utf8' });
  if (commit.status !== 0) {
    const out = `${commit.stdout || ''}${commit.stderr || ''}`;
    if (/nothing to commit|nothing added to commit|no changes added/i.test(out)) return { ok: true };
    return { ok: false, error: (commit.stderr || commit.stdout || 'git commit failed').trim() };
  }
  return { ok: true };
}
