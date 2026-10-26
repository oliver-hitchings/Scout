import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  archiveSelectedRuns, assertRunStorageWritable, compactRecoverySelections, compactScanQueue, measureRunStorage,
  planRunCleanup,
} from './runRetention.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from './scanLease.mjs';
import {
  claimNextScanRequest, completeScanRequest, enqueueScanRequest, projectScanQueue,
} from './scanQueue.mjs';
import {
  initializeRecoveryBackup, loadRecoveryHeader, unlockRecoveryKey, verifyReviewedRunArchive,
} from './recoveryBackup.mjs';
import { selectRecoverableRun } from './runRecovery.mjs';
import { appendRunEvent, openRunJournal } from './runJournal.mjs';
import { projectRunManifest } from './runArtifacts.mjs';

function recoveryCompatibility() {
  return {
    schemaVersion: 1, mode: 'primary', purpose: 'scheduled-discovery',
    profileVersion: 'profile-v1', sourceConfigFingerprint: 'a'.repeat(64),
    journalSchemaVersion: 1, artifactSchemaVersion: 1,
    pipelineVersion: 'pipeline-v1', rankingVersion: 'ranking-v1', promptVersion: 'prompt-v1',
    assessmentSchemaVersion: 1, provider: 'codex', model: 'model-v1',
    mutationSchemaVersion: 1, targetRevision: 'tracker-v1',
  };
}

function recoveryCandidate(runId, outcome, updatedAt = '2024-01-01T00:00:00.000Z') {
  return { runId, updatedAt, outcome, compatibility: recoveryCompatibility(), completedWork: [] };
}

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-retention-'));
  roots.push(root);
  return root;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function terminalRun(root, runId, recordedAt, outcome = 'complete', artifact = 'artifact') {
  const directory = path.join(root, '.scout', 'runs', runId);
  fs.mkdirSync(path.join(directory, 'artifacts'), { recursive: true });
  const payload = { schemaVersion: 1, outcome };
  const event = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    eventId: crypto.randomUUID(),
    type: 'run.completed',
    recordedAt,
    leaseId: 'lease-retention',
    fencingGeneration: 1,
    stageId: 'finalise',
    idempotencyKey: `complete-${runId}`,
    previousHash: null,
    payloadHash: sha256(payload),
    payload,
  };
  event.eventHash = sha256(event);
  fs.writeFileSync(path.join(directory, 'journal.jsonl'), `${stableJson(event)}\n`);
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({ runId, outcome })}\n`);
  fs.writeFileSync(path.join(directory, 'artifacts', 'result.json'), artifact);
  return directory;
}

function manualRequest(id, requestedAt, expiresAt) {
  return {
    id,
    key: `manual-${id}`,
    requester: 'manual',
    purpose: 'job-discovery',
    requestedAt,
    expiresAt,
    windowAt: null,
    compatibility: {
      schemaVersion: 1,
      profileFingerprint: 'a'.repeat(64),
      configFingerprint: 'b'.repeat(64),
    },
  };
}

function legacyQueueCompaction(root, operationId, recordedAt, {
  auditCount = 1,
  conflictingDigest = false,
} = {}) {
  const beforeDigest = crypto.createHash('sha256').update(`before:${operationId}`).digest('hex');
  const afterDigest = crypto.createHash('sha256').update(`after:${operationId}`).digest('hex');
  const directory = path.join(root, '.scout', 'queue-compactions', operationId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'before.jsonl'), `before:${operationId}\n`);
  fs.writeFileSync(path.join(directory, 'after.jsonl'), `after:${operationId}\n`);
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${stableJson({
    schemaVersion: 1,
    operationId,
    status: 'completed',
    beforeDigest,
    afterDigest,
    removedEvents: 1,
  })}\n`);
  return Array.from({ length: auditCount }, () => ({
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    operationId,
    type: 'queue-compacted',
    recordedAt,
    leaseId: 'lease-legacy-retention',
    fencingGeneration: 1,
    beforeDigest: conflictingDigest ? 'f'.repeat(64) : beforeDigest,
    afterDigest,
    removedEvents: 1,
  }));
}

function versionTwoQueueCompaction(root, operationId, completedAt, {
  recordedAt = completedAt,
} = {}) {
  const audits = legacyQueueCompaction(root, operationId, recordedAt);
  const manifestFile = path.join(root, '.scout', 'queue-compactions', operationId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, `${stableJson({
    ...manifest,
    schemaVersion: 2,
    completedAt,
  })}\n`);
  return audits;
}

function queueCompactionFiles(root, operationId) {
  const directory = path.join(root, '.scout', 'queue-compactions', operationId);
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => (
    [name, fs.readFileSync(path.join(directory, name), 'utf8')]
  )));
}

function archiveAuthority(root, passphrase = 'correct horse battery staple') {
  return { passphrase, ...initializeRecoveryBackup(root, passphrase) };
}

test('measures journals, derived artifacts and the queue independently', () => {
  const root = temp();
  terminalRun(root, 'run-one', '2026-01-01T00:00:00.000Z', 'complete', '12345');
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scout', 'scan-queue.jsonl'), 'queue-bytes\n');

  const measured = measureRunStorage(root);

  assert.equal(measured.runs.count, 1);
  assert.equal(measured.runs.bytes, fs.statSync(path.join(root, '.scout', 'runs', 'run-one', 'journal.jsonl')).size
    + fs.statSync(path.join(root, '.scout', 'runs', 'run-one', 'manifest.json')).size);
  assert.equal(measured.artifacts.bytes, 5);
  assert.equal(measured.queue.bytes, 12);
  assert.equal(measured.totalBytes, measured.runs.bytes + measured.artifacts.bytes + measured.queue.bytes);
});

