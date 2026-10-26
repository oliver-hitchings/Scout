import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  JournalCorruptionError, appendRunEvent, openRunJournal, replayRunJournal, validateRunJournal,
} from './runJournal.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from './scanLease.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
let lease;
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-journal-'));
  roots.push(root);
  lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'run-1' });
  return root;
}

const collected = {
  type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1', payload: {
    schemaVersion: 1, reference: { kind: 'source', id: 'adzuna' }, count: 2, version: { kind: 'provider', value: 'adzuna' },
  },
};
const ranked = {
  type: 'stage.completed', stageId: 'rank', idempotencyKey: 'rank-v1', payload: {
    schemaVersion: 1, reference: { kind: 'selection', id: 'vacancy-1' }, count: 1,
  },
};

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashEvent(event) {
  const { eventHash, ...envelope } = event;
  return sha256(envelope);
}

function journalReads(file, operation) {
  const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, readFile: fs.readFileSync };
  const descriptors = new Set();
  let bytes = 0;
  fs.openSync = function (target, ...args) {
    const descriptor = original.open.call(this, target, ...args);
    if (String(target) === file) descriptors.add(descriptor);
    return descriptor;
  };
  fs.closeSync = function (descriptor) {
    descriptors.delete(descriptor);
    return original.close.call(this, descriptor);
  };
  fs.readSync = function (descriptor, ...args) {
    const count = original.read.call(this, descriptor, ...args);
    if (descriptors.has(descriptor)) bytes += count;
    return count;
  };
  fs.readFileSync = function (target, ...args) {
    const result = original.readFile.call(this, target, ...args);
    if (String(target) === file || descriptors.has(target)) bytes += Buffer.byteLength(result);
    return result;
  };
  try { return { value: operation(), get bytes() { return bytes; } }; }
  finally {
    fs.openSync = original.open;
    fs.closeSync = original.close;
    fs.readSync = original.read;
    fs.readFileSync = original.readFile;
  }
}

