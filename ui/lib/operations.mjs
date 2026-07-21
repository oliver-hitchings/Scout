import crypto from 'node:crypto';

const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['succeeded', 'failed']);

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error || 'operation failed');
  return message.replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, '[local path]')
    .replace(/(?:\/[A-Za-z0-9._ -]+){2,}/g, '[local path]')
    .replace(/\s{2,}/g, ' ').trim().slice(0, 500) || 'operation failed';
}

function clone(record) {
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

export class OperationConflictError extends Error {
  constructor(type, operation) {
    super(`a ${type} operation is already running`);
    this.name = 'OperationConflictError';
    this.code = 'OPERATION_ACTIVE';
    this.operation = operation;
  }
}

export class OperationManager {
  constructor({ now = () => new Date(), id = () => crypto.randomUUID() } = {}) {
    this.now = now;
    this.id = id;
    this.records = new Map();
  }

  get(operationId) { return clone(this.records.get(operationId)); }

  latest(type) {
    return clone([...this.records.values()].filter((record) => !type || record.type === type).at(-1));
  }

  list(type) {
    return [...this.records.values()].filter((record) => !type || record.type === type).map(clone);
  }

  active(type) {
    return clone([...this.records.values()].findLast((record) => record.type === type && ACTIVE.has(record.status)));
  }

  start(type, executor, { phase = 'Queued', total = 1 } = {}) {
    const active = this.active(type);
    if (active) throw new OperationConflictError(type, active);
    const timestamp = this.now().toISOString();
    const record = {
      id: this.id(), type, status: 'queued', phase,
      progress: { current: 0, total: Math.max(1, Number(total) || 1) },
      startedAt: timestamp, updatedAt: timestamp, finishedAt: null,
      result: null, error: null,
    };
    this.records.set(record.id, record);

    setImmediate(async () => {
      record.status = 'running';
      record.updatedAt = this.now().toISOString();
      const update = ({ phase: nextPhase, current, total: nextTotal } = {}) => {
        if (nextPhase) record.phase = String(nextPhase);
        if (Number.isFinite(nextTotal) && nextTotal > 0) record.progress.total = nextTotal;
        if (Number.isFinite(current)) record.progress.current = Math.max(0, Math.min(current, record.progress.total));
        record.updatedAt = this.now().toISOString();
      };
      try {
        record.result = await executor(update);
        record.status = 'succeeded';
        record.progress.current = record.progress.total;
      } catch (error) {
        record.status = 'failed';
        record.error = cleanError(error);
      } finally {
        record.finishedAt = this.now().toISOString();
        record.updatedAt = record.finishedAt;
      }
    });
    return clone(record);
  }
}

export function operationIsTerminal(operation) {
  return Boolean(operation && TERMINAL.has(operation.status));
}