test('storage measurement counts 100 MiB without reading artifact bodies and stays fresh', (t) => {
  const root = temp();
  const directory = terminalRun(root, 'large-complete', '2026-01-01T00:00:00.000Z');
  const artifact = path.join(directory, 'artifacts', 'result.json');
  const descriptor = fs.openSync(artifact, 'w');
  fs.ftruncateSync(descriptor, 100 * 1024 * 1024);
  fs.closeSync(descriptor);
  const originalRead = fs.readFileSync;
  let artifactReads = 0;
  fs.readFileSync = function read(file, ...args) {
    if (String(file) === artifact) artifactReads += 1;
    return originalRead.call(this, file, ...args);
  };
  try {
    const started = performance.now();
    const measured = measureRunStorage(root);
    const elapsed = performance.now() - started;
    assert.equal(measured.artifacts.bytes, 100 * 1024 * 1024);
    assert.equal(artifactReads, 0, 'status measurement must not hash artifact content');
    assert.ok(elapsed < 2_000, `100 MiB inventory exceeded 2 seconds: ${elapsed}`);
    fs.truncateSync(artifact, 123);
    assert.equal(measureRunStorage(root).artifacts.bytes, 123, 'measurement must not use a stale cache');
    t.diagnostic(`100 MiB metadata measurement: ${elapsed.toFixed(1)} ms; artifact body reads: ${artifactReads}`);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('real recovery selection releases terminal historical skips for reviewed cleanup and keeps their audit', () => {
  const root = temp();
  const outcomes = ['complete', 'partial', 'abandoned', 'failed'];
  for (const outcome of outcomes) terminalRun(root, `historical-${outcome}`, '2024-01-01T00:00:00.000Z', outcome);
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'current-selection', provider: 'codex', mode: 'primary', phase: 'recover',
  });
  try {
    const selected = selectRecoverableRun(
      outcomes.map((outcome) => recoveryCandidate(`historical-${outcome}`, outcome)),
      recoveryCompatibility(), { root, lease },
    );
    assert.equal(selected.candidate, null);
    assert.equal(selected.skipped.length, outcomes.length);
    const selectionFile = path.join(root, '.scout', 'recovery-selections.jsonl');
    const evidence = fs.readFileSync(selectionFile, 'utf8');
    const plan = planRunCleanup(root, {
      now: new Date('2026-10-25T00:00:00.000Z'), keepNewest: 0,
      selectedRunIds: outcomes.map((outcome) => `historical-${outcome}`),
      recoveryDataKey: archiveAuthority(root).dataKey,
    });
    assert.deepEqual(plan.refusedSelections, [], 'a historical skip is evidence, not a recovery obligation');
    assert.equal(plan.selected.length, outcomes.length);
    assert.equal(measureRunStorage(root).recoveryCritical.count, 0);
    const result = archiveSelectedRuns(plan, lease);
    assert.equal(result.archivedRuns, outcomes.length);
    assert.equal(fs.readFileSync(selectionFile, 'utf8'), evidence, 'cleanup must preserve why recovery skipped each run');
  } finally {
    releaseScanLease(lease);
  }
});

test('a selected recovery is protected until it completes, then its old selection stops pinning it', () => {
  const root = temp();
  const runId = 'selected-then-complete';
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId, phase: 'recover' });
  const run = openRunJournal(root, runId);
  appendRunEvent(run, {
    type: 'run.started', stageId: 'initialise', idempotencyKey: 'started',
    payload: { schemaVersion: 1, compatibility: recoveryCompatibility() },
  }, lease);
  selectRecoverableRun([{
    runId, updatedAt: run.events.at(-1).recordedAt, ...projectRunManifest(run.events),
  }], recoveryCompatibility(), { root, lease });
  const policy = { now: new Date('2028-01-01T00:00:00.000Z'), keepNewest: 0, selectedRunIds: [runId] };
  assert.equal(planRunCleanup(root, policy).selected.length, 0);
  appendRunEvent(run, {
    type: 'run.completed', stageId: 'finalise', idempotencyKey: 'completed',
    payload: { schemaVersion: 1, outcome: 'complete' },
  }, lease);
  releaseScanLease(lease);
  assert.equal(planRunCleanup(root, policy).selected.length, 1, 'completed recovery has no remaining selection obligation');
});

test('terminal skips cannot release an unreceipted mutation or a damaged journal', () => {
  const root = temp();
  terminalRun(root, 'historical-clean', '2024-01-01T00:00:00.000Z');
  const damaged = terminalRun(root, 'damaged', '2024-01-01T00:00:00.000Z');
  fs.appendFileSync(path.join(damaged, 'journal.jsonl'), 'not a valid journal\n');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'unreceipted', phase: 'recover' });
  const run = openRunJournal(root, 'unreceipted');
  appendRunEvent(run, {
    type: 'run.started', stageId: 'initialise', idempotencyKey: 'started',
    payload: { schemaVersion: 1, compatibility: { ...recoveryCompatibility(), profileVersion: 'old-profile' } },
  }, lease);
  appendRunEvent(run, {
    type: 'mutation.prepared', stageId: 'finalise', idempotencyKey: 'prepared',
    payload: { schemaVersion: 1, reference: { kind: 'mutation', id: 'pending-mutation' }, digest: 'b'.repeat(64), targetRevision: 'c'.repeat(64) },
  }, lease);
  selectRecoverableRun([
    { ...projectRunManifest(run.events), updatedAt: run.events.at(-1).recordedAt },
    recoveryCandidate('historical-clean', 'complete'), recoveryCandidate('damaged', 'failed'),
  ], recoveryCompatibility(), { root, lease });
  releaseScanLease(lease);
  const plan = planRunCleanup(root, {
    now: new Date('2028-01-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['unreceipted', 'damaged', 'historical-clean'],
  });
  assert.deepEqual(plan.selected.map((item) => item.runId), ['historical-clean']);
  assert.deepEqual(plan.refusedSelections, [
    { runId: 'damaged', reason: 'recovery-critical' },
    { runId: 'unreceipted', reason: 'recovery-critical' },
  ]);
});