test('warm fenced appends bound journal reads while replacements, caller mutations and interrupted writes require validation', () => {
  const root = temp();
  const journal = openRunJournal(root, 'run-1');
  const input = (index) => ({ ...collected, idempotencyKey: `synthetic-append-${index}` });
  for (let index = 0; index < 500; index += 1) appendRunEvent(journal, input(index), lease);
  const measured = journalReads(journal.file, () => {
    for (let index = 500; index < 600; index += 1) appendRunEvent(journal, input(index), lease);
  });
  assert.ok(measured.bytes <= 100 * 70 * 1024, `100 appends read ${measured.bytes} journal bytes; the bound is 7 MiB`);
  assert.ok(measured.bytes >= 100 * 64 * 1024, 'each warm append must actually verify its bounded tail');
  assert.equal(replayRunJournal(journal.file).length, 600);

  // Mutating the public projection cannot forge sequence, head or idempotency.
  journal.events = [];
  journal.lastHash = '0'.repeat(64);
  const committed = appendRunEvent(journal, input(600), lease);
  assert.equal(committed.sequence, 601);
  committed.payload.count = 999;
  assert.equal(appendRunEvent(journal, input(600), lease).payload.count, collected.payload.count);
  // Matching metadata alone is insufficient: a mismatched tail forces replay.
  const read = fs.readSync;
  let changedTail = false;
  fs.readSync = function (descriptor, buffer, offset, length, position) {
    const count = read.call(this, descriptor, buffer, offset, length, position);
    if (!changedTail && length === 64 * 1024 && count) { buffer[offset] ^= 1; changedTail = true; }
    return count;
  };
  try {
    const fallback = journalReads(journal.file, () => appendRunEvent(journal, input(600), lease));
    assert.equal(changedTail, true);
    assert.ok(fallback.bytes >= fs.statSync(journal.file).size, 'a tail mismatch must trigger full validation even when file metadata agrees');
  } finally { fs.readSync = read; }
  const forged = { ...journal, events: [], lastHash: null };
  const uncached = journalReads(journal.file, () => appendRunEvent(forged, input(601), lease));
  assert.ok(uncached.bytes >= fs.statSync(journal.file).size / 2, 'a copied handle must fully validate the durable history');
  assert.equal(uncached.value.sequence, 602);

  // A changed prefix must be checked even when the bounded tail and mtime agree.
  let original = fs.readFileSync(journal.file);
  const stat = fs.statSync(journal.file);
  const corruptPrefix = Buffer.from(original);
  const marker = corruptPrefix.indexOf(Buffer.from('"count":2'));
  assert.ok(marker >= 0 && marker < original.length - 70 * 1024);
  corruptPrefix[marker + '"count":'.length] = '3'.charCodeAt(0);
  fs.writeFileSync(journal.file, corruptPrefix);
  fs.utimesSync(journal.file, stat.atime, stat.mtime);
  assert.throws(() => appendRunEvent(journal, input(602), lease), JournalCorruptionError);
  fs.writeFileSync(journal.file, '');
  assert.throws(() => appendRunEvent(journal, input(602), lease), /committed history changed/);
  const rewritten = original.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  rewritten[0].payload.count = 7;
  let previousHash = null;
  for (const event of rewritten) {
    event.previousHash = previousHash;
    event.payloadHash = sha256(event.payload);
    event.eventHash = hashEvent(event);
    previousHash = event.eventHash;
  }
  fs.writeFileSync(journal.file, `${rewritten.map(canonicalJson).join('\n')}\n`);
  assert.equal(validateRunJournal(journal.file).events.length, 602, 'the replacement is a self-consistent full hash chain');
  assert.throws(() => appendRunEvent(journal, input(602), lease), /committed history changed/, 'a warm writer must not abandon its validated prefix for another history');
  journal.root += `${path.sep}.`;
  assert.throws(() => appendRunEvent(journal, input(602), lease), /committed history changed/, 'changing a public root spelling must not discard the private committed-prefix anchor');
  journal.root = root;
  fs.writeFileSync(journal.file, original);
  const replacement = path.join(journal.directory, 'replacement.jsonl');
  fs.writeFileSync(replacement, original);
  fs.renameSync(replacement, journal.file);
  const replaced = journalReads(journal.file, () => appendRunEvent(journal, input(602), lease));
  assert.ok(replaced.bytes >= original.length, 'same-byte replacement must fully validate the prefix');
  assert.equal(replaced.value.sequence, 603);

  // A torn write cannot reuse a warm cache, including after reopening the run.
  original = fs.readFileSync(journal.file);
  const write = fs.writeSync;
  let injected = false;
  fs.writeSync = function (descriptor, buffer, offset, length, ...args) {
    if (!injected && Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('synthetic-append-603'))) {
      injected = true;
      write.call(this, descriptor, buffer, offset, 32, ...args);
      throw new Error('synthetic interrupted append');
    }
    return write.call(this, descriptor, buffer, offset, length, ...args);
  };
  try { assert.throws(() => appendRunEvent(journal, input(603), lease), /synthetic interrupted append/); }
  finally { fs.writeSync = write; }
  assert.equal(injected, true);
  assert.equal(validateRunJournal(journal.file).truncatedTail, true);
  assert.throws(() => appendRunEvent(journal, input(603), lease), JournalCorruptionError);
  assert.throws(() => appendRunEvent(openRunJournal(root, 'run-1'), input(603), lease), JournalCorruptionError);
  fs.writeFileSync(journal.file, original);

  // Complete-but-unacknowledged writes remain idempotent after process restart.
  const sync = fs.fsyncSync;
  let journalDescriptor;
  const open = fs.openSync;
  fs.openSync = function (target, flags, ...args) {
    const descriptor = open.call(this, target, flags, ...args);
    if (String(target) === journal.file && (flags & fs.constants.O_APPEND)) journalDescriptor = descriptor;
    return descriptor;
  };
  fs.fsyncSync = function (descriptor) {
    sync.call(this, descriptor);
    if (descriptor === journalDescriptor) throw new Error('synthetic acknowledgement loss');
  };
  try { assert.throws(() => appendRunEvent(journal, input(603), lease), /synthetic acknowledgement loss/); }
  finally { fs.openSync = open; fs.fsyncSync = sync; }
  const reopened = openRunJournal(root, 'run-1');
  assert.equal(appendRunEvent(reopened, input(603), lease).sequence, 604);
  assert.equal(replayRunJournal(journal.file).length, 604);
  const before = fs.readFileSync(journal.file);
  releaseScanLease(lease);
  const successor = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'run-1' });
  try {
    assert.throws(() => appendRunEvent(reopened, input(604), lease), /lease|fence/i);
    assert.deepEqual(fs.readFileSync(journal.file), before);
    assert.equal(appendRunEvent(reopened, input(604), successor).sequence, 605);
  } finally { releaseScanLease(successor); }
});

test('appends canonical hash-chained events and replays them in sequence', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.eventHash);
  assert.equal(first.payloadHash, sha256(collected.payload));
  assert.equal(second.eventHash, hashEvent(second));
  assert.equal(fs.readFileSync(journal.file, 'utf8'), `${canonicalJson(first)}\n${canonicalJson(second)}\n`);
  assert.deepEqual(replayRunJournal(journal.file), [first, second]);
});

