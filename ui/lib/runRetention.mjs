import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { projectRunManifest } from './runArtifacts.mjs';
import { validateRunJournal } from './runJournal.mjs';
import { readRecoverySelections } from './runRecovery.mjs';
import {
  assertCurrentFence, assertScanLeaseScope, readScanLease, synchronousFenceCallback,
} from './scanLease.mjs';
import { projectScanQueue, recoverScanQueueTail } from './scanQueue.mjs';
import {
  assertPersistedRecoveryDataKey, verifyReviewedRunArchive, writeReviewedRunArchive,
} from './recoveryBackup.mjs';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';
import { workspacePaths } from './workspace.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLICY = Object.freeze({
  keepNewest: 20,
  keepDays: 30,
  summaryDays: 365,
});
const DEFAULT_MAXIMUM_BYTES = Object.freeze({
  runs: 256 * 1024 * 1024,
  artifacts: 1024 * 1024 * 1024,
  queue: 64 * 1024 * 1024,
});
const DEFAULT_WARNING_BYTES = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_MAXIMUM_BYTES).map(([area, bytes]) => [area, Math.floor(bytes * 0.75)]),
));
const DEFAULT_RESERVE_BYTES = 64 * 1024;
const RETENTION_INDEX_SCHEMA_VERSION = 1;
const ARCHIVE_SCHEMA_VERSION = 1;
const MAX_COMPLETED_QUEUE_COMPACTION_RECEIPTS = 20;
const RECENT_RECOVERY_SELECTIONS = 256;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkedDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function safeRunDirectory(root, runId) {
  const runsRoot = path.resolve(workspacePaths(root).runs);
  const target = path.resolve(runsRoot, runId);
  if (path.dirname(target) !== runsRoot) throw new Error('retention run path escaped the run store');
  return validatePhysicalWorkspacePath(root, target, 'retention run path');
}

function walkFiles(directory, relative = '', files = []) {
  if (!fs.existsSync(directory)) return files;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('retention does not accept symbolic links');
  if (stat.isFile()) {
    files.push({ relative: relative.replaceAll('\\', '/'), absolute: directory, size: stat.size });
    return files;
  }
  if (!stat.isDirectory()) throw new Error('retention encountered an unsupported filesystem entry');
  for (const name of fs.readdirSync(directory).sort()) {
    walkFiles(path.join(directory, name), relative ? path.join(relative, name) : name, files);
  }
  return files;
}

function runInventory(root, { contentDigests = false } = {}) {
  const runsRoot = workspacePaths(root).runs;
  if (!fs.existsSync(runsRoot)) return legacyScanInputInventory(root, { contentDigests });
  validatePhysicalWorkspacePath(root, runsRoot, 'retention run store');
  const inventory = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.isSymbolicLink()) throw new Error('retention run store contains a symbolic link');
      continue;
    }
    const directory = safeRunDirectory(root, entry.name);
    const journalFile = path.join(directory, 'journal.jsonl');
    const files = walkFiles(directory);
    let events = [];
    let invalid = false;
    if (fs.existsSync(journalFile)) {
      try {
        const result = validateRunJournal(journalFile);
        if (result.truncatedTail) throw new Error('run journal has a truncated final entry');
        events = result.events;
      } catch {
        invalid = true;
      }
    } else {
      invalid = true;
    }
    let manifest = null;
    if (!invalid && events.length) {
      try {
        manifest = projectRunManifest(events);
      } catch {
        invalid = true;
      }
    }
    const updatedAt = events.at(-1)?.recordedAt || null;
    inventory.push({
      runId: entry.name,
      directory,
      files,
      invalid,
      events,
      manifest,
      outcome: manifest?.outcome || 'in-progress',
      updatedAt,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      ...(contentDigests ? { digest: digestFiles(files) } : {}),
    });
  }
  const legacy = legacyScanInputInventory(root, { contentDigests });
  if (legacy.some((input) => inventory.some((run) => run.runId === input.runId))) {
    throw new Error('legacy scan-input identity conflicts with the run store');
  }
  return [...inventory, ...legacy];
}

function legacyScanInputInventory(root, { contentDigests }) {
  const directory = path.join(path.resolve(root), '.scout', 'scan-input');
  if (!fs.existsSync(directory)) return [];
  validatePhysicalWorkspacePath(root, directory, 'legacy scan-input store');
  return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const file = validatePhysicalWorkspacePath(root, path.join(directory, entry.name), 'legacy scan-input file');
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('legacy scan-input store contains an unsupported entry');
    const stat = fs.lstatSync(file);
    const files = walkFiles(file, 'artifacts/scan-input.json');
    return {
      runId: `legacy-input-${sha256(entry.name).slice(0, 32)}`,
      legacyScanInput: entry.name,
      directory: file, files, invalid: false, events: [], manifest: null,
      outcome: 'complete', updatedAt: stat.mtime.toISOString(), bytes: stat.size,
      ...(contentDigests ? { digest: digestFiles(files) } : {}),
    };
  });
}

function selectedSource(root, selected) {
  if (!selected.legacyScanInput) return safeRunDirectory(root, selected.runId);
  const name = selected.legacyScanInput;
  if (typeof name !== 'string' || path.basename(name) !== name
    || name.includes('/') || name.includes('\\')
    || selected.runId !== `legacy-input-${sha256(name).slice(0, 32)}`) {
    throw new Error('legacy scan-input selection is invalid');
  }
  return validatePhysicalWorkspacePath(root,
    path.join(path.resolve(root), '.scout', 'scan-input', name), 'legacy scan-input selection');
}

function selectedFiles(root, selected) {
  return walkFiles(selectedSource(root, selected), selected.legacyScanInput ? 'artifacts/scan-input.json' : '');
}

function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file.absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function recoveryDispositions(root) {
  const dispositions = new Map();
  for (const record of readRecoverySelections(root)) {
    for (const skipped of record.skipped) {
      dispositions.set(skipped.runId, { ...skipped, recordedAt: record.recordedAt });
    }
    if (record.selectedRunId) dispositions.set(record.selectedRunId, { selected: true });
  }
  return dispositions;
}

function hasUnreceiptedMutation(run) {
  const receipted = new Set(run.manifest?.receipts?.map((receipt) => receipt.reference?.id));
  return run.events.some((event) => event.type === 'mutation.prepared'
    && !receipted.has(event.payload?.reference?.id));
}

function recoveryProtection(run, dispositions, queued, lease, now) {
  if (run.invalid || hasUnreceiptedMutation(run)) return 'recovery-critical';
  if (queued.has(run.runId)) return 'queued';
  if (lease?.runId === run.runId && lease.lastTerminalSequence === null
    && Date.parse(lease.expiresAt) > now.getTime()) return 'active';
  const disposition = dispositions.get(run.runId);
  if (run.outcome === 'complete') return null;
  if (disposition?.selected) return 'recovery-referenced';
  // A newer journal entry is new work, not the immutable historical skip.
  if (disposition && Date.parse(disposition.recordedAt) >= Date.parse(run.updatedAt)) return null;
  return 'recovery-critical';
}

