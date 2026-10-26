import { isSafeModelId } from './modelIdentifier.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LeaseLostError, assertCurrentFence, assertScanLeaseScope, isScanLease,
  synchronousFenceCallback,
} from './scanLease.mjs';
import { workspacePaths } from './workspace.mjs';

export const RUN_JOURNAL_SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_METADATA_STRING_LENGTH = 128;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPEND_TAIL_BYTES = 64 * 1024;
// Only this module can mint an append snapshot. Public handle fields and
// returned events are never authority for the cached prefix or its tail.
const appendStates = new WeakMap();
const STAMP_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];
const WINDOWS_RESERVED_RUN_IDS = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]);
const EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  'run.started': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'compatibility'])),
      required: Object.freeze(new Set(['schemaVersion', 'compatibility'])),
    }),
  }),
  'stage.completed': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'count', 'version', 'artifact'])),
      required: Object.freeze(new Set(['schemaVersion'])),
    }),
  }),
  'run.completed': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'outcome', 'compatibility'])),
      required: Object.freeze(new Set(['schemaVersion', 'outcome'])),
    }),
  }),
  'run.failure-recorded': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'code', 'reason'])),
      required: Object.freeze(new Set(['schemaVersion', 'code', 'reason'])),
    }),
  }),
  'mutation.receipted': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'digest'])),
      required: Object.freeze(new Set(['schemaVersion', 'reference', 'digest'])),
    }),
  }),
  'mutation.prepared': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'digest', 'targetRevision'])),
      required: Object.freeze(new Set(['schemaVersion', 'reference', 'digest', 'targetRevision'])),
    }),
  }),
  'assessment.batch-attempted': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'count', 'attempt', 'artifact'])),
      required: Object.freeze(new Set(['schemaVersion', 'reference', 'count', 'attempt', 'artifact'])),
    }),
  }),
  'assessment.job-completed': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'artifact'])),
      required: Object.freeze(new Set(['schemaVersion', 'reference', 'artifact'])),
    }),
  }),
  'assessment.job-failed': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'artifact'])),
      required: Object.freeze(new Set(['schemaVersion', 'reference', 'artifact'])),
    }),
  }),
  'assessment.batch-completed': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'reference', 'count', 'artifact'])),
      required: Object.freeze(new Set(['schemaVersion', 'reference', 'count', 'artifact'])),
    }),
  }),
  'recovery.stage-decided': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set(['schemaVersion', 'action', 'reason', 'artifact'])),
      required: Object.freeze(new Set(['schemaVersion', 'action', 'reason'])),
    }),
  }),
  'recovery.started': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set([
        'schemaVersion', 'compatibility', 'requestFingerprint', 'selectionFingerprint',
      ])),
      required: Object.freeze(new Set([
        'schemaVersion', 'compatibility', 'requestFingerprint', 'selectionFingerprint',
      ])),
    }),
    2: Object.freeze({
      allowed: Object.freeze(new Set([
        'schemaVersion', 'compatibility', 'requestFingerprint', 'selectionFingerprint',
        'providerSubstitution', 'decisions',
      ])),
      required: Object.freeze(new Set([
        'schemaVersion', 'compatibility', 'requestFingerprint', 'selectionFingerprint',
        'providerSubstitution', 'decisions',
      ])),
    }),
  }),
  'recovery.provider-substituted': Object.freeze({
    1: Object.freeze({
      allowed: Object.freeze(new Set([
        'schemaVersion', 'previousProvider', 'previousModel', 'nextProvider', 'nextModel',
      ])),
      required: Object.freeze(new Set([
        'schemaVersion', 'previousProvider', 'previousModel', 'nextProvider', 'nextModel',
      ])),
    }),
  }),
});
const REFERENCE_KINDS = new Set(['source', 'vacancy', 'selection', 'stage', 'batch', 'mutation']);
const VERSION_KINDS = new Set(['provider', 'model', 'pipeline', 'profile', 'configuration', 'prompt', 'schema']);
const RUN_OUTCOMES = new Set(['complete', 'partial', 'abandoned', 'failed']);
const RECOVERY_ACTIONS = new Set(['reuse', 'restart']);
const RECOVERY_REASONS = new Set([
  'compatible',
  'artifact-reference-missing',
  'ranking-version-mismatch',
  'prompt-version-mismatch',
  'assessment-schema-version-mismatch',
  'provider-substituted',
  'upstream-stage-restarted',
  'mutation-schema-version-mismatch',
  'target-revision-mismatch',
  'stage-artifact-schema-mismatch',
  'schedule-job-mismatch',
  'logical-window-mismatch',
  'lane-plan-generation-mismatch',
  'lane-plan-revision-mismatch',
  'lane-selection-mismatch',
]);
const RECOVERY_COMPATIBILITY_FIELDS = Object.freeze([
  'artifactSchemaVersion',
  'assessmentSchemaVersion',
  'journalSchemaVersion',
  'mode',
  'model',
  'mutationSchemaVersion',
  'pipelineVersion',
  'profileVersion',
  'promptVersion',
  'provider',
  'purpose',
  'rankingVersion',
  'schemaVersion',
  'sourceConfigFingerprint',
  'targetRevision',
]);
const RECOVERY_COMPATIBILITY_FIELDS_V2 = Object.freeze([
  ...RECOVERY_COMPATIBILITY_FIELDS,
  'logicalWindowId',
  'scheduleJobId',
  'stageArtifactSchemaVersion',
]);
const RECOVERY_COMPATIBILITY_FIELDS_V3 = Object.freeze([
  ...RECOVERY_COMPATIBILITY_FIELDS_V2,
  'lanePlanGeneration',
  'lanePlanRevision',
  'laneSelectionFingerprint',
]);

