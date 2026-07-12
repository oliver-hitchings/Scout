import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import { resolveWorkspaceRoot } from '../ui/lib/workspace.mjs';

export const LOCK_FILE = '.scout-scan.lock';
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function scanLockPath(repoRoot) {
  return path.join(repoRoot, LOCK_FILE);
}

export function readScanLock(repoRoot) {
  const file = scanLockPath(repoRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { invalid: true };
  }
}

function lockAge(lock, now) {
  const started = Date.parse(lock?.startedAt || '');
  return Number.isFinite(started) ? now.getTime() - started : Infinity;
}

export function acquireScanLock(repoRoot, {
  agent,
  mode,
  now = new Date(),
  staleAfterMs = STALE_AFTER_MS,
  token = crypto.randomUUID(),
} = {}) {
  if (!agent || !mode) throw new Error('agent and mode are required');
  const file = scanLockPath(repoRoot);
  const record = { agent, mode, token, startedAt: now.toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); }
      finally { fs.closeSync(fd); }
      return { ok: true, lock: record, recoveredStale: attempt === 1 };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readScanLock(repoRoot);
      if (attempt === 0 && lockAge(current, now) >= staleAfterMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
      return { ok: false, reason: 'active', lock: current };
    }
  }
  return { ok: false, reason: 'active', lock: readScanLock(repoRoot) };
}

export function releaseScanLock(repoRoot, token) {
  const file = scanLockPath(repoRoot);
  const current = readScanLock(repoRoot);
  if (!current) return { ok: true, released: false };
  if (!token || current.token !== token) return { ok: false, reason: 'token-mismatch', lock: current };
  fs.rmSync(file, { force: true });
  return { ok: true, released: true };
}

function cli() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolveWorkspaceRoot({ appRoot });
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'acquire') result = acquireScanLock(repoRoot, { agent: args[0], mode: args[1] });
  else if (command === 'release') result = releaseScanLock(repoRoot, args[0]);
  else if (command === 'status') result = { ok: true, lock: readScanLock(repoRoot) };
  else throw new Error('usage: scan-lock.mjs acquire <agent> <mode> | release <token> | status');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const isMain = isMainModule(import.meta.url);
if (isMain) cli();