function queuedRunIds(root, now) {
  const ids = new Set();
  for (const request of projectScanQueue(root, now).requests) {
    if (request.claim?.runId && ['queued', 'claimed', 'legacy-claimed'].includes(request.status)) {
      ids.add(request.claim.runId);
    }
  }
  return ids;
}

function isArtifactFile(file) {
  return file.relative === 'artifacts' || file.relative.startsWith('artifacts/');
}

export function measureRunStorage(root) {
  const inventory = runInventory(root);
  const dispositions = recoveryDispositions(root);
  const now = new Date();
  let queued;
  try { queued = queuedRunIds(root, now); } catch {
    // Inventory remains available for diagnosis; ambiguous queue state protects every run.
    queued = new Set(inventory.map((run) => run.runId));
  }
  const lease = readScanLease(root);
  let runBytes = 0;
  let artifactBytes = 0;
  let artifactCount = 0;
  const critical = [];
  for (const run of inventory) {
    for (const file of run.files) {
      if (isArtifactFile(file)) {
        artifactBytes += file.size;
        artifactCount += 1;
      } else {
        runBytes += file.size;
      }
    }
    if (recoveryProtection(run, dispositions, queued, lease, now)) critical.push(run);
  }
  const queueFile = path.join(path.resolve(root), '.scout', 'scan-queue.jsonl');
  const queueFileBytes = fs.existsSync(queueFile) ? fs.statSync(queueFile).size : 0;
  let queueEvents = 0;
  if (queueFileBytes) {
    const text = fs.readFileSync(queueFile, 'utf8');
    queueEvents = text.split('\n').filter(Boolean).length;
  }
  const queueOperationRoot = path.join(path.resolve(root), '.scout', 'queue-compactions');
  let operationBytes = 0;
  let recoveryCriticalOperations = 0;
  let completedReceipts = 0;
  if (fs.existsSync(queueOperationRoot)) {
    validatePhysicalWorkspacePath(root, queueOperationRoot, 'queue compaction store');
    operationBytes = walkFiles(queueOperationRoot)
      .reduce((sum, file) => sum + file.size, 0);
    for (const name of fs.readdirSync(queueOperationRoot).sort()) {
      const manifestFile = path.join(queueOperationRoot, name, 'manifest.json');
      if (!fs.existsSync(manifestFile)) {
        recoveryCriticalOperations += 1;
        continue;
      }
      validatePhysicalWorkspacePath(root, manifestFile, 'queue compaction manifest');
      try {
        const manifest = checkedQueueOperationManifest(root, name, manifestFile);
        if (manifest.status === 'completed') completedReceipts += 1;
        else recoveryCriticalOperations += 1;
      } catch {
        recoveryCriticalOperations += 1;
      }
    }
  }
  const queueBytes = queueFileBytes + operationBytes;
  for (const name of ['recovery-selections.jsonl', 'recovery-failures.jsonl',
    'recovery-selection-compaction.json', 'run-retention.jsonl', 'run-retention-index.json']) {
    const file = path.join(path.resolve(root), '.scout', name);
    if (fs.existsSync(file)) {
      validatePhysicalWorkspacePath(root, file, 'retention diagnostic storage');
      runBytes += fs.statSync(file).size;
    }
  }
  return {
    runs: { bytes: runBytes, count: inventory.filter((run) => !run.legacyScanInput).length },
    artifacts: { bytes: artifactBytes, count: artifactCount },
    queue: {
      bytes: queueBytes,
      events: queueEvents,
      operationBytes,
      recoveryCriticalOperations,
      completedReceipts,
    },
    totalBytes: runBytes + artifactBytes + queueBytes,
    recoveryCritical: {
      count: critical.length,
      bytes: critical.reduce((sum, run) => sum + run.bytes, 0),
      runIds: critical.map((run) => run.runId).sort(),
    },
  };
}

function compactSummary(run) {
  return {
    schemaVersion: 1,
    runId: run.runId,
    updatedAt: run.updatedAt,
    outcome: run.outcome,
    completedStages: (run.manifest?.completedWork || []).map((work) => work.stageId),
    recoveryCount: Array.isArray(run.manifest?.recoveryAttempts)
      ? run.manifest.recoveryAttempts.length : 0,
  };
}

function snapshotDigest(file) {
  if (!fs.existsSync(file)) return sha256('');
  validatePhysicalWorkspacePath(path.dirname(path.dirname(file)), file, 'retention authority snapshot');
  return sha256(fs.readFileSync(file));
}

function authoritySnapshots(root) {
  const scout = path.join(path.resolve(root), '.scout');
  return {
    queueDigest: snapshotDigest(path.join(scout, 'scan-queue.jsonl')),
    recoverySelectionsDigest: snapshotDigest(path.join(scout, 'recovery-selections.jsonl')),
  };
}