test('legacy scan-input bundles count towards pressure and use reviewed encrypted cleanup', () => {
  const root = temp();
  const directory = path.join(root, '.scout', 'scan-input');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '2024-01-01-codex-primary.json');
  const bytes = JSON.stringify({ candidates: [{ id: 'synthetic-vacancy' }] });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
  assert.equal(measureRunStorage(root).artifacts.bytes, Buffer.byteLength(bytes));
  assert.throws(() => assertRunStorageWritable(root, {
    maximumBytes: { artifacts: 1 }, reserveBytes: 0,
  }), (error) => error.code === 'SCOUT_STORAGE_PRESSURE');
  const candidate = planRunCleanup(root, {
    now: new Date('2028-01-01T00:00:00.000Z'), keepNewest: 0,
  }).candidates[0];
  assert.equal(candidate.legacyScanInput, path.basename(file));
  const authority = archiveAuthority(root);
  const plan = planRunCleanup(root, {
    now: new Date('2028-01-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: [candidate.runId], recoveryDataKey: authority.dataKey,
  });
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'cleanup-legacy-input' });
  try {
    const result = archiveSelectedRuns(plan, lease);
    const payload = verifyReviewedRunArchive(result.archiveFile, authority.dataKey);
    assert.equal(Buffer.from(payload.runs[0].files[0].data, 'base64').toString(), bytes);
    assert.equal(fs.existsSync(file), false);
    assert.equal(measureRunStorage(root).artifacts.bytes, 0);
  } finally {
    releaseScanLease(lease);
  }
});

test('reviewed cleanup compacts old recovery selections into a verified archive and resumes its receipt', () => {
  const root = temp();
  terminalRun(root, 'historical-selections', '2024-01-01T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'selection-compaction' });
  try {
    for (let index = 0; index < 270; index += 1) {
      selectRecoverableRun([recoveryCandidate('historical-selections', 'complete')], {
        ...recoveryCompatibility(), promptVersion: `prompt-${index}`,
      }, { root, lease });
    }
    const file = path.join(root, '.scout', 'recovery-selections.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    const authority = archiveAuthority(root);
    const plan = planRunCleanup(root, {
      now: new Date('2028-01-01T00:00:00.000Z'), keepNewest: 0,
      selectedRunIds: ['historical-selections'], recoveryDataKey: authority.dataKey,
    });
    let interrupted = false;
    try {
      archiveSelectedRuns(plan, lease, {
        afterSelectionReplace() { interrupted = true; throw new Error('simulated compaction receipt crash'); },
      });
    } catch (error) {
      assert.match(error.message, /simulated compaction receipt crash/);
    }
    assert.equal(interrupted, true, 'reviewed cleanup must compact the historical selection journal');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 256);
    selectRecoverableRun([], { ...recoveryCompatibility(), promptVersion: 'after-compaction-crash' }, { root, lease });
    const result = archiveSelectedRuns(plan, lease);
    assert.equal(result.archivedRuns, 1);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 257, 'preserve a valid append after replacement');
    const receipts = fs.readFileSync(path.join(root, '.scout', 'run-retention.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse).filter((event) => event.type === 'recovery-selections-compacted');
    assert.equal(receipts.length, 1, 'compaction recovery must not duplicate its receipt');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.scout', 'recovery-selection-compaction.json'), 'utf8'));
    const archived = verifyReviewedRunArchive(path.join(root, manifest.archiveFile), authority.dataKey);
    assert.equal(Buffer.from(archived.runs[0].files[0].data, 'base64').toString(), before);
  } finally {
    releaseScanLease(lease);
  }
});

test('selection compaction retains current terminal dispositions and rechecks the fence before replacement', () => {
  const root = temp();
  terminalRun(root, 'preserved-terminal', '2024-01-01T00:00:00.000Z', 'partial');
  let lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'compact-current' });
  try {
    const initial = selectRecoverableRun([recoveryCandidate('preserved-terminal', 'partial')], recoveryCompatibility(), { root, lease });
    for (let index = 0; index < 270; index += 1) {
      selectRecoverableRun([], { ...recoveryCompatibility(), promptVersion: `prompt-${index}` }, { root, lease });
    }
    const file = path.join(root, '.scout', 'recovery-selections.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    const authority = archiveAuthority(root);
    assert.throws(() => compactRecoverySelections(root, lease, {
      recoveryDataKey: authority.dataKey, beforeReplace() { releaseScanLease(lease); },
    }), /lease|fence/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a stale owner cannot replace the selection journal');
    lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'compact-successor' });
    selectRecoverableRun([], { ...recoveryCompatibility(), promptVersion: 'after-prepared-compaction' }, { root, lease });
    const result = compactRecoverySelections(root, lease, { recoveryDataKey: authority.dataKey });
    assert.equal(result.changed, true);
    const kept = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(kept.length, 258, 'retain recent 256, the current run disposition and the post-intent append');
    assert.equal(kept.some((record) => record.selectionId === initial.selectionId), true);
    assert.equal(planRunCleanup(root, {
      now: new Date('2028-01-01T00:00:00.000Z'), keepNewest: 0, selectedRunIds: ['preserved-terminal'],
    }).selected.length, 1);
  } finally {
    releaseScanLease(lease);
  }
});

