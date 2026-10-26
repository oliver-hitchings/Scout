import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomicWrite.mjs';
import { currentLeaseOwner, processOwnerIsLiveOrAmbiguous, withProcessDirectoryGuard } from './scanLease.mjs';

export const LEGACY_DIRECTORY_LOCK_STALE_MS = 10 * 60 * 1000;
const unavailable = () => new Error('process lock ownership is unavailable; retry after the current operation finishes');

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return `${stat.dev}:${stat.ino}`;
}

function readOwner(file) {
  let descriptor;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096n) throw unavailable();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 4096n) throw unavailable();
    const record = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink()
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || Object.keys(record || {}).sort().join(',') !== 'acquiredAt,owner,schemaVersion,token'
      || record.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(record.token || '')
      || !Number.isFinite(Date.parse(record.acquiredAt || ''))
      || !Number.isSafeInteger(record.owner?.pid) || record.owner.pid < 1
      || typeof record.owner.host !== 'string' || record.owner.host.length > 255
      || typeof record.owner.processStart !== 'string' || record.owner.processStart.length > 128) throw unavailable();
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw unavailable();
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

// The directory is durable coordination state, not the lock itself. Guarded
// metadata replacement reclaims only a proven-dead owner; age never steals a
// lock from a live or unobservable process. This also preserves PID-reuse safety.
export function acquireProcessDirectoryLock(directory) {
  directory = path.resolve(directory);
  let created = false;
  try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw unavailable(); }
  const identity = directoryIdentity(directory);
  if (!created && !fs.existsSync(path.join(directory, '.scout'))) {
    const stat = fs.lstatSync(directory);
    if (Date.now() - stat.mtimeMs < LEGACY_DIRECTORY_LOCK_STALE_MS) return null;
    // An old empty mkdir lock has no process identity. Empty-only removal can
    // never delete user data or a newly initialized owner's metadata.
    try { fs.rmdirSync(directory); }
    catch (error) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT', 'EBUSY'].includes(error.code)) return null; throw unavailable(); }
    return acquireProcessDirectoryLock(directory);
  }
  const file = path.join(directory, 'owner.json');
  const metadata = path.join(directory, '.scout');
  if (fs.existsSync(metadata)) directoryIdentity(metadata);
  const token = randomUUID();
  const owner = currentLeaseOwner();
  const guarded = (action) => {
    if (directoryIdentity(directory) !== identity) throw unavailable();
    if (fs.existsSync(metadata)) directoryIdentity(metadata);
    return withProcessDirectoryGuard(directory, () => {
      if (directoryIdentity(directory) !== identity) throw unavailable();
      const result = action();
      if (directoryIdentity(directory) !== identity) throw unavailable();
      return result;
    });
  };
  let acquired;
  try {
    acquired = guarded(() => {
      const current = readOwner(file);
      if (current && processOwnerIsLiveOrAmbiguous(current.owner)) return false;
      atomicWriteFile(file, `${JSON.stringify({ schemaVersion: 1, token, owner, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      return true;
    });
  } catch (error) { if (error.name === 'GuardBusyError') return null; throw unavailable(); }
  if (!acquired) return null;
  const assertRecord = () => {
    const record = readOwner(file);
    if (!record || record.token !== token || record.owner.pid !== owner.pid
      || record.owner.host !== owner.host || record.owner.processStart !== owner.processStart) throw unavailable();
  };
  return Object.freeze({
    assertOwned() { guarded(assertRecord); },
    release() { guarded(() => { assertRecord(); fs.unlinkSync(file); }); },
  });
}