function planDigest(plan) {
  return sha256(stableJson({
    schemaVersion: plan.schemaVersion,
    root: plan.root,
    generatedAt: plan.generatedAt,
    policy: plan.policy,
    candidates: plan.candidates,
    selected: plan.selected,
    refusedSelections: plan.refusedSelections,
    compactSummaries: plan.compactSummaries,
    authoritySnapshots: plan.authoritySnapshots,
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function planRunCleanup(root, inputPolicy = {}) {
  const now = checkedDate(inputPolicy.now ?? new Date(), 'retention policy time');
  const keepNewest = inputPolicy.keepNewest ?? DEFAULT_POLICY.keepNewest;
  const keepDays = inputPolicy.keepDays ?? DEFAULT_POLICY.keepDays;
  const summaryDays = inputPolicy.summaryDays ?? DEFAULT_POLICY.summaryDays;
  if (![keepNewest, keepDays, summaryDays].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('retention policy bounds must be non-negative whole numbers');
  }
  const inventory = runInventory(root, { contentDigests: true });
  const dispositions = recoveryDispositions(root);
  const queued = queuedRunIds(root, now);
  const lease = readScanLease(root);
  const ordered = [...inventory].sort((left, right) => (
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      || right.runId.localeCompare(left.runId)
  ));
  const newest = new Set([
    ...ordered.filter((run) => !run.legacyScanInput).slice(0, keepNewest),
    ...ordered.filter((run) => run.legacyScanInput).slice(0, keepNewest),
  ].map((run) => run.runId));
  const recentBoundary = now.getTime() - keepDays * DAY_MS;
  const summaryBoundary = now.getTime() - summaryDays * DAY_MS;
  const candidates = [];
  const protectedReasons = new Map();
  for (const run of inventory) {
    let reason = recoveryProtection(run, dispositions, queued, lease, now);
    const updated = Date.parse(run.updatedAt || '');
    if (!reason && newest.has(run.runId)) reason = 'newest-retained';
    if (!reason && (!Number.isFinite(updated) || updated >= recentBoundary)) reason = 'recent-retained';
    if (reason) {
      protectedReasons.set(run.runId, reason);
      continue;
    }
    candidates.push({
      runId: run.runId,
      ...(run.legacyScanInput ? { legacyScanInput: run.legacyScanInput } : {}),
      updatedAt: run.updatedAt,
      outcome: run.outcome === 'in-progress' ? dispositions.get(run.runId).outcome : run.outcome,
      bytes: run.bytes,
      digest: run.digest,
      summary: compactSummary({ ...run, outcome: run.outcome === 'in-progress' ? dispositions.get(run.runId).outcome : run.outcome }),
    });
  }
  candidates.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
    || left.runId.localeCompare(right.runId));
  const candidateById = new Map(candidates.map((candidate) => [candidate.runId, candidate]));
  const requested = [...new Set(inputPolicy.selectedRunIds || [])].sort();
  const selected = requested.map((runId) => candidateById.get(runId)).filter(Boolean);
  const refusedSelections = requested.filter((runId) => !candidateById.has(runId)).map((runId) => ({
    runId,
    reason: protectedReasons.get(runId) || 'unknown-run',
  }));
  const plan = {
    schemaVersion: 1,
    root: path.resolve(root),
    generatedAt: now.toISOString(),
    policy: { keepNewest, keepDays, summaryDays },
    candidates,
    selected,
    refusedSelections,
    compactSummaries: selected
      .filter((candidate) => Date.parse(candidate.updatedAt) >= summaryBoundary)
      .map((candidate) => candidate.summary),
    authoritySnapshots: authoritySnapshots(root),
  };
  plan.reviewedSelectionDigest = planDigest(plan);
  Object.defineProperty(plan, 'recoveryDataKey', {
    value: inputPolicy.recoveryDataKey,
    enumerable: false,
    writable: false,
  });
  return deepFreeze(plan);
}

function currentFence(lease, callback) {
  return assertCurrentFence(lease, synchronousFenceCallback(callback));
}

function checkedSelectedSources(plan) {
  const sources = [];
  for (const selected of plan.selected) {
    const directory = selectedSource(plan.root, selected);
    if (!fs.existsSync(directory)) throw new Error('selected run changed after review');
    const files = selectedFiles(plan.root, selected);
    if (digestFiles(files) !== selected.digest) throw new Error('selected run changed after review');
    sources.push({
      runId: selected.runId,
      digest: selected.digest,
      files: files.map((file) => ({
        path: file.relative,
        size: file.size,
        sha256: sha256(fs.readFileSync(file.absolute)),
        data: fs.readFileSync(file.absolute).toString('base64'),
      })),
    });
  }
  return sources;
}

function checkedCompactSummary(value) {
  const keys = ['completedStages', 'outcome', 'recoveryCount', 'runId', 'schemaVersion', 'updatedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 1
    || typeof value.runId !== 'string'
    || typeof value.updatedAt !== 'string'
    || !['complete', 'partial', 'abandoned', 'failed'].includes(value.outcome)
    || !Array.isArray(value.completedStages)
    || value.completedStages.some((stage) => typeof stage !== 'string')
    || !Number.isSafeInteger(value.recoveryCount) || value.recoveryCount < 0) {
    throw new Error('run retention summary is invalid');
  }
  return value;
}

function retentionIndexFile(root) {
  return path.join(path.resolve(root), '.scout', 'run-retention-index.json');
}

function readRetentionIndex(root) {
  const file = retentionIndexFile(root);
  if (!fs.existsSync(file)) return { schemaVersion: RETENTION_INDEX_SCHEMA_VERSION, summaries: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schemaVersion !== RETENTION_INDEX_SCHEMA_VERSION || !Array.isArray(value.summaries)) {
    throw new Error('run retention index is invalid');
  }
  value.summaries.forEach(checkedCompactSummary);
  return value;
}

function appendAudit(root, record) {
  const file = path.join(path.resolve(root), '.scout', 'run-retention.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try {
    const bytes = Buffer.from(`${stableJson(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('retention audit append made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function auditEvents(root) {
  const file = path.join(path.resolve(root), '.scout', 'run-retention.jsonl');
  if (!fs.existsSync(file)) return [];
  validatePhysicalWorkspacePath(root, file, 'retention audit');
  const contents = fs.readFileSync(file, 'utf8');
  if (contents && !contents.endsWith('\n')) throw new Error('retention audit is truncated');
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendAuditOnce(root, record) {
  const existing = auditEvents(root).find((event) => (
    event.operationId === record.operationId && event.type === record.type
  ));
  if (existing) {
    const canonical = (event) => {
      const {
        eventId: ignoredEventId,
        recordedAt: ignoredRecordedAt,
        leaseId: ignoredLeaseId,
        fencingGeneration: ignoredGeneration,
        ...durable
      } = event;
      void ignoredEventId;
      void ignoredRecordedAt;
      void ignoredLeaseId;
      void ignoredGeneration;
      return stableJson(durable);
    };
    if (canonical(existing) !== canonical(record)) throw new Error('retention audit identity conflicts');
    return existing;
  }
  appendAudit(root, record);
  return record;
}

function cleanupOperationFile(plan) {
  const operationId = sha256(`cleanup:${plan.reviewedSelectionDigest}`);
  const file = path.join(plan.root, '.scout', 'run-cleanups', operationId, 'manifest.json');
  return { operationId, file };
}

function writeCleanupOperation(root, file, manifest) {
  validatePhysicalWorkspacePath(root, file, 'cleanup operation manifest');
  atomicWriteFile(file, `${stableJson(manifest)}\n`, { mode: 0o600 });
}

function readCleanupOperation(root, file) {
  if (!fs.existsSync(file)) return null;
  validatePhysicalWorkspacePath(root, file, 'cleanup operation manifest');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['archiveFile', 'archiveId', 'operationId', 'planDigest', 'runs', 'schemaVersion', 'status'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/.test(value.operationId || '')
    || !/^[a-f0-9]{64}$/.test(value.planDigest || '')
    || !['prepared', 'archived', 'completed'].includes(value.status)
    || (value.archiveFile !== null && typeof value.archiveFile !== 'string')
    || (value.archiveId !== null && !/^[a-f0-9]{64}$/.test(value.archiveId || ''))
    || !Array.isArray(value.runs)
    || value.runs.some((run) => (
      !run || Object.keys(run).sort().join(',') !== 'digest,runId,status'
      || typeof run.runId !== 'string' || !/^[a-f0-9]{64}$/.test(run.digest || '')
      || !['pending', 'deleted'].includes(run.status)
    ))) {
    throw new Error('cleanup operation manifest is invalid');
  }
  return value;
}

function assertPlanCurrent(plan, { allowMissing = false } = {}) {
  if (planDigest(plan) !== plan.reviewedSelectionDigest) {
    throw new Error('reviewed selection changed after operator review');
  }
  const snapshots = authoritySnapshots(plan.root);
  if (stableJson(snapshots) !== stableJson(plan.authoritySnapshots)) {
    throw new Error('cleanup eligibility changed because recovery-critical durable state changed');
  }
  const current = planRunCleanup(plan.root, {
    now: new Date(plan.generatedAt),
    ...plan.policy,
    selectedRunIds: plan.selected.map((selected) => selected.runId),
    recoveryDataKey: plan.recoveryDataKey,
  });
  const eligible = new Set(current.candidates.map((candidate) => candidate.runId));
  for (const selected of plan.selected) {
    const directory = selectedSource(plan.root, selected);
    if (!fs.existsSync(directory) && allowMissing) continue;
    if (!eligible.has(selected.runId)) {
      throw new Error(`selected run became recovery-critical or otherwise ineligible: ${selected.runId}`);
    }
  }
}

function archivePayloadMatchesPlan(payload, plan) {
  if (payload.reviewedSelectionDigest !== plan.reviewedSelectionDigest) return false;
  const archived = payload.runs.map(({ runId, digest }) => ({ runId, digest }));
  const selected = plan.selected.map(({ runId, digest }) => ({ runId, digest }));
  return stableJson(archived) === stableJson(selected);
}

export function archiveSelectedRuns(plan, lease, hooks = {}) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.selected) || !plan.selected.length) {
    throw new TypeError('an explicit non-empty reviewed cleanup selection is required');
  }
  if (!Buffer.isBuffer(plan.recoveryDataKey) || plan.recoveryDataKey.length !== 32) {
    throw new Error('A protected archive sink with an unlocked recovery data key is required');
  }
  assertScanLeaseScope(lease, plan.root, lease?.runId);
  const { operationId, file: operationManifest } = cleanupOperationFile(plan);
  const completed = currentFence(lease, () => readCleanupOperation(plan.root, operationManifest));
  if (completed?.status === 'completed') {
    return completedCleanup(plan, lease, completed, operationManifest, hooks);
  }
  currentFence(lease, () => assertPlanCurrent(plan, { allowMissing: true }));
  // Prove the supplied key belongs to the persisted recovery header before
  // creating cleanup intent or touching a source.
  const persistedHeader = path.join(plan.root, '.scout-backup', 'v1', 'header.json');
  validatePhysicalWorkspacePath(plan.root, persistedHeader, 'persisted recovery authority');
  assertPersistedRecoveryDataKey(plan.root, plan.recoveryDataKey);
  let operation = currentFence(lease, () => {
    const existing = readCleanupOperation(plan.root, operationManifest);
    if (existing) {
      if (existing.operationId !== operationId
        || existing.planDigest !== plan.reviewedSelectionDigest
        || !Array.isArray(existing.runs)) throw new Error('cleanup operation manifest conflicts');
      return existing;
    }
    const created = {
      schemaVersion: 1,
      operationId,
      planDigest: plan.reviewedSelectionDigest,
      status: 'prepared',
      archiveFile: null,
      archiveId: null,
      runs: plan.selected.map(({ runId, digest }) => ({ runId, digest, status: 'pending' })),
    };
    writeCleanupOperation(plan.root, operationManifest, created);
    return created;
  });

  let payload = null;
  let written = null;
  if (operation.archiveFile) {
    const archiveFile = validatePhysicalWorkspacePath(plan.root, path.join(plan.root, operation.archiveFile), 'reviewed archive');
    payload = verifyReviewedRunArchive(archiveFile, plan.recoveryDataKey);
    if (!archivePayloadMatchesPlan(payload, plan)) throw new Error('verified archive conflicts with reviewed cleanup plan');
    written = { file: archiveFile, archiveId: payload.archiveId };
  }
  const sources = payload?.runs || currentFence(lease, () => {
    assertPlanCurrent(plan);
    return checkedSelectedSources(plan);
  });
  const archiveId = sha256(stableJson({
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runs: sources.map(({ runId, digest }) => ({ runId, digest })),
  }));
  payload ||= {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runs: sources,
  };
  written ||= writeReviewedRunArchive(
    plan.root,
    plan.recoveryDataKey,
    payload,
    {
      commitFence: (commit) => currentFence(lease, () => {
        assertPlanCurrent(plan);
        checkedSelectedSources(plan);
        return commit();
      }),
      beforeCommit: hooks.beforeArchiveCommit,
    },
  );
  const verified = verifyReviewedRunArchive(written.file, plan.recoveryDataKey);
  if (sha256(stableJson(verified)) !== sha256(stableJson(payload))) {
    throw new Error('Reviewed run archive verification failed');
  }

  operation = currentFence(lease, () => {
    const next = {
      ...operation,
      status: 'archived',
      archiveFile: path.relative(plan.root, written.file).replaceAll('\\', '/'),
      archiveId,
    };
    writeCleanupOperation(plan.root, operationManifest, next);
    return next;
  });

  const previousIndex = readRetentionIndex(plan.root);
  const summaryBoundary = Date.parse(plan.generatedAt) - plan.policy.summaryDays * DAY_MS;
  const summaries = new Map(previousIndex.summaries
    .filter((summary) => Date.parse(summary.updatedAt || '') >= summaryBoundary)
    .map((summary) => [summary.runId, summary]));
  for (const summary of plan.compactSummaries) summaries.set(summary.runId, checkedCompactSummary(summary));
  const nextIndex = {
    schemaVersion: RETENTION_INDEX_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    summaries: [...summaries.values()].sort((left, right) => (
      String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.runId.localeCompare(right.runId)
    )),
  };
  const indexFile = retentionIndexFile(plan.root);
  currentFence(lease, () => {
    assertPlanCurrent(plan, { allowMissing: true });
    validatePhysicalWorkspacePath(plan.root, indexFile, 'run retention index');
    atomicWriteFile(indexFile, `${stableJson(nextIndex)}\n`, { mode: 0o600 });
  });
  currentFence(lease, () => appendAuditOnce(plan.root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'archive-reviewed',
    operationId,
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runIds: plan.selected.map((selected) => selected.runId),
  }));

  for (const [index, selected] of plan.selected.entries()) {
    const receipt = operation.runs.find((run) => run.runId === selected.runId);
    if (receipt?.status === 'deleted') continue;
    let removedNow = false;
    currentFence(lease, () => {
      assertPlanCurrent(plan, { allowMissing: true });
      const directory = selectedSource(plan.root, selected);
      if (!fs.existsSync(directory)) return;
      if (digestFiles(selectedFiles(plan.root, selected)) !== selected.digest) {
        throw new Error('selected run changed after review');
      }
      fs.rmSync(directory, { recursive: true, force: false });
      removedNow = true;
    });
    if (removedNow && typeof hooks.afterSourceDelete === 'function') hooks.afterSourceDelete({ index, runId: selected.runId });
    operation = currentFence(lease, () => {
      assertPlanCurrent(plan, { allowMissing: true });
      const archivedRun = verified.runs.find((run) => run.runId === selected.runId && run.digest === selected.digest);
      if (!archivedRun) throw new Error('verified archive does not contain the deleted run');
      const next = {
        ...operation,
        runs: operation.runs.map((run) => (
          run.runId === selected.runId ? { ...run, status: 'deleted' } : run
        )),
      };
      writeCleanupOperation(plan.root, operationManifest, next);
      return next;
    });
  }
  currentFence(lease, () => appendAuditOnce(plan.root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'archive-completed',
    operationId,
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runIds: plan.selected.map((selected) => selected.runId),
  }));
  operation = currentFence(lease, () => {
    const next = { ...operation, status: 'completed' };
    writeCleanupOperation(plan.root, operationManifest, next);
    return next;
  });
  return completedCleanup(plan, lease, operation, operationManifest, hooks);
}

function completedCleanup(plan, lease, operation, operationManifest, hooks) {
  if (planDigest(plan) !== plan.reviewedSelectionDigest
    || operation.planDigest !== plan.reviewedSelectionDigest
    || operation.operationId !== cleanupOperationFile(plan).operationId
    || operation.runs.some((run) => run.status !== 'deleted')
    || stableJson(operation.runs.map(({ runId, digest }) => ({ runId, digest })))
      !== stableJson(plan.selected.map(({ runId, digest }) => ({ runId, digest })))) {
    throw new Error('completed cleanup conflicts with the reviewed selection');
  }
  assertPersistedRecoveryDataKey(plan.root, plan.recoveryDataKey);
  const archiveFile = validatePhysicalWorkspacePath(plan.root,
    path.join(plan.root, operation.archiveFile), 'completed reviewed archive');
  const payload = verifyReviewedRunArchive(archiveFile, plan.recoveryDataKey);
  if (!archivePayloadMatchesPlan(payload, plan) || payload.archiveId !== operation.archiveId) {
    throw new Error('completed cleanup archive conflicts with the reviewed selection');
  }
  compactRecoverySelections(plan.root, lease, {
    recoveryDataKey: plan.recoveryDataKey, afterReplace: hooks.afterSelectionReplace,
  });
  return {
    archiveFile, indexFile: retentionIndexFile(plan.root), archiveId: operation.archiveId,
    archivedRuns: operation.runs.length, operationManifest,
  };
}

function selectionCompactionFile(root) {
  return path.join(path.resolve(root), '.scout', 'recovery-selection-compaction.json');
}

function readSelectionCompaction(root) {
  const file = selectionCompactionFile(root);
  if (!fs.existsSync(file)) return null;
  validatePhysicalWorkspacePath(root, file, 'recovery selection compaction');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['afterDigest', 'archiveFile', 'archiveId', 'beforeDigest', 'operationId',
    'removedRecords', 'schemaVersion', 'status'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 1 || !['prepared', 'completed'].includes(value.status)
    || !['afterDigest', 'archiveId', 'beforeDigest', 'operationId'].every((key) => SHA256.test(value[key] || ''))
    || typeof value.archiveFile !== 'string'
    || !/^\.scout-backup\/v1\/run-archives\/[a-f0-9]{64}\.json$/.test(value.archiveFile)
    || !Number.isSafeInteger(value.removedRecords) || value.removedRecords < 1) {
    throw new Error('recovery selection compaction is invalid');
  }
  return value;
}

function finishSelectionCompaction(root, lease, operation, recoveryDataKey, afterReplace, beforeReplace) {
  const archiveFile = validatePhysicalWorkspacePath(root,
    path.join(root, operation.archiveFile), 'recovery selection archive');
  const archive = verifyReviewedRunArchive(archiveFile, recoveryDataKey);
  const files = archive.runs?.[0]?.files;
  const before = Buffer.from(files?.[0]?.data || '', 'base64').toString('utf8');
  const after = Buffer.from(files?.[1]?.data || '', 'base64').toString('utf8');
  if (archive.archiveId !== operation.archiveId || archive.reviewedSelectionDigest !== operation.operationId
    || archive.runs.length !== 1 || archive.runs[0].runId !== 'recovery-selection-history'
    || archive.runs[0].digest !== operation.beforeDigest
    || !Array.isArray(files) || files.length !== 2
    || files[0].path !== 'before.jsonl' || files[1].path !== 'after.jsonl'
    || sha256(before) !== operation.beforeDigest || sha256(after) !== operation.afterDigest
    || files[0].sha256 !== operation.beforeDigest || files[1].sha256 !== operation.afterDigest
    || files[0].size !== Buffer.byteLength(before) || files[1].size !== Buffer.byteLength(after)
    || operation.removedRecords !== before.split('\n').filter(Boolean).length - after.split('\n').filter(Boolean).length
    || operation.operationId !== sha256(stableJson({ beforeDigest: operation.beforeDigest, afterDigest: operation.afterDigest }))) {
    throw new Error('recovery selection archive conflicts with its prepared compaction');
  }
  const file = path.join(path.resolve(root), '.scout', 'recovery-selections.jsonl');
  if (typeof beforeReplace === 'function') beforeReplace();
  currentFence(lease, () => {
    validatePhysicalWorkspacePath(root, file, 'recovery selection journal');
    const current = fs.readFileSync(file, 'utf8');
    // A successor may already have appended valid selections after the crash.
    // Validate the complete journal and retain that suffix on either side of
    // the atomic replacement; unrelated replacements still fail closed.
    readRecoverySelections(root);
    if (current.startsWith(before)) {
      atomicWriteFile(file, after + current.slice(before.length), { mode: 0o600 });
    } else if (!current.startsWith(after)) {
      throw new Error('recovery selections changed during compaction');
    }
    readRecoverySelections(root);
  });
  if (typeof afterReplace === 'function') afterReplace();
  currentFence(lease, () => {
    appendAuditOnce(root, {
      schemaVersion: 1, eventId: crypto.randomUUID(), type: 'recovery-selections-compacted',
      operationId: operation.operationId, recordedAt: new Date().toISOString(),
      leaseId: lease.leaseId, fencingGeneration: lease.generation,
      archiveId: operation.archiveId, beforeDigest: operation.beforeDigest,
      afterDigest: operation.afterDigest, removedRecords: operation.removedRecords,
    });
    atomicWriteFile(selectionCompactionFile(root), `${stableJson({ ...operation, status: 'completed' })}\n`, { mode: 0o600 });
  });
  return { changed: true, removedRecords: operation.removedRecords, archiveFile };
}

export function compactRecoverySelections(root, lease, { recoveryDataKey, afterReplace, beforeReplace } = {}) {
  assertScanLeaseScope(lease, root, lease?.runId);
  currentFence(lease, () => assertPersistedRecoveryDataKey(root, recoveryDataKey));
  const pending = currentFence(lease, () => readSelectionCompaction(root));
  if (pending?.status === 'prepared') {
    return finishSelectionCompaction(root, lease, pending, recoveryDataKey, afterReplace, beforeReplace);
  }
  const records = currentFence(lease, () => readRecoverySelections(root));
  if (records.length <= RECENT_RECOVERY_SELECTIONS) return { changed: false, removedRecords: 0 };
  const currentRuns = new Set(runInventory(root).map((run) => run.runId));
  const newest = new Map();
  const terminal = new Map();
  records.forEach((record, index) => {
    if (currentRuns.has(record.selectedRunId)) newest.set(record.selectedRunId, index);
    for (const skipped of record.skipped) {
      if (currentRuns.has(skipped.runId)) {
        newest.set(skipped.runId, index);
        terminal.set(skipped.runId, index);
      }
    }
  });
  const retained = new Set([...newest.values(), ...terminal.values()]);
  for (let index = Math.max(0, records.length - RECENT_RECOVERY_SELECTIONS); index < records.length; index += 1) retained.add(index);
  const kept = records.filter((record, index) => retained.has(index));
  if (kept.length === records.length) return { changed: false, removedRecords: 0 };
  const file = path.join(path.resolve(root), '.scout', 'recovery-selections.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const after = kept.map(stableJson).join('\n') + '\n';
  const beforeDigest = sha256(before);
  const afterDigest = sha256(after);
  const operationId = sha256(stableJson({ beforeDigest, afterDigest }));
  const payload = {
    schemaVersion: 1, archiveId: operationId, reviewedSelectionDigest: operationId,
    runs: [{ runId: 'recovery-selection-history', digest: beforeDigest,
      files: [before, after].map((data, index) => ({
        path: index ? 'after.jsonl' : 'before.jsonl', size: Buffer.byteLength(data),
        sha256: sha256(data), data: Buffer.from(data).toString('base64'),
      })) }],
  };
  const archive = writeReviewedRunArchive(root, recoveryDataKey, payload, {
    commitFence: (commit) => currentFence(lease, () => {
      if (sha256(fs.readFileSync(file)) !== beforeDigest) throw new Error('recovery selections changed before compaction');
      return commit();
    }),
  });
  const operation = {
    schemaVersion: 1, status: 'prepared', operationId, beforeDigest, afterDigest,
    archiveFile: path.relative(root, archive.file).replaceAll('\\', '/'),
    archiveId: archive.archiveId, removedRecords: records.length - kept.length,
  };
  currentFence(lease, () => {
    if (sha256(fs.readFileSync(file)) !== beforeDigest) throw new Error('recovery selections changed before compaction intent');
    validatePhysicalWorkspacePath(root, selectionCompactionFile(root), 'recovery selection compaction');
    atomicWriteFile(selectionCompactionFile(root), `${stableJson(operation)}\n`, { mode: 0o600 });
  });
  return finishSelectionCompaction(root, lease, operation, recoveryDataKey, afterReplace, beforeReplace);
}

function queueEventIds(record) {
  return [
    record.request?.id,
    record.requestId,
    record.incomingRequestId,
    record.supersededRequestId,
  ].filter((value) => typeof value === 'string');
}

function queueEvents(root) {
  const file = path.join(path.resolve(root), '.scout', 'scan-queue.jsonl');
  if (!fs.existsSync(file)) return { file, events: [], contents: '' };
  validatePhysicalWorkspacePath(root, file, 'scan queue journal');
  const contents = fs.readFileSync(file, 'utf8');
  if (contents && !contents.endsWith('\n')) throw new Error('scan queue journal is truncated');
  const events = contents.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('scan queue journal is invalid');
    }
  });
  // The canonical projector performs the full schema and lifecycle validation.
  projectScanQueue(root, new Date());
  return { file, events, contents };
}

function terminalQueueTime(events, requestId) {
  const terminal = events.filter((record) => (
    (['completed', 'expired', 'stale', 'window-covered'].includes(record.type)
      && record.requestId === requestId)
    || (record.type === 'scheduled-replaced' && record.supersededRequestId === requestId)
  )).at(-1);
  return terminal ? Date.parse(terminal.at || '') : NaN;
}

function queueCompactionDirectory(root, operationId) {
  return path.join(path.resolve(root), '.scout', 'queue-compactions', operationId);
}

function checkedQueueOperationManifest(root, operationId, manifestFile) {
  validatePhysicalWorkspacePath(root, manifestFile, 'queue compaction manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const versionOneKeys = ['afterDigest', 'beforeDigest', 'operationId', 'removedEvents', 'schemaVersion', 'status'];
  const versionTwoKeys = [...versionOneKeys, 'completedAt'];
  const keys = manifest && Object.keys(manifest).sort().join(',');
  const expectedKeys = manifest?.schemaVersion === 1 ? versionOneKeys : versionTwoKeys;
  if (!manifest || keys !== expectedKeys.sort().join(',')
    || ![1, 2].includes(manifest.schemaVersion)
    || manifest.operationId !== operationId
    || !SHA256.test(manifest.operationId || '')
    || !SHA256.test(manifest.beforeDigest || '')
    || !SHA256.test(manifest.afterDigest || '')
    || !['prepared', 'completed'].includes(manifest.status)
    || !Number.isSafeInteger(manifest.removedEvents) || manifest.removedEvents < 0
    || (manifest.schemaVersion === 2
      && manifest.completedAt !== null
      && !isCanonicalIsoTimestamp(manifest.completedAt))
    || (manifest.schemaVersion === 2 && manifest.status === 'prepared' && manifest.completedAt !== null)
    || (manifest.schemaVersion === 2 && manifest.status === 'completed' && manifest.completedAt === null)) {
    throw new Error('queue compaction manifest is invalid');
  }
  return manifest;
}

function queueOperations(root) {
  const base = path.join(path.resolve(root), '.scout', 'queue-compactions');
  if (!fs.existsSync(base)) return [];
  validatePhysicalWorkspacePath(root, base, 'queue compaction store');
  return fs.readdirSync(base).sort().map((operationId) => {
    const directory = queueCompactionDirectory(root, operationId);
    validatePhysicalWorkspacePath(root, directory, 'queue compaction receipt');
    const manifestFile = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('queue compaction manifest is missing');
    return {
      directory,
      manifestFile,
      manifest: checkedQueueOperationManifest(root, operationId, manifestFile),
    };
  });
}

function checkedQueueCompactionAudit(event) {
  const keys = [
    'afterDigest', 'beforeDigest', 'eventId', 'fencingGeneration', 'leaseId',
    'operationId', 'recordedAt', 'removedEvents', 'schemaVersion', 'type',
  ];
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || Object.keys(event).sort().join(',') !== keys.sort().join(',')
    || event.schemaVersion !== 1
    || event.type !== 'queue-compacted'
    || !UUID.test(event.eventId || '')
    || !SAFE_TOKEN.test(event.leaseId || '')
    || !SHA256.test(event.operationId || '')
    || !Number.isSafeInteger(event.fencingGeneration) || event.fencingGeneration < 1
    || !isCanonicalIsoTimestamp(event.recordedAt)
    || !SHA256.test(event.beforeDigest || '')
    || !SHA256.test(event.afterDigest || '')
    || !Number.isSafeInteger(event.removedEvents) || event.removedEvents < 0) {
    throw new Error('queue compaction audit is invalid');
  }
  return event;
}

function queueCompletionAudit(manifest, events, label = 'queue compaction') {
  const matches = events.filter((event) => (
    event.operationId === manifest.operationId
  ));
  if (matches.length !== 1) {
    throw new Error(`${label} audit must be unique`);
  }
  const event = checkedQueueCompactionAudit(matches[0]);
  if (event.beforeDigest !== manifest.beforeDigest
    || event.afterDigest !== manifest.afterDigest
    || event.removedEvents !== manifest.removedEvents
    || (manifest.schemaVersion === 2
      && manifest.status === 'completed'
      && event.recordedAt !== manifest.completedAt)) {
    throw new Error(`${label} audit does not match its receipt`);
  }
  return event;
}

function legacyQueueCompletionTime(manifest, events) {
  const event = queueCompletionAudit(manifest, events, 'legacy queue compaction');
  return event.recordedAt;
}

function reduceCompletedQueueOperations(root) {
  const operations = queueOperations(root);
  const audit = auditEvents(root);
  const queueAudit = audit
    .filter((event) => event?.type === 'queue-compacted')
    .map(checkedQueueCompactionAudit);
  const completionTimes = new Map();
  for (const { manifest } of operations) {
    if (manifest.status !== 'completed') continue;
    const completedAt = manifest.schemaVersion === 1
      ? legacyQueueCompletionTime(manifest, queueAudit)
      : queueCompletionAudit(manifest, queueAudit).recordedAt;
    completionTimes.set(manifest.operationId, completedAt);
  }
  const migrations = operations
    .filter(({ manifest }) => manifest.schemaVersion === 1 && manifest.status === 'completed')
    .map((operation) => ({
      operation,
      completedAt: completionTimes.get(operation.manifest.operationId),
    }));
  for (const { operation, completedAt } of migrations) {
    const migrated = {
      ...operation.manifest,
      schemaVersion: 2,
      completedAt,
    };
    atomicWriteFile(operation.manifestFile, `${stableJson(migrated)}\n`, { mode: 0o600 });
    operation.manifest = migrated;
  }
  const completed = operations.filter(({ manifest }) => manifest.status === 'completed');
  completed.sort((left, right) => {
    const timeDifference = Date.parse(completionTimes.get(right.manifest.operationId))
      - Date.parse(completionTimes.get(left.manifest.operationId));
    return timeDifference || right.manifest.operationId.localeCompare(left.manifest.operationId);
  });
  const retained = new Set(completed.slice(0, MAX_COMPLETED_QUEUE_COMPACTION_RECEIPTS)
    .map(({ manifest }) => manifest.operationId));
  for (const operation of completed) {
    for (const snapshot of ['before.jsonl', 'after.jsonl']) {
      const file = path.join(operation.directory, snapshot);
      if (!fs.existsSync(file)) continue;
      validatePhysicalWorkspacePath(root, file, 'queue compaction snapshot');
      fs.rmSync(file);
    }
    if (!retained.has(operation.manifest.operationId)) {
      validatePhysicalWorkspacePath(root, operation.directory, 'queue compaction receipt');
      walkFiles(operation.directory);
      fs.rmSync(operation.directory, { recursive: true });
    }
  }

  const auditFile = path.join(path.resolve(root), '.scout', 'run-retention.jsonl');
  if (!fs.existsSync(auditFile)) return;
  const events = auditEvents(root);
  const kept = events.filter((event) => (
    event.type !== 'queue-compacted' || retained.has(event.operationId)
  ));
  if (kept.length !== events.length) {
    validatePhysicalWorkspacePath(root, auditFile, 'retention audit');
    const contents = kept.length ? `${kept.map(stableJson).join('\n')}\n` : '';
    atomicWriteFile(auditFile, contents, { mode: 0o600 });
  }
}

function writeQueueOperation(root, operation) {
  const directory = queueCompactionDirectory(root, operation.operationId);
  validatePhysicalWorkspacePath(root, directory, 'queue compaction snapshot');
  atomicWriteFile(path.join(directory, 'before.jsonl'), operation.beforeContents, { mode: 0o600 });
  atomicWriteFile(path.join(directory, 'after.jsonl'), operation.afterContents, { mode: 0o600 });
  const manifest = {
    schemaVersion: 2,
    operationId: operation.operationId,
    status: operation.status,
    completedAt: null,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    removedEvents: operation.removedEvents,
  };
  atomicWriteFile(path.join(directory, 'manifest.json'), `${stableJson(manifest)}\n`, { mode: 0o600 });
  return path.join(directory, 'manifest.json');
}

function completeQueueOperation(root, lease, operation, manifestFile) {
  const proposedCompletedAt = new Date().toISOString();
  const completionAudit = currentFence(lease, () => appendAuditOnce(root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    operationId: operation.operationId,
    type: 'queue-compacted',
    recordedAt: proposedCompletedAt,
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    removedEvents: operation.removedEvents,
  }));
  const completedAt = queueCompletionAudit(operation, [completionAudit]).recordedAt;
  currentFence(lease, () => {
    const completed = {
      schemaVersion: 2,
      operationId: operation.operationId,
      status: 'completed',
      completedAt,
      beforeDigest: operation.beforeDigest,
      afterDigest: operation.afterDigest,
      removedEvents: operation.removedEvents,
    };
    validatePhysicalWorkspacePath(root, manifestFile, 'queue compaction manifest');
    atomicWriteFile(manifestFile, `${stableJson(completed)}\n`, { mode: 0o600 });
    reduceCompletedQueueOperations(root);
  });
}

function reconcileQueueOperation(root, lease, currentDigest) {
  for (const { manifestFile, manifest } of queueOperations(root)) {
    if (manifest.afterDigest !== currentDigest || manifest.status === 'completed') continue;
    const afterFile = path.join(path.dirname(manifestFile), 'after.jsonl');
    validatePhysicalWorkspacePath(root, afterFile, 'queue compaction snapshot');
    const afterContents = fs.readFileSync(afterFile, 'utf8');
    if (sha256(afterContents) !== currentDigest) throw new Error('queue compaction snapshot is damaged');
    const operation = { ...manifest, afterContents, beforeContents: '' };
    completeQueueOperation(root, lease, operation, manifestFile);
    return { changed: false, reconciled: true, removedEvents: manifest.removedEvents, keptEvents: afterContents.split('\n').filter(Boolean).length };
  }
  return null;
}

function queueCleanupContents(root, now, summaryDays) {
  const snapshot = queueEvents(root);
  const projection = projectScanQueue(root, now);
  const cutoff = now.getTime() - summaryDays * DAY_MS;
  const keepIds = new Set();
  for (const request of projection.requests) {
    const expiresAt = Date.parse(request.expiresAt || '');
    const live = request.status === 'claimed' || request.status === 'legacy-claimed'
      || (request.status === 'queued' && Number.isFinite(expiresAt) && expiresAt > now.getTime());
    const terminalAt = terminalQueueTime(snapshot.events, request.id);
    if (live || (Number.isFinite(terminalAt) && terminalAt >= cutoff)) keepIds.add(request.id);
  }
  // A scheduled replacement depends on the earlier request being replayable.
  let changed;
  do {
    changed = false;
    for (const record of snapshot.events) {
      if (record.request?.id && keepIds.has(record.request.id) && record.supersededRequestId
        && !keepIds.has(record.supersededRequestId)) {
        keepIds.add(record.supersededRequestId);
        changed = true;
      }
    }
  } while (changed);
  const kept = snapshot.events.filter((record) => queueEventIds(record).some((id) => keepIds.has(id)));
  const next = kept.length ? `${kept.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  return { snapshot, kept, next };
}

export function planScanQueueCleanup(root, { now = new Date(), summaryDays = 365 } = {}) {
  now = checkedDate(now, 'queue compaction time');
  if (!Number.isSafeInteger(summaryDays) || summaryDays < 0) throw new TypeError('queue summary retention must be a non-negative whole number');
  const { snapshot, kept, next } = queueCleanupContents(root, now, summaryDays);
  return Object.freeze({
    schemaVersion: 1, generatedAt: now.toISOString(), summaryDays,
    beforeDigest: sha256(snapshot.contents), afterDigest: sha256(next),
    removedEvents: snapshot.events.length - kept.length, keptEvents: kept.length,
  });
}

export function compactScanQueue(root, lease, {
  now = new Date(),
  summaryDays = 365,
  reviewedPlan = null,
  beforeQueueReplace,
  afterQueueReplace,
} = {}) {
  now = checkedDate(now, 'queue compaction time');
  if (!Number.isSafeInteger(summaryDays) || summaryDays < 0) {
    throw new TypeError('queue summary retention must be a non-negative whole number');
  }
  assertScanLeaseScope(lease, root, lease?.runId);
  currentFence(lease, () => {
    recoverScanQueueTail(root);
    reduceCompletedQueueOperations(root);
  });
  const { snapshot, kept, next } = queueCleanupContents(root, now, summaryDays);
  if (reviewedPlan) {
    const current = {
      schemaVersion: 1, generatedAt: now.toISOString(), summaryDays,
      beforeDigest: sha256(snapshot.contents), afterDigest: sha256(next),
      removedEvents: snapshot.events.length - kept.length, keptEvents: kept.length,
    };
    // Losing scans may legitimately append compatible requests while cleanup
    // owns the lease. Bind the snapshot taken here, not only the CLI precheck.
    const resumed = reviewedPlan.schemaVersion === 1
      && current.beforeDigest === reviewedPlan.afterDigest
      && current.afterDigest === reviewedPlan.afterDigest;
    if (!resumed && stableJson(current) !== stableJson(reviewedPlan)) {
      throw new Error('Queue changed after cleanup review; generate and inspect a new plan');
    }
  }
  if (next === snapshot.contents) {
    return reconcileQueueOperation(root, lease, sha256(snapshot.contents))
      || { changed: false, removedEvents: 0, keptEvents: kept.length };
  }
  const beforeDigest = sha256(snapshot.contents);
  const afterDigest = sha256(next);
  const operationId = sha256(`queue-compaction:${beforeDigest}:${afterDigest}`);
  const operation = {
    operationId,
    status: 'prepared',
    beforeDigest,
    afterDigest,
    beforeContents: snapshot.contents,
    afterContents: next,
    removedEvents: snapshot.events.length - kept.length,
  };
  const manifestFile = currentFence(lease, () => writeQueueOperation(root, operation));
  currentFence(lease, () => {
    if (typeof beforeQueueReplace === 'function') beforeQueueReplace();
    const current = queueEvents(root);
    if (sha256(current.contents) !== beforeDigest) {
      throw new Error('scan queue changed during compaction');
    }
    validatePhysicalWorkspacePath(root, snapshot.file, 'scan queue journal');
    atomicWriteFile(snapshot.file, next, { mode: 0o600 });
  });
  if (typeof afterQueueReplace === 'function') afterQueueReplace();
  completeQueueOperation(root, lease, operation, manifestFile);
  return {
    changed: true,
    reconciled: false,
    removedEvents: snapshot.events.length - kept.length,
    keptEvents: kept.length,
  };
}

export function assertRunStorageWritable(root, policy = {}) {
  const measurement = measureRunStorage(root);
  const maximumBytes = { ...DEFAULT_MAXIMUM_BYTES, ...(policy.maximumBytes || {}) };
  const reserveBytes = Number(policy.reserveBytes ?? DEFAULT_RESERVE_BYTES);
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new TypeError('journal storage reserve must be a non-negative whole number');
  }
  const blocked = ['runs', 'artifacts', 'queue'].filter((area) => (
    measurement[area].bytes + reserveBytes >= maximumBytes[area]
  ));
  if (blocked.length) {
    const error = new Error(`Scout cannot safely journal new work: storage pressure in ${blocked.join(', ')}`);
    error.name = 'RunStoragePressureError';
    error.code = 'SCOUT_STORAGE_PRESSURE';
    error.areas = blocked;
    error.measurement = measurement;
    throw error;
  }
  return measurement;
}

export const RUN_STORAGE_MAXIMUM_BYTES = DEFAULT_MAXIMUM_BYTES;
export const RUN_STORAGE_WARNING_BYTES = DEFAULT_WARNING_BYTES;
export const RUN_STORAGE_RESERVE_BYTES = DEFAULT_RESERVE_BYTES;