test('compaction rejects a prepared removal count that conflicts with its verified archive', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'compaction-corrupt-intent' });
  try {
    for (let index = 0; index < 260; index += 1) {
      selectRecoverableRun([], { ...recoveryCompatibility(), promptVersion: `prompt-${index}` }, { root, lease });
    }
    const authority = archiveAuthority(root);
    assert.throws(() => compactRecoverySelections(root, lease, {
      recoveryDataKey: authority.dataKey, beforeReplace() { throw new Error('simulated prepared-intent crash'); },
    }), /simulated prepared-intent crash/);
    const file = path.join(root, '.scout', 'recovery-selections.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    const manifestFile = path.join(root, '.scout', 'recovery-selection-compaction.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, removedRecords: manifest.removedRecords + 1 }));
    assert.throws(() => compactRecoverySelections(root, lease, {
      recoveryDataKey: authority.dataKey,
    }), /conflict|invalid/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'conflicting intent must not replace the selection journal');
    assert.equal(fs.existsSync(path.join(root, '.scout', 'run-retention.jsonl')), false, 'conflicting intent must not create a false receipt');
  } finally {
    releaseScanLease(lease);
  }
});

test('cleanup policy keeps newest twenty, thirty-day history and every recovery-critical run', () => {
  const root = temp();
  for (let index = 0; index < 24; index += 1) {
    terminalRun(root, `complete-${String(index).padStart(2, '0')}`, `2025-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`);
  }
  terminalRun(root, 'recent-complete', '2026-01-20T00:00:00.000Z');
  terminalRun(root, 'old-partial', '2024-01-01T00:00:00.000Z', 'partial');
  terminalRun(root, 'old-failed', '2024-01-02T00:00:00.000Z', 'failed');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'policy-selection' });
  selectRecoverableRun([recoveryCandidate('complete-02', 'complete')], recoveryCompatibility(), { root, lease });
  releaseScanLease(lease);

  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'),
    selectedRunIds: ['complete-00', 'complete-02', 'old-partial'],
  });

  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'complete-00'), true);
  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'recent-complete'), false);
  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'old-partial'), false);
  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'old-failed'), false);
  assert.deepEqual(plan.selected.map((candidate) => candidate.runId), ['complete-00', 'complete-02']);
  assert.deepEqual(plan.refusedSelections, [
    { runId: 'old-partial', reason: 'recovery-critical' },
  ]);
  assert.equal(plan.compactSummaries.some((summary) => summary.runId === 'complete-00'), true);
  assert.equal(measureRunStorage(root).recoveryCritical.runIds.includes('complete-02'), false);
});

test('unsafe journal pressure fails closed and identifies protected storage', () => {
  const root = temp();
  terminalRun(root, 'partial-private-id', '2024-01-01T00:00:00.000Z', 'partial', 'x'.repeat(64));

  assert.throws(
    () => assertRunStorageWritable(root, {
      maximumBytes: { runs: 1, artifacts: 1, queue: 1 },
      reserveBytes: 1,
    }),
    (error) => error?.code === 'SCOUT_STORAGE_PRESSURE'
      && error.measurement.recoveryCritical.runIds.includes('partial-private-id'),
  );
  const measured = measureRunStorage(root);
  assert.throws(
    () => assertRunStorageWritable(root, {
      maximumBytes: {
        runs: measured.runs.bytes + 1,
        artifacts: measured.artifacts.bytes + 100,
        queue: measured.queue.bytes + 100,
      },
      reserveBytes: 1,
    }),
    (error) => error?.areas?.includes('runs'),
  );
});