test('returns the committed event for a duplicate idempotency key and rejects a conflicting key', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const committed = appendRunEvent(journal, collected, lease);

  assert.deepEqual(appendRunEvent(journal, collected, lease), committed);
  assert.throws(
    () => appendRunEvent(journal, { ...collected, payload: { ...collected.payload, count: 3 } }, lease),
    /idempotency key conflicts/,
  );
});

test('keeps valid events when only the final JSONL append is truncated', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  appendRunEvent(journal, ranked, lease);
  fs.appendFileSync(journal.file, '{"schemaVersion":', 'utf8');

  const validated = validateRunJournal(journal.file);
  assert.equal(validated.events.length, 2);
  assert.equal(validated.truncatedTail, true);
});

test('fails closed when an incomplete final JSON record already has a newline delimiter', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  fs.appendFileSync(journal.file, '{"schemaVersion":\n', 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('fails closed when non-JSON whitespace appears in an unterminated final record', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  for (const value of ['{"schemaVersion":\u00a0', '\ufeff{"schemaVersion":']) {
    fs.writeFileSync(journal.file, `${fs.readFileSync(journal.file, 'utf8').split('\n')[0]}\n${value}`, 'utf8');
    assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
  }
});

test('never acknowledges an append while a truncated final record remains unresolved', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  fs.appendFileSync(journal.file, '{"schemaVersion":', 'utf8');

  assert.throws(() => appendRunEvent(journal, ranked, lease), JournalCorruptionError);
  assert.deepEqual(replayRunJournal(journal.file), [first]);
});

test('repairs a missing final record delimiter before acknowledging the next append', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  fs.writeFileSync(journal.file, fs.readFileSync(journal.file, 'utf8').trimEnd(), 'utf8');

  const second = appendRunEvent(journal, ranked, lease);
  assert.deepEqual(replayRunJournal(journal.file), [first, second]);
});

test('rejects malformed unclosed final text rather than treating it as a torn append', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  fs.appendFileSync(journal.file, 'garbage{', 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);

  fs.writeFileSync(journal.file, `${fs.readFileSync(journal.file, 'utf8').split('\n')[0]}\n{"schemaVersion":oops`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('rejects caller-defined metadata and secret-shaped bypass fields at the journal boundary', () => {
  const journal = openRunJournal(temp(), 'run-1');
  for (const property of ['apiKey', 'auth', 'session', 'code']) {
    assert.throws(() => appendRunEvent(journal, {
      ...collected, idempotencyKey: `${property}-v1`, payload: { schemaVersion: 1, metadata: { [property]: 'sk-live-secret' } },
    }, lease), /payload/i);
  }
  assert.throws(() => appendRunEvent(journal, {
    ...collected, type: 'stage.unreviewed', idempotencyKey: 'unknown-type-v1', payload: collected.payload,
  }, lease), /event type/i);
  assert.throws(() => appendRunEvent(journal, {
    ...collected, idempotencyKey: 'unknown-field-v1', payload: { ...collected.payload, note: 'not-allowed' },
  }, lease), /payload/i);
});

test('accepts only the reviewed stage-completion reference, count, version, and artifact fields', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const event = appendRunEvent(journal, {
    ...collected,
    idempotencyKey: 'artifact-v1',
    payload: {
      schemaVersion: 1,
      reference: { kind: 'stage', id: 'collect' },
      count: 2,
      version: { kind: 'pipeline', value: 'pipeline-v1' },
      artifact: { id: 'collect-v1', schemaVersion: 1, digest: 'a'.repeat(64) },
    },
  }, lease);
  assert.deepEqual(replayRunJournal(journal.file), [event]);
});

test('accepts only reviewed terminal outcome and mutation receipt event payloads', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const terminal = appendRunEvent(journal, {
    type: 'run.completed', stageId: 'finalise', idempotencyKey: 'run-complete-v1',
    payload: { schemaVersion: 1, outcome: 'complete', compatibility: { kind: 'profile', value: 'profile-v1' } },
  }, lease);
  const receipt = appendRunEvent(journal, {
    type: 'mutation.receipted', stageId: 'tracker', idempotencyKey: 'tracker-v1',
    payload: { schemaVersion: 1, reference: { kind: 'mutation', id: 'tracker-v1' }, digest: 'a'.repeat(64) },
  }, lease);

  assert.deepEqual(replayRunJournal(journal.file), [terminal, receipt]);
  assert.throws(() => appendRunEvent(journal, {
    type: 'run.completed', stageId: 'finalise', idempotencyKey: 'run-complete-v2',
    payload: { schemaVersion: 1, outcome: 'complete', compatibility: { kind: 'profile', value: 'profile-v1' }, note: 'raw content' },
  }, lease), /payload/i);
});

