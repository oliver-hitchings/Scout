import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { seedWorkspace } from '../ui/lib/workspace.mjs';
import { initializeRecoveryBackup, verifyReviewedRunArchive } from '../ui/lib/recoveryBackup.mjs';
import { saveSyncSettings } from '../ui/lib/workspaceSync.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from '../ui/lib/scanLease.mjs';
const app = fileURLToPath(new URL('../', import.meta.url));
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const hash = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex');
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cleanup-cli-'));
  const root = path.join(parent, 'workspace');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  seedWorkspace(app, root);
  for (let i = 0; i < 22; i++) {
    const runId = `synthetic-run-${String(i).padStart(2, '0')}`;
    const directory = path.join(root, '.scout/runs', runId);
    fs.mkdirSync(path.join(directory, 'artifacts'), { recursive: true });
    const payload = { schemaVersion: 1, outcome: 'complete' };
    const event = { schemaVersion: 1, runId, sequence: 1, eventId: crypto.randomUUID(), type: 'run.completed', recordedAt: `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, leaseId: 'synthetic-retention', fencingGeneration: 1, stageId: 'finalise', idempotencyKey: `complete-${runId}`, previousHash: null, payloadHash: hash(payload), payload };
    event.eventHash = hash(event);
    fs.writeFileSync(path.join(directory, 'journal.jsonl'), `${stable(event)}\n`);
    fs.writeFileSync(path.join(directory, 'artifacts/result.json'), 'Synthetic retained diagnostic.');
  }
  const key = initializeRecoveryBackup(root, crypto.randomBytes(24).toString('hex'));
  saveSyncSettings(root, { enabled: true, dataKey: key.dataKey.toString('base64url') });
  const env = { ...process.env, SCOUT_WORKSPACE: root, SCOUT_HOUSEHOLD_SETTINGS: path.join(parent, 'household.json'), SCOUT_DEVICE_SETTINGS: path.join(parent, 'device.json') };
  const cli = (...args) => spawnSync(process.execPath, [path.join(app, 'tools/scout.mjs'), 'cleanup', '--workspace', root, ...args], { env, cwd: app, encoding: 'utf8', timeout: 30000 });
  return { root, parent, cli, key, env };
}
test('actual cleanup CLI lists, reviews and archives only an explicit old selection', (t) => {
  const { root, parent, cli, key } = fixture(t);
  const listing = cli('--plan');
  assert.equal(listing.status, 0, listing.stderr);
  const candidates = JSON.parse(listing.stdout);
  assert.equal(candidates.plan.candidates.length, 2);
  assert.equal(candidates.plan.selected.length, 0);
  const output = path.join(parent, 'reviewed-plan.json');
  const planned = cli('--plan', '--select', 'synthetic-run-00', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const reviewed = JSON.parse(planned.stdout);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), true);
  const applied = cli('--apply', output, '--confirm', reviewed.reviewDigest);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.archivedRuns, 1);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), false);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-01')), true);
  const archive = verifyReviewedRunArchive(result.archiveFile, key.dataKey);
  assert.equal(archive.runs[0].runId, 'synthetic-run-00');
  const replay = cli('--apply', output, '--confirm', reviewed.reviewDigest);
  assert.equal(replay.status, 0, replay.stderr);
});
test('actual cleanup CLI refuses altered content, wrong confirmation and a live foreign lease', (t) => {
  const { root, parent, cli } = fixture(t);
  const output = path.join(parent, 'reviewed-plan.json');
  const planned = cli('--plan', '--select', 'synthetic-run-00', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const reviewed = JSON.parse(planned.stdout);
  assert.notEqual(cli('--apply', output, '--confirm', 'a'.repeat(64)).status, 0);
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'live-synthetic-scan' });
  assert.ok(lease);
  try { assert.notEqual(cli('--apply', output, '--confirm', reviewed.reviewDigest).status, 0); }
  finally { releaseScanLease(lease); }
  const artifact = path.join(root, '.scout/runs/synthetic-run-00/artifacts/result.json');
  fs.writeFileSync(artifact, 'Synthetic diagnostic changed after review.');
  const changed = cli('--apply', output, '--confirm', reviewed.reviewDigest);
  assert.notEqual(changed.status, 0);
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'Synthetic diagnostic changed after review.');
});

test('actual cleanup CLI resumes a verified encrypted archive after a partial deletion', async (t) => {
  const { archiveSelectedRuns } = await import('../ui/lib/runRetention.mjs');
  const { root, parent, cli, key } = fixture(t);
  const output = path.join(parent, 'reviewed-plan.json');
  const planned = cli('--plan', '--select', 'synthetic-run-00,synthetic-run-01', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const review = JSON.parse(planned.stdout);
  Object.defineProperty(review.plan, 'recoveryDataKey', { value: key.dataKey, enumerable: false });
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'cleanup', runId: 'synthetic-interrupted-cleanup' });
  try { assert.throws(() => archiveSelectedRuns(review.plan, lease, { afterSourceDelete() { throw new Error('Synthetic interruption'); } }), /Synthetic interruption/); }
  finally { releaseScanLease(lease); }
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), false);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-01')), true);
  const resumed = cli('--apply', output, '--confirm', review.reviewDigest);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).archivedRuns, 2);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-01')), false);
});

test('actual cleanup CLI fails closed on changed queue authority and absent key cache', async (t) => {
  const { enqueueScanRequest } = await import('../ui/lib/scanQueue.mjs');
  const { root, parent, cli } = fixture(t);
  const output = path.join(parent, 'reviewed-plan.json');
  const planned = cli('--plan', '--select', 'synthetic-run-00', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const review = JSON.parse(planned.stdout);
  const requestedAt = new Date().toISOString();
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'synthetic-queue-change' });
  try {
    enqueueScanRequest(root, {
      id: 'synthetic-queued-request', key: 'synthetic-request', requester: 'manual', purpose: 'job-discovery',
      requestedAt, expiresAt: new Date(Date.parse(requestedAt) + 86400000).toISOString(), windowAt: null,
      compatibility: { schemaVersion: 1, profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) }, lease,
    });
  } finally { releaseScanLease(lease); }
  const stale = cli('--apply', output, '--confirm', review.reviewDigest);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /recovery-critical durable state changed/);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), true);
  fs.rmSync(path.join(root, '.scout/sync.json'));
  const missing = cli('--apply', output, '--confirm', review.reviewDigest);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /existing unlocked recovery/);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), true);
});

test('actual cleanup CLI separately reviews queue compaction and preserves recent/live requests', async (t) => {
  const { enqueueScanRequest, projectScanQueue } = await import('../ui/lib/scanQueue.mjs');
  const { root, parent, cli } = fixture(t);
  const currentRequest = new Date().toISOString();
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'synthetic-queue-review' });
  try {
    for (const [id, requestedAt, expiresAt] of [
      ['synthetic-expired', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z'],
      ['synthetic-live', currentRequest, new Date(Date.parse(currentRequest) + 86400000).toISOString()],
    ]) enqueueScanRequest(root, { id, key: id, requester: 'manual', purpose: 'job-discovery', requestedAt, expiresAt, windowAt: null,
      compatibility: { schemaVersion: 1, profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) }, lease });
  } finally { releaseScanLease(lease); }
  const output = path.join(parent, 'queue-review.json');
  const planned = cli('--plan', '--queue', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const review = JSON.parse(planned.stdout);
  assert.equal(review.queue.removedEvents, 1);
  const result = cli('--apply', output, '--confirm', review.reviewDigest);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).queue.removedEvents, 1);
  assert.deepEqual(projectScanQueue(root).requests.map((item) => item.id), ['synthetic-live']);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), true);
});

test('queue-only cleanup requires the existing persisted recovery key before any compaction', async (t) => {
  const { enqueueScanRequest, projectScanQueue } = await import('../ui/lib/scanQueue.mjs');
  const { root, parent, cli } = fixture(t);
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'synthetic-key-check' });
  try { enqueueScanRequest(root, { id: 'synthetic-old-queue', key: 'synthetic-old-queue', requester: 'manual', purpose: 'job-discovery',
    requestedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z', windowAt: null,
    compatibility: { schemaVersion: 1, profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) }, lease }); }
  finally { releaseScanLease(lease); }
  const output = path.join(parent, 'queue-key-review.json');
  const planned = cli('--plan', '--queue', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const review = JSON.parse(planned.stdout);
  saveSyncSettings(root, { enabled: true, dataKey: crypto.randomBytes(32).toString('base64url') });
  const applied = cli('--apply', output, '--confirm', review.reviewDigest);
  assert.notEqual(applied.status, 0);
  assert.deepEqual(projectScanQueue(root).requests.map((item) => item.id), ['synthetic-old-queue']);
});

test('actual cleanup CLI unlocks with a protected existing recovery secret without exposing it', (t) => {
  const { root, parent, cli, key } = fixture(t);
  const output = path.join(parent, 'secret-review.json');
  const planned = cli('--plan', '--select', 'synthetic-run-00', '--output', output);
  assert.equal(planned.status, 0, planned.stderr);
  const review = JSON.parse(planned.stdout);
  const original = fs.readFileSync(output);
  assert.notEqual(cli('--plan', '--select', 'synthetic-run-01', '--output', output).status, 0, 'a new plan never overwrites another review');
  assert.deepEqual(fs.readFileSync(output), original);
  fs.rmSync(path.join(root, '.scout/sync.json'));
  const secret = path.join(parent, 'recovery-secret');
  fs.writeFileSync(secret, key.recoveryKey, { mode: 0o600 });
  const applied = cli('--apply', output, '--confirm', review.reviewDigest, '--secret-file', secret);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.existsSync(path.join(root, '.scout/runs/synthetic-run-00')), false);
  assert.equal(`${applied.stdout}${applied.stderr}${planned.stdout}`.includes(key.recoveryKey), false);
});

test('cleanup plan publication uses the canonical checked parent after an alias retarget', async (t) => {
  const { createRunCleanupReview } = await import('../ui/lib/runCleanup.mjs');
  const { root, parent } = fixture(t);
  const privateDirectory = path.join(parent, 'private-plans');
  const publicApp = path.join(parent, 'synthetic-public-app');
  const alias = path.join(parent, 'plan-alias');
  fs.mkdirSync(privateDirectory);
  fs.mkdirSync(publicApp);
  fs.symlinkSync(privateDirectory, alias, 'junction');
  const realpath = fs.realpathSync;
  let retargeted = false;
  const replacement = (file, ...options) => {
    const canonical = realpath(file, ...options);
    if (!retargeted && String(file) === alias) {
      retargeted = true;
      fs.rmSync(alias, { recursive: true, force: true });
      fs.symlinkSync(publicApp, alias, 'junction');
    }
    return canonical;
  };
  replacement.native = realpath.native;
  fs.realpathSync = replacement;
  t.after(() => { fs.realpathSync = realpath; });
  createRunCleanupReview(root, { appRoot: publicApp, output: path.join(alias, 'review.json') });
  fs.realpathSync = realpath;
  assert.equal(retargeted, true);
  assert.equal(fs.existsSync(path.join(publicApp, 'review.json')), false, 'private workspace paths must not be written into the application');
  assert.equal(fs.existsSync(path.join(privateDirectory, 'review.json')), true);
});

test('cleanup plan creation detects a substituted canonical parent before writing private bytes', async (t) => {
  const { createRunCleanupReview } = await import('../ui/lib/runCleanup.mjs');
  const { root, parent } = fixture(t);
  const directory = path.join(parent, 'private-plan-parent');
  const displaced = path.join(parent, 'displaced-plan-parent');
  fs.mkdirSync(directory);
  const output = path.join(directory, 'review.json');
  const open = fs.openSync;
  let replaced = false;
  fs.openSync = (file, ...options) => {
    if (!replaced && String(file) === output) {
      replaced = true;
      fs.renameSync(directory, displaced);
      fs.mkdirSync(directory);
    }
    return open(file, ...options);
  };
  t.after(() => { fs.openSync = open; });
  assert.throws(() => createRunCleanupReview(root, { output }), /could not be safely created/);
  fs.openSync = open;
  assert.equal(replaced, true);
  assert.deepEqual(fs.readdirSync(displaced), []);
  assert.deepEqual(fs.readdirSync(directory), [], 'the exact newly created empty file is cleaned up');
});

test('reviewed queue apply refuses a legitimate overlapping enqueue after its caller precheck', async (t) => {
  const { enqueueScanRequest, projectScanQueue } = await import('../ui/lib/scanQueue.mjs');
  const { root, parent, cli, env } = fixture(t);
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'synthetic-queue-race' });
  try { enqueueScanRequest(root, { id: 'synthetic-expired-review', key: 'synthetic-expired-review', requester: 'manual', purpose: 'job-discovery',
    requestedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z', windowAt: null,
    compatibility: { schemaVersion: 1, profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) }, lease }); }
  finally { releaseScanLease(lease); }
  const file = path.join(parent, 'race-review.json');
  const planned = cli('--plan', '--queue', '--output', file);
  assert.equal(planned.status, 0, planned.stderr);
  const review = JSON.parse(planned.stdout);
  const preload = path.join(parent, 'concurrent-queue.mjs');
  const trace = path.join(parent, 'concurrent-result.json');
  const queueModule = pathToFileURL(path.join(app, 'ui/lib/scanQueue.mjs')).href;
  const leaseModule = pathToFileURL(path.join(app, 'ui/lib/scanLease.mjs')).href;
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import path from 'node:path';
import { enqueueOverlappingScanRequest } from ${JSON.stringify(queueModule)};
import { readScanLease } from ${JSON.stringify(leaseModule)};
const root = process.env.SCOUT_WORKSPACE;
const queue = path.join(root, '.scout/scan-queue.jsonl');
const original = fs.readFileSync;
let submitted = false;
fs.readFileSync = function(file, ...args) {
  const stack = new Error().stack;
  if (!submitted && file === queue && stack.includes('queueCleanupContents') && stack.includes('compactScanQueue')) {
    submitted = true;
    const at = new Date().toISOString();
    const { leaseId, generation, runId, operation } = readScanLease(root);
    const result = enqueueOverlappingScanRequest(root, { id: 'synthetic-concurrent', key: 'synthetic-concurrent', requester: 'manual', purpose: 'job-discovery',
      requestedAt: at, expiresAt: new Date(Date.parse(at) + 86400000).toISOString(), windowAt: null,
      compatibility: { schemaVersion: 1, profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) }, observedLease: { leaseId, generation, runId, operation } });
    fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ status: result.status }));
  }
  return original.call(fs, file, ...args);
};
`);
  const applied = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(app, 'tools/scout.mjs'), 'cleanup', '--workspace', root, '--apply', file, '--confirm', review.reviewDigest], { env, cwd: app, encoding: 'utf8', timeout: 30000 });
  assert.equal(JSON.parse(fs.readFileSync(trace, 'utf8')).status, 'enqueued');
  assert.notEqual(applied.status, 0, 'the compactor must use the reviewed queue digest, even after a legitimate new request');
  assert.deepEqual(projectScanQueue(root).requests.map((item) => item.id).sort(), ['synthetic-concurrent', 'synthetic-expired-review']);
  const operations = path.join(root, '.scout/queue-compactions');
  assert.equal(fs.existsSync(operations) && fs.readdirSync(operations).length > 0, false, 'no unreviewed prepared intent is published');
});

test('malformed private review content is never copied into CLI diagnostics', (t) => {
  const { parent, cli } = fixture(t);
  const file = path.join(parent, 'invalid-review.json');
  const privateMarker = 'PRIVATE_CV';
  fs.writeFileSync(file, privateMarker, { mode: 0o600 });
  const result = cli('--apply', file, '--confirm', 'a'.repeat(64));
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(privateMarker), false);
});