test('reviewed cleanup encrypts and verifies the selected source before fenced deletion', () => {
  const root = temp();
  terminalRun(root, 'old-complete', '2025-03-01T00:00:00.000Z', 'complete', 'PRIVATE-RUN-BODY');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const authority = archiveAuthority(root);
  const recoveryDataKey = authority.dataKey;
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scout', 'run-retention-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
    summaries: [{
      schemaVersion: 1,
      runId: 'expired-summary',
      updatedAt: '2024-01-01T00:00:00.000Z',
      outcome: 'complete',
      completedStages: [],
      recoveryCount: 0,
    }],
  })}\n`);
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'),
    keepNewest: 0,
    selectedRunIds: ['old-complete'],
    recoveryDataKey,
  });

  const result = archiveSelectedRuns(plan, lease);

  assert.equal(fs.existsSync(path.join(root, '.scout', 'runs', 'old-complete')), false);
  assert.equal(fs.existsSync(result.archiveFile), true);
  assert.doesNotMatch(fs.readFileSync(result.archiveFile, 'utf8'), /PRIVATE-RUN-BODY|old-complete/);
  assert.equal(result.archivedRuns, 1);
  assert.equal(JSON.stringify(plan).includes(recoveryDataKey.toString('hex')), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.indexFile, 'utf8')).summaries.map((summary) => summary.runId),
    ['old-complete'],
  );
  const restartedKey = unlockRecoveryKey(loadRecoveryHeader(root), authority.passphrase);
  assert.equal(
    verifyReviewedRunArchive(result.archiveFile, restartedKey).runs[0].runId,
    'old-complete',
  );
});

test('cleanup without the protected recovery key or with a stale fence deletes nothing', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0, selectedRunIds: ['old-complete'],
  });
  assert.throws(() => archiveSelectedRuns(plan, lease), /protected archive sink/i);
  assert.equal(fs.existsSync(directory), true);

  const keyed = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: archiveAuthority(root).dataKey,
  });
  fs.writeFileSync(path.join(directory, 'artifacts', 'changed.json'), 'changed-after-review');
  assert.throws(() => archiveSelectedRuns(keyed, lease), /changed after review/i);
  assert.equal(fs.existsSync(directory), true);
});

test('cleanup rejects a released stale lease before writing or deleting', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: archiveAuthority(root).dataKey,
  });
  releaseScanLease(lease);

  assert.throws(() => archiveSelectedRuns(plan, lease), /lease/i);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(path.join(root, '.scout-backup', 'v1', 'run-archives')), false);
});

test('cleanup rejects selection changes made after operator review', () => {
  const root = temp();
  const first = terminalRun(root, 'old-first', '2024-01-01T00:00:00.000Z');
  const second = terminalRun(root, 'old-second', '2024-01-02T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-first'], recoveryDataKey: archiveAuthority(root).dataKey,
  });
  assert.throws(
    () => plan.selected.push(plan.candidates.find((candidate) => candidate.runId === 'old-second')),
    TypeError,
  );
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
});

test('an arbitrary unpersisted data key cannot authorize source deletion', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  archiveAuthority(root);
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: crypto.randomBytes(32),
  });

  assert.throws(() => archiveSelectedRuns(plan, lease), /persisted recovery|data key/i);
  assert.equal(fs.existsSync(directory), true);
});

test('new recovery evidence after review makes a selected run ineligible before archival', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const authority = archiveAuthority(root);
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: authority.dataKey,
  });
  fs.writeFileSync(path.join(root, '.scout', 'recovery-selections.jsonl'), `${JSON.stringify({
    selectedRunId: 'old-complete', skipped: [],
  })}\n`);

  assert.throws(() => archiveSelectedRuns(plan, lease), /recovery-critical|eligibility changed/i);
  assert.equal(fs.existsSync(directory), true);
});

test('a live queue claim created after review protects its referenced run', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const authority = archiveAuthority(root);
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: authority.dataKey,
  });
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'old-complete', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  enqueueScanRequest(root, {
    ...manualRequest('live-claim', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
    lease,
  });
  claimNextScanRequest(root, {
    profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64),
    purpose: 'job-discovery', schemaVersion: 1,
  }, lease, new Date('2026-01-01T00:01:00.000Z'));

  assert.throws(() => archiveSelectedRuns(plan, lease), /queued|recovery-critical|eligibility changed/i);
  assert.equal(fs.existsSync(directory), true);
});

test('archive commit refuses fence loss immediately before final replacement', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const authority = archiveAuthority(root);
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: authority.dataKey,
  });

  assert.throws(() => archiveSelectedRuns(plan, lease, {
    beforeArchiveCommit() { releaseScanLease(lease); },
  }), /lease/i);
  assert.equal(fs.existsSync(directory), true);
  const archiveDirectory = path.join(root, '.scout-backup', 'v1', 'run-archives');
  assert.equal(
    fs.existsSync(archiveDirectory)
      && fs.readdirSync(archiveDirectory).some((name) => name.endsWith('.json')),
    false,
  );
});

test('partial deletion resumes from the verified archive and completes receipts exactly once', () => {
  const root = temp();
  const first = terminalRun(root, 'old-first', '2024-01-01T00:00:00.000Z');
  const second = terminalRun(root, 'old-second', '2024-01-02T00:00:00.000Z');
  const authority = archiveAuthority(root);
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-first', 'old-second'], recoveryDataKey: authority.dataKey,
  });
  assert.throws(() => archiveSelectedRuns(plan, lease, {
    afterSourceDelete({ index }) {
      if (index === 0) throw new Error('injected crash after first delete');
    },
  }), /injected crash/);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);

  const resumed = archiveSelectedRuns(plan, lease);
  assert.equal(resumed.archivedRuns, 2);
  assert.equal(fs.existsSync(second), false);
  const manifest = JSON.parse(fs.readFileSync(resumed.operationManifest, 'utf8'));
  assert.equal(manifest.status, 'completed');
  assert.deepEqual(manifest.runs.map((run) => run.status), ['deleted', 'deleted']);
  const audits = fs.readFileSync(path.join(root, '.scout', 'run-retention.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse)
    .filter((event) => event.operationId === manifest.operationId && event.type === 'archive-completed');
  assert.equal(audits.length, 1);
});

test('review digest binds policy and exact compact summary projection', () => {
  const root = temp();
  terminalRun(root, 'old-complete', '2025-03-01T00:00:00.000Z');
  const authority = archiveAuthority(root);
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: authority.dataKey,
  });

  assert.throws(() => { plan.policy.summaryDays = 0; }, TypeError);
  assert.throws(() => { plan.compactSummaries[0].completedStages.push('private-field'); }, TypeError);
  assert.doesNotThrow(() => archiveSelectedRuns(plan, lease));
});

test('queue compaction preserves live work and recent terminal evidence idempotently', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  enqueueScanRequest(root, {
    ...manualRequest('old-terminal', '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'),
    lease,
  });
  enqueueScanRequest(root, {
    ...manualRequest('live-request', '2026-07-29T00:00:00.000Z', '2026-07-30T00:00:00.000Z'),
    lease,
  });

  const first = compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });
  const bytes = fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl'));
  const second = compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });

  assert.equal(first.removedEvents > 0, true);
  assert.deepEqual(projectScanQueue(root, new Date('2026-07-29T12:00:00.000Z')).requests.map((item) => item.id), ['live-request']);
  assert.deepEqual(fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl')), bytes);
  assert.equal(second.changed, false);
});

test('queue retention age comes from the durable terminal event, not request expiry', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  enqueueScanRequest(root, {
    ...manualRequest('old-request-recent-terminal', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z'),
    lease,
  });
  const claim = claimNextScanRequest(root, {
    profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64),
    purpose: 'job-discovery', schemaVersion: 1,
  }, lease, new Date('2020-01-01T00:01:00.000Z'));
  completeScanRequest(root, claim.id, 'failed', lease, claim.claim);

  compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });

  assert.equal(projectScanQueue(root).requests.some((request) => request.id === 'old-request-recent-terminal'), true);
});

test('queue compaction repairs a crash after atomic replacement without duplicating its audit', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  enqueueScanRequest(root, {
    ...manualRequest('old-terminal', '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'),
    lease,
  });
  assert.throws(() => compactScanQueue(root, lease, {
    now: new Date('2026-07-29T12:00:00.000Z'),
    afterQueueReplace() { throw new Error('injected queue crash'); },
  }), /injected queue crash/);
  const interrupted = measureRunStorage(root);
  assert.equal(interrupted.queue.recoveryCriticalOperations, 1);
  assert.equal(interrupted.queue.operationBytes > 0, true);
  assert.equal(interrupted.queue.bytes > fs.statSync(path.join(root, '.scout', 'scan-queue.jsonl')).size, true);

  const resumed = compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });
  assert.equal(resumed.reconciled, true);
  const audits = fs.readFileSync(path.join(root, '.scout', 'run-retention.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse)
    .filter((event) => event.type === 'queue-compacted');
  assert.equal(audits.length, 1);
  const operationDirectory = path.join(root, '.scout', 'queue-compactions');
  const completedDirectory = path.join(operationDirectory, fs.readdirSync(operationDirectory)[0]);
  assert.deepEqual(fs.readdirSync(completedDirectory), ['manifest.json']);
  const completed = measureRunStorage(root);
  assert.equal(completed.queue.recoveryCriticalOperations, 0);
  assert.equal(completed.queue.operationBytes < interrupted.queue.operationBytes, true);
});

test('repeated queue compactions retain bounded receipts and never prune an interrupted operation', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  enqueueScanRequest(root, {
    ...manualRequest('prepared-old', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z'),
    lease,
  });
  assert.throws(() => compactScanQueue(root, lease, {
    now: new Date('2026-07-29T12:00:00.000Z'),
    beforeQueueReplace() { throw new Error('injected prepared crash'); },
  }), /injected prepared crash/);
  const operationRoot = path.join(root, '.scout', 'queue-compactions');
  const preparedId = fs.readdirSync(operationRoot)[0];

  for (let index = 0; index < 25; index += 1) {
    const id = `terminal-${String(index).padStart(2, '0')}`;
    enqueueScanRequest(root, {
      ...manualRequest(id, `2020-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, `2020-02-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`),
      lease,
    });
    compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });
  }

  const operationDirectories = fs.readdirSync(operationRoot);
  assert.equal(operationDirectories.includes(preparedId), true);
  const manifests = operationDirectories.map((id) => ({
    id,
    directory: path.join(operationRoot, id),
    manifest: JSON.parse(fs.readFileSync(path.join(operationRoot, id, 'manifest.json'), 'utf8')),
  }));
  assert.equal(manifests.filter(({ manifest }) => manifest.status === 'prepared').length, 1);
  assert.equal(manifests.filter(({ manifest }) => manifest.status === 'completed').length <= 20, true);
  for (const receipt of manifests.filter(({ manifest }) => manifest.status === 'completed')) {
    assert.deepEqual(fs.readdirSync(receipt.directory), ['manifest.json']);
  }
  assert.deepEqual(
    fs.readdirSync(path.join(operationRoot, preparedId)).sort(),
    ['after.jsonl', 'before.jsonl', 'manifest.json'],
  );
  const measured = measureRunStorage(root);
  assert.equal(measured.queue.recoveryCriticalOperations, 1);
  assert.equal(measured.queue.completedReceipts <= 20, true);
  assert.equal(measured.queue.bytes < 128 * 1024, true);
  const audits = fs.readFileSync(path.join(root, '.scout', 'run-retention.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse)
    .filter((event) => event.type === 'queue-compacted');
  assert.equal(audits.length <= 20, true);
});