export class JournalCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('journal values must be finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('journal values must be plain JSON objects');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function requireText(value, name, ErrorType = TypeError) {
  if (typeof value !== 'string' || !value.trim()) throw new ErrorType(`journal ${name} is required`);
  return value;
}

function requireSafeToken(value, name, ErrorType = TypeError) {
  const token = requireText(value, name, ErrorType);
  if (token.length > MAX_METADATA_STRING_LENGTH || !SAFE_TOKEN.test(token)) {
    throw new ErrorType(`journal ${name} must be a bounded identifier`);
  }
  return token;
}

function requirePlainObject(value, name, ErrorType) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ErrorType(`journal payload ${name} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expected, name, ErrorType) {
  const actual = Object.keys(requirePlainObject(value, name, ErrorType)).sort();
  if (actual.join(',') !== [...expected].sort().join(',')) throw new ErrorType(`journal payload ${name} is invalid`);
  return value;
}

function validateReference(value, ErrorType) {
  const reference = requireExactKeys(value, ['id', 'kind'], 'reference', ErrorType);
  if (!REFERENCE_KINDS.has(reference.kind)) throw new ErrorType('journal payload reference kind is invalid');
  try {
    requireSafeToken(reference.id, 'reference ID', ErrorType);
  } catch {
    throw new ErrorType('journal payload reference ID is invalid');
  }
}

function validateVersion(value, ErrorType) {
  const version = requireExactKeys(value, ['kind', 'value'], 'version', ErrorType);
  if (!VERSION_KINDS.has(version.kind)) throw new ErrorType('journal payload version kind is invalid');
  try {
    if (version.kind === 'model') {
      if (!isSafeModelId(version.value)) throw new ErrorType('journal model version is invalid');
    } else requireSafeToken(version.value, 'version value', ErrorType);
  } catch {
    throw new ErrorType('journal payload version value is invalid');
  }
}

function validateArtifactReference(value, ErrorType) {
  const artifact = requireExactKeys(value, ['digest', 'id', 'schemaVersion'], 'artifact', ErrorType);
  try {
    requireSafeToken(artifact.id, 'artifact ID', ErrorType);
  } catch {
    throw new ErrorType('journal payload artifact ID is invalid');
  }
  if (!Number.isSafeInteger(artifact.schemaVersion) || artifact.schemaVersion < 1 || typeof artifact.digest !== 'string' || !SHA256.test(artifact.digest)) {
    throw new ErrorType('journal payload artifact is invalid');
  }
}

function validateRecoveryCompatibility(value, ErrorType) {
  const compatibility = requireExactKeys(
    value,
    value?.schemaVersion === 3
      ? RECOVERY_COMPATIBILITY_FIELDS_V3
      : value?.schemaVersion === 2 ? RECOVERY_COMPATIBILITY_FIELDS_V2 : RECOVERY_COMPATIBILITY_FIELDS,
    'compatibility',
    ErrorType,
  );
  if (![1, 2, 3].includes(compatibility.schemaVersion)) throw new ErrorType('unsupported journal recovery compatibility schema');
  for (const key of [
    'artifactSchemaVersion', 'assessmentSchemaVersion', 'journalSchemaVersion', 'mutationSchemaVersion',
    ...(compatibility.schemaVersion >= 2 ? ['stageArtifactSchemaVersion'] : []),
  ]) {
    if (!Number.isSafeInteger(compatibility[key]) || compatibility[key] < 1) {
      throw new ErrorType(`journal recovery compatibility ${key} is invalid`);
    }
  }
  for (const key of [
    'mode', 'model', 'pipelineVersion', 'profileVersion', 'promptVersion',
    'provider', 'purpose', 'rankingVersion', 'targetRevision',
    ...(compatibility.schemaVersion >= 2 ? ['scheduleJobId', 'logicalWindowId'] : []),
    ...(compatibility.schemaVersion >= 3 ? ['lanePlanGeneration'] : []),
  ]) {
    if (key === 'model') {
      if (!isSafeModelId(compatibility[key])) throw new ErrorType('journal recovery model is invalid');
    } else requireSafeToken(compatibility[key], `recovery compatibility ${key}`, ErrorType);
  }
  if (typeof compatibility.sourceConfigFingerprint !== 'string' || !SHA256.test(compatibility.sourceConfigFingerprint)) {
    throw new ErrorType('journal recovery compatibility source/config fingerprint is invalid');
  }
  for (const key of compatibility.schemaVersion >= 3
    ? ['lanePlanRevision', 'laneSelectionFingerprint'] : []) {
    if (typeof compatibility[key] !== 'string' || !SHA256.test(compatibility[key])) {
      throw new ErrorType(`journal recovery compatibility ${key} is invalid`);
    }
  }
}

function validatePayload(type, payload, ErrorType = TypeError) {
  const value = requirePlainObject(payload, 'payload', ErrorType);
  const schema = EVENT_PAYLOAD_SCHEMAS[type]?.[value.schemaVersion];
  if (!schema) throw new ErrorType(`unsupported journal payload schema for event type: ${type}`);
  for (const key of Object.keys(value)) {
    if (!schema.allowed.has(key)) throw new ErrorType(`journal payload property is not allowed: ${key}`);
  }
  for (const key of schema.required) {
    if (value[key] === undefined) throw new ErrorType(`journal payload property is required: ${key}`);
  }
  if (value.reference !== undefined) validateReference(value.reference, ErrorType);
  if (type.startsWith('mutation.') && value.reference?.kind !== 'mutation') {
    throw new ErrorType('journal mutation reference kind must be mutation');
  }
  if (value.count !== undefined && (!Number.isSafeInteger(value.count) || value.count < 0)) throw new ErrorType('journal payload count must be a non-negative whole number');
  if (value.version !== undefined) validateVersion(value.version, ErrorType);
  if (value.artifact !== undefined) validateArtifactReference(value.artifact, ErrorType);
  if (value.compatibility !== undefined) {
    if (type === 'run.started' || type === 'recovery.started') {
      validateRecoveryCompatibility(value.compatibility, ErrorType);
    }
    else validateVersion(value.compatibility, ErrorType);
  }
  if (value.outcome !== undefined && !RUN_OUTCOMES.has(value.outcome)) throw new ErrorType('journal payload outcome is invalid');
  if (value.digest !== undefined && (typeof value.digest !== 'string' || !SHA256.test(value.digest))) throw new ErrorType('journal payload digest is invalid');
  if (value.targetRevision !== undefined && (typeof value.targetRevision !== 'string' || !SHA256.test(value.targetRevision))) {
    throw new ErrorType('journal payload target revision is invalid');
  }
  if (value.attempt !== undefined) requireSafeToken(value.attempt, 'assessment attempt', ErrorType);
  if (type === 'run.failure-recorded') {
    requireSafeToken(value.code, 'failure code', ErrorType);
    requireSafeToken(value.reason, 'failure reason', ErrorType);
  }
  if (type === 'recovery.stage-decided') {
    if (!RECOVERY_ACTIONS.has(value.action)) throw new ErrorType('journal recovery action is invalid');
    if (!RECOVERY_REASONS.has(value.reason)) throw new ErrorType('journal recovery reason is invalid');
    if (value.action === 'reuse' && value.reason !== 'compatible') throw new ErrorType('journal recovery reuse reason is invalid');
    if (value.action === 'restart' && value.reason === 'compatible') throw new ErrorType('journal recovery restart reason is invalid');
  }
  if (type === 'recovery.provider-substituted') {
    for (const key of ['previousProvider', 'previousModel', 'nextProvider', 'nextModel']) {
      if (key.endsWith('Model')) {
        if (!isSafeModelId(value[key])) throw new ErrorType('journal recovery substitution model is invalid');
      } else requireSafeToken(value[key], `recovery substitution ${key}`, ErrorType);
    }
    if (value.previousProvider === value.nextProvider && value.previousModel === value.nextModel) {
      throw new ErrorType('journal recovery substitution does not change provenance');
    }
  }
  if (type === 'recovery.started') {
    for (const key of ['requestFingerprint', 'selectionFingerprint']) {
      if (typeof value[key] !== 'string' || !SHA256.test(value[key])) {
        throw new ErrorType(`journal recovery ${key} is invalid`);
      }
    }
    if (value.schemaVersion === 2) {
      if (value.providerSubstitution !== null) {
        validatePayload('recovery.provider-substituted', {
          schemaVersion: 1,
          ...requirePlainObject(value.providerSubstitution, 'recovery provider substitution', ErrorType),
        }, ErrorType);
      }
      if (!Array.isArray(value.decisions)) throw new ErrorType('journal recovery decisions are invalid');
      const stages = new Set();
      for (const decision of value.decisions) {
        const checked = requirePlainObject(decision, 'recovery decision', ErrorType);
        const { stageId, ...payload } = checked;
        requireSafeToken(stageId, 'recovery decision stage ID', ErrorType);
        if (stages.has(stageId)) throw new ErrorType('journal recovery decision stage is duplicated');
        stages.add(stageId);
        validatePayload('recovery.stage-decided', { schemaVersion: 1, ...payload }, ErrorType);
      }
    }
  }
  let encoded;
  try {
    encoded = stableJson(payload);
  } catch (error) {
    throw new ErrorType(error.message);
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) throw new ErrorType('journal payload exceeds the 16 KiB limit');
  return encoded;
}

function envelopeHash(event) {
  const { eventHash, ...envelope } = event;
  return sha256(envelope);
}

export function isIncompleteJson(value) {
  let index = 0;
  const skipWhitespace = () => { while ([' ', '\t', '\r', '\n'].includes(value[index])) index += 1; };
  const parseString = () => {
    index += 1;
    while (index < value.length) {
      const character = value[index++];
      if (character === '"') return true;
      if (character < ' ') return false;
      if (character !== '\\') continue;
      if (index === value.length) return null;
      const escaped = value[index++];
      if ('"\\/bfnrt'.includes(escaped)) continue;
      if (escaped !== 'u') return false;
      for (let digits = 0; digits < 4; digits += 1) {
        if (index === value.length) return null;
        if (!/[0-9a-f]/i.test(value[index++])) return false;
      }
    }
    return null;
  };
  const parseLiteral = (literal) => {
    for (let offset = 0; offset < literal.length; offset += 1) {
      if (index + offset === value.length) return null;
      if (value[index + offset] !== literal[offset]) return false;
    }
    index += literal.length;
    return true;
  };
  const parseNumber = () => {
    if (value[index] === '-') {
      index += 1;
      if (index === value.length) return null;
    }
    if (value[index] === '0') {
      index += 1;
      if (/\d/.test(value[index] || '')) return false;
    } else if (/[1-9]/.test(value[index] || '')) {
      while (/\d/.test(value[index] || '')) index += 1;
    } else return false;
    if (value[index] === '.') {
      index += 1;
      if (index === value.length) return null;
      if (!/\d/.test(value[index])) return false;
      while (/\d/.test(value[index] || '')) index += 1;
    }
    if (value[index] === 'e' || value[index] === 'E') {
      index += 1;
      if (index === value.length) return null;
      if (value[index] === '+' || value[index] === '-') {
        index += 1;
        if (index === value.length) return null;
      }
      if (!/\d/.test(value[index])) return false;
      while (/\d/.test(value[index] || '')) index += 1;
    }
    return true;
  };
  const parseValue = () => {
    skipWhitespace();
    if (index === value.length) return null;
    if (value[index] === '{') return parseObject();
    if (value[index] === '[') return parseArray();
    if (value[index] === '"') return parseString();
    if (value[index] === 't') return parseLiteral('true');
    if (value[index] === 'f') return parseLiteral('false');
    if (value[index] === 'n') return parseLiteral('null');
    return parseNumber();
  };
  const parseObject = () => {
    index += 1;
    skipWhitespace();
    if (index === value.length) return null;
    if (value[index] === '}') { index += 1; return true; }
    while (true) {
      if (value[index] !== '"') return false;
      const property = parseString();
      if (property !== true) return property;
      skipWhitespace();
      if (index === value.length) return null;
      if (value[index++] !== ':') return false;
      const nested = parseValue();
      if (nested !== true) return nested;
      skipWhitespace();
      if (index === value.length) return null;
      if (value[index] === '}') { index += 1; return true; }
      if (value[index++] !== ',') return false;
      skipWhitespace();
      if (index === value.length) return null;
    }
  };
  const parseArray = () => {
    index += 1;
    skipWhitespace();
    if (index === value.length) return null;
    if (value[index] === ']') { index += 1; return true; }
    while (true) {
      const nested = parseValue();
      if (nested !== true) return nested;
      skipWhitespace();
      if (index === value.length) return null;
      if (value[index] === ']') { index += 1; return true; }
      if (value[index++] !== ',') return false;
      skipWhitespace();
      if (index === value.length) return null;
    }
  };
  const result = parseValue();
  if (result !== true) return result === null;
  skipWhitespace();
  return false;
}

function corrupt(message) {
  return new JournalCorruptionError(message);
}

function validateEvent(event, { runId, sequence, previousHash }) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw corrupt('journal event must be an object');
  if (event.schemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) throw corrupt(`unsupported journal schema version: ${event.schemaVersion}`);
  if (runId !== null && event.runId !== runId) throw corrupt('journal run ID changed');
  requireRunId(event.runId, JournalCorruptionError);
  if (event.sequence !== sequence) throw corrupt(`journal sequence must be ${sequence}`);
  if (typeof event.eventId !== 'string' || !UUID.test(event.eventId)) throw corrupt('journal event ID is invalid');
  requireSafeToken(event.type, 'event type', JournalCorruptionError);
  requireSafeToken(event.stageId, 'stage ID', JournalCorruptionError);
  requireSafeToken(event.idempotencyKey, 'idempotency key', JournalCorruptionError);
  requireSafeToken(event.leaseId, 'lease ID', JournalCorruptionError);
  if (!Number.isInteger(event.fencingGeneration) || event.fencingGeneration < 1) throw corrupt('journal fencing generation must be a positive integer');
  if (typeof event.recordedAt !== 'string' || Number.isNaN(Date.parse(event.recordedAt)) || !event.recordedAt.endsWith('Z')) throw corrupt('journal recordedAt must be a UTC timestamp');
  validatePayload(event.type, event.payload, JournalCorruptionError);
  if (event.payloadHash !== sha256(event.payload)) throw corrupt('journal payload hash is invalid');
  if (event.previousHash !== previousHash) throw corrupt('journal previous hash is invalid');
  if (typeof event.eventHash !== 'string' || !/^[a-f0-9]{64}$/.test(event.eventHash)) throw corrupt('journal event hash is invalid');
  if (event.eventHash !== envelopeHash(event)) throw corrupt('journal event hash is invalid');
}

function validateJournalContents(contents) {
  if (!contents) return { events: [], lastHash: null, truncatedTail: false };
  const finalRecordTerminated = contents.endsWith('\n');
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  let previousHash = null;
  let runId = null;
  let truncatedTail = false;
  const eventIds = new Set();
  const idempotencyKeys = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const finalLine = index === lines.length - 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (finalLine && !finalRecordTerminated && isIncompleteJson(line)) {
        truncatedTail = true;
        break;
      }
      throw corrupt(`journal entry ${index + 1} is invalid JSON`);
    }
    validateEvent(event, { runId, sequence: index + 1, previousHash });
    if (event.type === 'run.started' && index !== 0) throw corrupt('journal run start must be the first event');
    if (event.type.startsWith('recovery.') && !events.some((candidate) => candidate.type === 'run.started')) {
      throw corrupt('journal recovery event requires a versioned run start');
    }
    if (eventIds.has(event.eventId)) throw corrupt('journal event ID is duplicated');
    if (idempotencyKeys.has(event.idempotencyKey)) throw corrupt('journal idempotency key is duplicated');
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);
    runId = event.runId;
    previousHash = event.eventHash;
    events.push(event);
  }
  return { events, lastHash: previousHash, truncatedTail };
}

export function validateRunJournal(file) {
  if (!fs.existsSync(file)) return { events: [], lastHash: null, truncatedTail: false };
  return validateJournalContents(fs.readFileSync(file, 'utf8'));
}

export function replayRunJournal(file) {
  return validateRunJournal(file).events;
}

function requireRunId(runId, ErrorType = TypeError) {
  const value = requireText(runId, 'run ID', ErrorType);
  if (!SAFE_RUN_ID.test(value) || WINDOWS_RESERVED_RUN_IDS.has(value.toUpperCase())) throw new ErrorType('journal run ID is invalid');
  return value;
}

function safeRunId(runId) {
  return requireRunId(runId);
}

export function openRunJournal(root, runId) {
  const directory = path.join(workspacePaths(root).runs, safeRunId(runId));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'journal.jsonl');
  const state = readFullAppendState(file);
  if (state.events.length && state.events[0].runId !== runId) throw corrupt('journal run ID does not match its directory');
  const handle = { root: path.resolve(root), runId, directory, file, events: [...state.events], lastHash: state.lastHash };
  appendStates.set(handle, { ...state, location: journalLocation(handle) });
  return handle;
}

function sameIdempotentInput(event, input) {
  return event.type === input.type
    && event.stageId === input.stageId
    && stableJson(event.payload) === stableJson(input.payload);
}

function journalLocation(handle) {
  return { root: handle.root, runId: handle.runId, directory: handle.directory, file: handle.file };
}

function sameStamp(left, right) {
  if (!left || !right) return left === right;
  return STAMP_FIELDS.every((field) => typeof left[field] === 'bigint' && left[field] === right[field]);
}

function fileStamp(file) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) throw corrupt('journal must be a regular file');
  return stat;
}

function immutableEvent(value) {
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') immutableEvent(item);
  }
  return Object.freeze(value);
}

function appendState(state, stamp, tail, terminated) {
  const events = state.events.map(immutableEvent);
  return {
    ...state, events, stamp, tail, terminated,
    keys: new Map(events.map((event) => [event.idempotencyKey, event])),
    eventIds: new Set(events.map((event) => event.eventId)),
    started: events.some((event) => event.type === 'run.started'),
  };
}

function readFullAppendState(file) {
  const expected = fileStamp(file);
  if (!expected) return appendState({ events: [], lastHash: null, truncatedTail: false }, null, Buffer.alloc(0), true);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStamp(expected, before)) throw corrupt('journal changed during validation');
    const bytes = fs.readFileSync(descriptor);
    const state = validateJournalContents(bytes.toString('utf8'));
    if (!sameStamp(before, fs.fstatSync(descriptor, { bigint: true })) || !sameStamp(before, fileStamp(file))) {
      throw corrupt('journal changed during validation');
    }
    return appendState(state, before, Buffer.from(bytes.subarray(-APPEND_TAIL_BYTES)), !bytes.length || bytes.at(-1) === 0x0a);
  } finally { fs.closeSync(descriptor); }
}

function verifiedCachedTail(file, cached) {
  if (!sameStamp(cached.stamp, fileStamp(file))) return false;
  if (!cached.stamp) return true;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameStamp(cached.stamp, fs.fstatSync(descriptor, { bigint: true }))) return false;
    const bytes = Buffer.alloc(cached.tail.length);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, Number(cached.stamp.size) - bytes.length + offset);
      if (!count) return false;
      offset += count;
    }
    return bytes.equals(cached.tail)
      && sameStamp(cached.stamp, fs.fstatSync(descriptor, { bigint: true }))
      && sameStamp(cached.stamp, fileStamp(file));
  } finally { fs.closeSync(descriptor); }
}

function requireCommittedPrefix(previous, current) {
  if (previous && previous.events.some((event, index) => current.events[index]?.eventHash !== event.eventHash)) {
    throw corrupt('journal committed history changed');
  }
  return current;
}

function stateForAppend(handle, location) {
  const candidate = appendStates.get(handle);
  const cached = candidate && Object.keys(location).every((key) => candidate.location[key] === location[key]) ? candidate : null;
  if (cached && !cached.invalidated && verifiedCachedTail(location.file, cached)) return cached;
  // Public path spelling may disable reuse, but cannot erase a minted
  // handle's independently known committed prefix.
  return requireCommittedPrefix(candidate, readFullAppendState(location.file));
}

function appendSynced(file, bytes, expected) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if ((expected ? !sameStamp(expected, before) : before.size !== 0n) || !sameStamp(before, fileStamp(file))) {
      throw corrupt('journal changed before append');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('journal append made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (after.size !== before.size + BigInt(bytes.length)) throw corrupt('journal changed during append');
    return after;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function appendRunEvent(handle, input, lease) {
  if (!handle || typeof handle !== 'object') throw new TypeError('journal handle is required');
  if (!input || typeof input !== 'object') throw new TypeError('journal event input is required');
  const type = requireSafeToken(input.type, 'event type');
  const stageId = requireSafeToken(input.stageId, 'stage ID');
  const idempotencyKey = requireSafeToken(input.idempotencyKey, 'idempotency key');
  const payload = JSON.parse(validatePayload(type, input.payload));
  const location = journalLocation(handle);
  const leaseId = requireSafeToken(lease?.leaseId, 'lease ID');
  if (!Number.isInteger(lease?.generation) || lease.generation < 1) throw new TypeError('journal lease generation must be a positive integer');

  const commit = () => {
    assertScanLeaseScope(lease, location.root, location.runId, location.directory, location.file);
    const state = stateForAppend(handle, location);
    if (state.events.length && state.events[0].runId !== location.runId) throw corrupt('journal run ID does not match its directory');
    if (state.truncatedTail) throw corrupt('journal has an unresolved truncated final entry');
    const existing = state.keys.get(idempotencyKey);
    if (existing) {
      if (sameIdempotentInput(existing, { type, stageId, payload })) return structuredClone(existing);
      throw new Error(`journal idempotency key conflicts: ${idempotencyKey}`);
    }
    if (type === 'run.started' && state.events.length !== 0) {
      throw new Error('journal run start must be the first event');
    }
    if (type.startsWith('recovery.') && !state.started) {
      throw new Error('journal recovery event requires a versioned run start');
    }

    const event = {
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
      runId: location.runId,
      sequence: state.events.length + 1,
      eventId: randomUUID(),
      type,
      recordedAt: new Date().toISOString(),
      leaseId,
      fencingGeneration: lease.generation,
      stageId,
      idempotencyKey,
      previousHash: state.lastHash,
      payloadHash: sha256(payload),
      payload,
    };
    if (state.eventIds.has(event.eventId)) throw corrupt('journal event ID is duplicated');
    event.eventHash = envelopeHash(event);
    const bytes = Buffer.from(`${state.terminated ? '' : '\n'}${stableJson(event)}\n`, 'utf8');
    // A partial write or failed acknowledgement must force full replay next time.
    appendStates.set(handle, { ...state, location, invalidated: true });
    const stamp = appendSynced(location.file, bytes, state.stamp);
    const privateEvent = immutableEvent(structuredClone(event));
    let next = {
      ...state, location, stamp,
      events: [...state.events, privateEvent],
      keys: new Map(state.keys).set(idempotencyKey, privateEvent),
      eventIds: new Set(state.eventIds).add(event.eventId),
      lastHash: event.eventHash,
      tail: Buffer.from(Buffer.concat([state.tail, bytes]).subarray(-APPEND_TAIL_BYTES)),
      terminated: true,
      started: state.started || type === 'run.started',
      invalidated: false,
    };
    if (!sameStamp(stamp, fileStamp(location.file))) next = { ...requireCommittedPrefix(next, readFullAppendState(location.file)), location };
    appendStates.set(handle, next);
    handle.events = [...next.events];
    handle.lastHash = event.eventHash;
    return event;
  };

  if (!isScanLease(lease)) throw new LeaseLostError('a genuine current scan lease is required to append');
  assertScanLeaseScope(lease, location.root, location.runId, location.directory, location.file);
  return assertCurrentFence(lease, synchronousFenceCallback(commit));
}