test('rejects terminal and receipt events when projection-required fields are absent', () => {
  const journal = openRunJournal(temp(), 'run-1');

  assert.throws(() => appendRunEvent(journal, {
    type: 'run.completed', stageId: 'finalise', idempotencyKey: 'missing-outcome-v1', payload: { schemaVersion: 1 },
  }, lease), /payload/i);
  assert.throws(() => appendRunEvent(journal, {
    type: 'mutation.receipted', stageId: 'tracker', idempotencyKey: 'missing-receipt-v1', payload: { schemaVersion: 1 },
  }, lease), /payload/i);
});

test('mutation receipts reject every non-mutation reference kind', () => {
  const journal = openRunJournal(temp(), 'run-1');
  for (const kind of ['source', 'vacancy', 'selection', 'stage', 'batch']) {
    assert.throws(() => appendRunEvent(journal, {
      type: 'mutation.receipted',
      stageId: 'finalise',
      idempotencyKey: `wrong-kind-${kind}`,
      payload: {
        schemaVersion: 1,
        reference: { kind, id: 'mutation-one' },
        digest: 'a'.repeat(64),
      },
    }, lease), /mutation reference kind/i);
  }
  assert.equal(fs.existsSync(journal.file), false);
});

test('rejects run IDs that are unsafe as Windows directory components', () => {
  for (const runId of ['run:one', 'run.', 'CON', 'lpt1']) {
    assert.throws(() => openRunJournal(temp(), runId), /run ID/i);
  }
});

test('rejects duplicate event IDs and idempotency keys in otherwise hash-valid replay history', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);
  const duplicateEventId = { ...second, eventId: first.eventId };
  duplicateEventId.eventHash = hashEvent(duplicateEventId);
  fs.writeFileSync(journal.file, `${canonicalJson(first)}\n${canonicalJson(duplicateEventId)}\n`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);

  const duplicateKey = { ...second, eventId: randomUUID(), idempotencyKey: first.idempotencyKey };
  duplicateKey.eventHash = hashEvent(duplicateKey);
  fs.writeFileSync(journal.file, `${canonicalJson(first)}\n${canonicalJson(duplicateKey)}\n`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('rejects a hash-valid event with an invalid event ID format', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);
  const invalidId = { ...second, eventId: 'event-two' };
  invalidId.eventHash = hashEvent(invalidId);
  fs.writeFileSync(journal.file, `${canonicalJson(first)}\n${canonicalJson(invalidId)}\n`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('fails closed when a complete final event has a changed event hash', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  const event = appendRunEvent(journal, ranked, lease);
  event.eventHash = '0'.repeat(64);
  fs.writeFileSync(journal.file, `${JSON.stringify(validateRunJournal(journal.file).events[0])}\n${JSON.stringify(event)}\n`, 'utf8');

  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('rejects recovery lifecycle events before they can create an invalid journal order', () => {
  let journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  assert.throws(() => appendRunEvent(journal, {
    type: 'run.started',
    stageId: 'initialise',
    idempotencyKey: 'late-start-v1',
    payload: {
      schemaVersion: 1,
      compatibility: {
        schemaVersion: 1,
        mode: 'primary',
        purpose: 'scheduled-discovery',
        profileVersion: 'profile-v1',
        sourceConfigFingerprint: 'a'.repeat(64),
        journalSchemaVersion: 1,
        artifactSchemaVersion: 1,
        pipelineVersion: 'pipeline-v1',
        rankingVersion: 'ranking-v1',
        promptVersion: 'prompt-v1',
        assessmentSchemaVersion: 1,
        provider: 'codex',
        model: 'gpt-5',
        mutationSchemaVersion: 1,
        targetRevision: 'tracker-v1',
      },
    },
  }, lease), /first event/i);
  assert.deepEqual(replayRunJournal(journal.file), [journal.events[0]]);

  journal = openRunJournal(temp(), 'run-1');
  assert.throws(() => appendRunEvent(journal, {
    type: 'recovery.stage-decided',
    stageId: 'collect',
    idempotencyKey: 'early-recovery-v1',
    payload: { schemaVersion: 1, action: 'reuse', reason: 'compatible' },
  }, lease), /run start/i);
  assert.equal(fs.existsSync(journal.file), false);
});