test('legacy queue receipts retain the newest twenty by their unique durable audit time', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  const operationIds = Array.from({ length: 21 }, (_, index) => (
    crypto.createHash('sha256').update(`legacy-receipt:${index}`).digest('hex')
  )).sort();
  const audits = operationIds.flatMap((operationId, index) => legacyQueueCompaction(
    root,
    operationId,
    `2025-01-${String(21 - index).padStart(2, '0')}T12:00:00.000Z`,
  ));
  fs.writeFileSync(
    path.join(root, '.scout', 'run-retention.jsonl'),
    `${audits.map(stableJson).join('\n')}\n`,
  );

  compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });

  const operationRoot = path.join(root, '.scout', 'queue-compactions');
  assert.deepEqual(fs.readdirSync(operationRoot).sort(), operationIds.slice(0, 20).sort());
  for (let index = 0; index < 20; index += 1) {
    const directory = path.join(operationRoot, operationIds[index]);
    assert.deepEqual(fs.readdirSync(directory), ['manifest.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.completedAt, audits[index].recordedAt);
  }
  const retainedAudits = fs.readFileSync(path.join(root, '.scout', 'run-retention.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    retainedAudits.map((event) => event.operationId).sort(),
    operationIds.slice(0, 20).sort(),
  );
});

test('version-two queue receipts retain the newest twenty by their reconciled completion time', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  const operationIds = Array.from({ length: 21 }, (_, index) => (
    crypto.createHash('sha256').update(`v2-receipt:${index}`).digest('hex')
  )).sort();
  const audits = operationIds.flatMap((operationId, index) => versionTwoQueueCompaction(
    root,
    operationId,
    `2025-02-${String(21 - index).padStart(2, '0')}T12:00:00.000Z`,
  ));
  const auditFile = path.join(root, '.scout', 'run-retention.jsonl');
  fs.writeFileSync(auditFile, `${audits.map(stableJson).join('\n')}\n`);

  compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });

  const operationRoot = path.join(root, '.scout', 'queue-compactions');
  assert.deepEqual(fs.readdirSync(operationRoot).sort(), operationIds.slice(0, 20).sort());
  for (let index = 0; index < 20; index += 1) {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(operationRoot, operationIds[index], 'manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.completedAt, audits[index].recordedAt);
  }
  const retainedAudits = fs.readFileSync(auditFile, 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    retainedAudits.map((event) => event.operationId).sort(),
    operationIds.slice(0, 20).sort(),
  );
});

