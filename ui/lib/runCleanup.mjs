import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { archiveSelectedRuns, compactScanQueue, planRunCleanup, planScanQueueCleanup } from './runRetention.mjs';
import { assertPersistedRecoveryDataKey, loadRecoveryHeader, unlockRecoveryKey } from './recoveryBackup.mjs';
import { loadSyncSettings } from './workspaceSync.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from './scanLease.mjs';
import { withMutationCoordinator } from './mutationCoordinator.mjs';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');
function canonicalWorkspace(root) {
  const selected = path.resolve(root);
  if (fs.lstatSync(selected).isSymbolicLink()) throw new Error('Cleanup workspace must not be linked');
  return fs.realpathSync(selected);
}
function workspaceIdentity(root) {
  const stat = fs.lstatSync(root, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(root) !== root) throw new Error('Cleanup requires an ordinary canonical workspace directory');
  return `${stat.dev}:${stat.ino}`;
}
function reviewedDigest(value) {
  return digest({ schemaVersion: value.schemaVersion, workspaceIdentity: value.workspaceIdentity, plan: value.plan, ...(value.queue ? { queue: value.queue } : {}) });
}
function readPrivateFile(file, maximumBytes, label) {
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumBytes)
      || (process.platform !== 'win32' && ((before.mode & 0o077n) || before.uid !== BigInt(process.getuid())))) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const selected = fs.lstatSync(file, { bigint: true });
    if (size > maximumBytes || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs
      || opened.ctimeNs !== after.ctimeNs || selected.dev !== opened.dev || selected.ino !== opened.ino) throw new Error();
    return bytes.subarray(0, size);
  } catch { throw new Error(`${label} must be a protected, unchanged ordinary file within its size limit`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function privatePlanParentIdentity(parent) {
  const stat = fs.lstatSync(parent, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw new Error('Private cleanup plan parent changed');
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`;
}
function writePrivatePlan(target, bytes, parent, parentIdentity) {
  let descriptor;
  let created;
  try {
    if (privatePlanParentIdentity(parent) !== parentIdentity) throw new Error();
    descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = fs.fstatSync(descriptor, { bigint: true });
    // The create may traverse a parent replaced after validation. Verify its
    // identity again before writing any private workspace metadata.
    if (privatePlanParentIdentity(parent) !== parentIdentity) throw new Error();
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    if (privatePlanParentIdentity(parent) !== parentIdentity) throw new Error();
  } catch {
    if (created) {
      try {
        const current = fs.lstatSync(target, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(target);
      } catch { /* never remove a replacement or an existing review */ }
    }
    throw new Error('Private cleanup plan could not be safely created; no existing review was replaced');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function createRunCleanupReview(root, { selectedRunIds = [], output = null, appRoot = null, queue = false } = {}) {
  root = canonicalWorkspace(root);
  const review = { schemaVersion: 1, workspaceIdentity: workspaceIdentity(root), plan: planRunCleanup(root, { selectedRunIds }) };
  if (queue) review.queue = planScanQueueCleanup(root, { now: new Date(review.plan.generatedAt) });
  review.reviewDigest = reviewedDigest(review);
  if (review.plan.refusedSelections.length) throw new Error('Cleanup selection contains retained, recovery-critical or unknown data; review the eligible candidate list');
  if (output) {
    const selected = path.resolve(output);
    const parent = fs.realpathSync(path.dirname(selected));
    const target = path.join(parent, path.basename(selected));
    const parentIdentity = privatePlanParentIdentity(parent);
    if (appRoot && inside(fs.realpathSync(appRoot), target)) throw new Error('Keep private cleanup plans outside the application repository');
    const bytes = `${JSON.stringify(review, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES) throw new Error('Cleanup review is too large; select a smaller batch');
    writePrivatePlan(target, bytes, parent, parentIdentity);
  }
  return review;
}
export function applyRunCleanupReview(root, { file, confirm, secretFile = null } = {}) {
  root = canonicalWorkspace(root);
  const bytes = readPrivateFile(path.resolve(file), MAX_PLAN_BYTES, 'Cleanup review');
  let review;
  try { review = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Cleanup review is invalid; generate and inspect a new plan'); }
  if (review?.schemaVersion !== 1 || !review.plan || review.plan.root !== root
    || review.workspaceIdentity !== workspaceIdentity(root) || !HASH.test(String(confirm || ''))
    || confirm !== review.reviewDigest || reviewedDigest(review) !== review.reviewDigest) throw new Error('Cleanup review or confirmation changed; generate and inspect a new plan');
  let key;
  try {
    if (secretFile) {
      const secret = readPrivateFile(path.resolve(secretFile), 8192, 'Recovery secret');
      try { key = unlockRecoveryKey(loadRecoveryHeader(root), secret.toString('utf8')); }
      finally { secret.fill(0); }
    } else {
      validatePhysicalWorkspacePath(root, path.join(root, '.scout/sync.json'), 'cleanup recovery key cache');
      key = Buffer.from(String(loadSyncSettings(root).dataKey || ''), 'base64url');
    }
    if (key.length !== 32) throw new Error('Cleanup needs the existing unlocked recovery backup key, or --secret-file with its protected recovery secret');
    Object.defineProperty(review.plan, 'recoveryDataKey', { value: key, enumerable: false });
    const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'cleanup', runId: `cleanup-${crypto.randomUUID()}`, phase: 'reviewed-archive' });
    if (!lease) throw new Error('Another workspace operation is active; retry the reviewed cleanup after it finishes');
    try {
      return withMutationCoordinator(root, lease, () => {
        validatePhysicalWorkspacePath(root, path.join(root, '.scout-backup/v1/header.json'), 'cleanup recovery authority');
        assertPersistedRecoveryDataKey(root, key);
        if (!review.plan.selected?.length && !review.queue) throw new Error('Review an explicit run selection or --queue before applying cleanup');
        if (review.queue) {
          const current = planScanQueueCleanup(root, { now: new Date(review.queue.generatedAt), summaryDays: review.queue.summaryDays });
          if (current.beforeDigest !== review.queue.beforeDigest && current.beforeDigest !== review.queue.afterDigest) {
            throw new Error('Queue changed after cleanup review; generate and inspect a new plan');
          }
          if (current.beforeDigest === review.queue.beforeDigest && stable(current) !== stable(review.queue)) throw new Error('Queue cleanup plan changed after review');
        }
        const runs = review.plan.selected.length ? archiveSelectedRuns(review.plan, lease) : {};
        const queue = review.queue ? compactScanQueue(root, lease, { now: new Date(review.queue.generatedAt), summaryDays: review.queue.summaryDays, reviewedPlan: review.queue }) : null;
        return { ok: true, ...runs, ...(queue ? { queue } : {}) };
      });
    } finally { releaseScanLease(lease); }
  } finally { key?.fill(0); }
}