test('version-two queue receipt pruning rejects canonical conflicting completion times without mutation', () => {
  const conflictingCases = [
    ['future manifest', '2099-01-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z'],
    ['past manifest', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'],
  ];
  for (const [label, completedAt, recordedAt] of conflictingCases) {
    const root = temp();
    const lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
    });
    const operationIds = Array.from({ length: 21 }, (_, index) => (
      crypto.createHash('sha256').update(`v2-conflict-${label}:${index}`).digest('hex')
    ));
    const audits = operationIds.flatMap((operationId, index) => (
      index === 0
        ? versionTwoQueueCompaction(root, operationId, completedAt, { recordedAt })
        : versionTwoQueueCompaction(
          root,
          operationId,
          `2025-03-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
        )
    ));
    const auditFile = path.join(root, '.scout', 'run-retention.jsonl');
    fs.writeFileSync(auditFile, `${audits.map(stableJson).join('\n')}\n`);
    const operationRoot = path.join(root, '.scout', 'queue-compactions');
    const before = {
      audit: fs.readFileSync(auditFile, 'utf8'),
      operations: Object.fromEntries(operationIds.map((operationId) => (
        [operationId, queueCompactionFiles(root, operationId)]
      ))),
    };

    assert.throws(
      () => compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') }),
      /queue compaction audit does not match its receipt/i,
      label,
    );
    assert.deepEqual(fs.readdirSync(operationRoot).sort(), operationIds.sort(), label);
    for (const operationId of operationIds) {
      assert.deepEqual(queueCompactionFiles(root, operationId), before.operations[operationId], label);
    }
    assert.equal(fs.readFileSync(auditFile, 'utf8'), before.audit, label);
  }
});

test('legacy queue receipt folding fails closed when its durable audit is missing, ambiguous or conflicting', () => {
  for (const auditCase of ['missing', 'ambiguous', 'conflicting']) {
    const root = temp();
    const lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
    });
    const operationId = crypto.createHash('sha256').update(`legacy-${auditCase}`).digest('hex');
    const audits = legacyQueueCompaction(root, operationId, '2025-01-01T12:00:00.000Z', {
      auditCount: auditCase === 'missing' ? 0 : auditCase === 'ambiguous' ? 2 : 1,
      conflictingDigest: auditCase === 'conflicting',
    });
    if (audits.length) {
      fs.writeFileSync(
        path.join(root, '.scout', 'run-retention.jsonl'),
        `${audits.map(stableJson).join('\n')}\n`,
      );
    }

    assert.throws(
      () => compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') }),
      /legacy queue compaction audit/i,
    );
    const directory = path.join(root, '.scout', 'queue-compactions', operationId);
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      ['after.jsonl', 'before.jsonl', 'manifest.json'],
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).schemaVersion,
      1,
    );
  }
});

test('legacy queue receipt folding rejects noncanonical audit timestamps and invalid event or lease identities without mutation', () => {
  const malformedCases = [
    ['numeric timestamp', { recordedAt: '0' }],
    ['locale timestamp', { recordedAt: 'January 1, 2025 12:00:00 UTC' }],
    ['normalised timestamp', { recordedAt: '2025-01-01T12:00:00Z' }],
    ['event identity', { eventId: 'event.invalid' }],
    ['lease identity', { leaseId: '-lease-invalid' }],
  ];
  for (const [label, malformed] of malformedCases) {
    const root = temp();
    const lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
    });
    const operationId = crypto.createHash('sha256').update(`legacy-malformed-${label}`).digest('hex');
    const sentinelId = crypto.createHash('sha256').update(`legacy-sentinel-${label}`).digest('hex');
    const audits = [
      ...legacyQueueCompaction(root, operationId, '2025-01-01T12:00:00.000Z'),
      ...versionTwoQueueCompaction(root, sentinelId, '2025-01-02T12:00:00.000Z'),
    ];
    Object.assign(audits[0], malformed);
    const auditFile = path.join(root, '.scout', 'run-retention.jsonl');
    fs.writeFileSync(auditFile, `${audits.map(stableJson).join('\n')}\n`);
    const before = {
      audit: fs.readFileSync(auditFile, 'utf8'),
      malformed: queueCompactionFiles(root, operationId),
      sentinel: queueCompactionFiles(root, sentinelId),
    };

    assert.throws(
      () => compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') }),
      /queue compaction audit/i,
      label,
    );
    assert.deepEqual(queueCompactionFiles(root, operationId), before.malformed, label);
    assert.deepEqual(queueCompactionFiles(root, sentinelId), before.sentinel, label);
    assert.equal(fs.readFileSync(auditFile, 'utf8'), before.audit, label);
  }
});

test('version-two queue receipt pruning rejects malformed manifest and audit evidence without mutation', () => {
  const malformedCases = [
    ['numeric manifest timestamp', { manifest: { completedAt: '0' } }],
    ['locale manifest timestamp', { manifest: { completedAt: 'January 1, 2025 12:00:00 UTC' } }],
    ['normalised manifest timestamp', { manifest: { completedAt: '2025-01-01T12:00:00Z' } }],
    ['numeric audit timestamp', { audit: { recordedAt: '0' } }],
    ['locale audit timestamp', { audit: { recordedAt: 'January 1, 2025 12:00:00 UTC' } }],
    ['normalised audit timestamp', { audit: { recordedAt: '2025-01-01T12:00:00Z' } }],
    ['event identity', { audit: { eventId: 'event.invalid' } }],
    ['lease identity', { audit: { leaseId: '-lease-invalid' } }],
    ['operation identity', { extraAudit: { operationId: 'operation.invalid' } }],
  ];
  for (const [label, malformed] of malformedCases) {
    const root = temp();
    const lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
    });
    const operationId = crypto.createHash('sha256').update(`v2-malformed-${label}`).digest('hex');
    const sentinelId = crypto.createHash('sha256').update(`v2-sentinel-${label}`).digest('hex');
    const audits = [
      ...versionTwoQueueCompaction(root, operationId, '2025-01-01T12:00:00.000Z'),
      ...versionTwoQueueCompaction(root, sentinelId, '2025-01-02T12:00:00.000Z'),
    ];
    if (malformed.manifest) {
      const manifestFile = path.join(
        root, '.scout', 'queue-compactions', operationId, 'manifest.json',
      );
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      fs.writeFileSync(manifestFile, `${stableJson({ ...manifest, ...malformed.manifest })}\n`);
    }
    if (malformed.audit) Object.assign(audits[0], malformed.audit);
    if (malformed.extraAudit) {
      audits.push({
        ...audits[0],
        eventId: crypto.randomUUID(),
        ...malformed.extraAudit,
      });
    }
    const auditFile = path.join(root, '.scout', 'run-retention.jsonl');
    fs.writeFileSync(auditFile, `${audits.map(stableJson).join('\n')}\n`);
    const before = {
      audit: fs.readFileSync(auditFile, 'utf8'),
      malformed: queueCompactionFiles(root, operationId),
      sentinel: queueCompactionFiles(root, sentinelId),
    };

    assert.throws(
      () => compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') }),
      /queue compaction (?:manifest|audit)/i,
      label,
    );
    assert.deepEqual(queueCompactionFiles(root, operationId), before.malformed, label);
    assert.deepEqual(queueCompactionFiles(root, sentinelId), before.sentinel, label);
    assert.equal(fs.readFileSync(auditFile, 'utf8'), before.audit, label);
  }
});

test('Windows junctions cannot redirect selected runs or the protected archive parent', { skip: process.platform !== 'win32' }, () => {
  const root = temp();
  const outsideRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-retention-outside-runs-'));
  const outsideArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-retention-outside-archive-'));
  roots.push(outsideRuns, outsideArchive);
  terminalRun(outsideRuns, 'outside-run', '2024-01-01T00:00:00.000Z');
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  fs.symlinkSync(path.join(outsideRuns, '.scout', 'runs'), path.join(root, '.scout', 'runs'), 'junction');
  assert.throws(
    () => planRunCleanup(root, { now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0 }),
    /junction|symlink|outside/i,
  );

  fs.rmSync(path.join(root, '.scout', 'runs'));
  terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const authority = archiveAuthority(root);
  fs.renameSync(path.join(root, '.scout-backup'), path.join(outsideArchive, 'persisted'));
  fs.symlinkSync(path.join(outsideArchive, 'persisted'), path.join(root, '.scout-backup'), 'junction');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: authority.dataKey,
  });
  assert.throws(() => archiveSelectedRuns(plan, lease), /junction|symlink|outside/i);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'runs', 'old-complete')), true);
});

test('Windows queue compaction rejects a junction-backed Scout state parent', { skip: process.platform !== 'win32' }, () => {
  const root = temp();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-retention-outside-queue-'));
  roots.push(outside);
  fs.symlinkSync(outside, path.join(root, '.scout'), 'junction');
  fs.writeFileSync(path.join(outside, 'scan-queue.jsonl'), '');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'queue',
  });

  assert.throws(
    () => compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') }),
    /junction|symlink|outside/i,
  );
});
