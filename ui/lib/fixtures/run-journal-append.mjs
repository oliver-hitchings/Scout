import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRunEvent, openRunJournal, validateRunJournal } from '../runJournal.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease, renewScanLease } from '../scanLease.mjs';

const counts = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [500, 2500];
if (counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 10_000)) {
  throw new Error('Choose event counts between 1 and 10000');
}

for (const count of counts) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-journal-benchmark-')));
  const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, readFile: fs.readFileSync };
  const descriptors = new Set();
  let lease;
  let journalBytesRead = 0;
  let fullReads = 0;
  try {
    lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'synthetic-measure' });
    const run = openRunJournal(root, 'synthetic-measure');
    fs.openSync = function (file, ...args) {
      const descriptor = original.open.call(this, file, ...args);
      if (String(file) === run.file) descriptors.add(descriptor);
      return descriptor;
    };
    fs.closeSync = function (descriptor) {
      descriptors.delete(descriptor);
      return original.close.call(this, descriptor);
    };
    fs.readSync = function (descriptor, ...args) {
      const bytes = original.read.call(this, descriptor, ...args);
      if (descriptors.has(descriptor)) journalBytesRead += bytes;
      return bytes;
    };
    fs.readFileSync = function (file, ...args) {
      const tracked = String(file) === run.file || descriptors.has(file);
      const before = journalBytesRead;
      const value = original.readFile.call(this, file, ...args);
      if (tracked) {
        fullReads += 1;
        if (journalBytesRead === before) journalBytesRead += Buffer.byteLength(value);
      }
      return value;
    };
    const startedAt = performance.now();
    const startedCpu = process.cpuUsage();
    for (let index = 0; index < count; index += 1) {
      if (index % 100 === 0) renewScanLease(lease);
      appendRunEvent(run, {
        type: 'assessment.job-completed', stageId: 'assess', idempotencyKey: `synthetic-job-${index}`,
        payload: {
          schemaVersion: 1, reference: { kind: 'vacancy', id: `synthetic-vacancy-${index}` },
          artifact: { id: `synthetic-assessment-${index}`, schemaVersion: 1, digest: 'a'.repeat(64) },
        },
      }, lease);
    }
    const wallMs = performance.now() - startedAt;
    const usedCpu = process.cpuUsage(startedCpu);
    fs.openSync = original.open;
    fs.closeSync = original.close;
    fs.readSync = original.read;
    fs.readFileSync = original.readFile;
    console.log(JSON.stringify({
      count, wallMs, cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      journalBytes: fs.statSync(run.file).size, fullReads, journalBytesRead,
      validEvents: validateRunJournal(run.file).events.length,
    }));
  } finally {
    fs.openSync = original.open;
    fs.closeSync = original.close;
    fs.readSync = original.read;
    fs.readFileSync = original.readFile;
    if (lease) releaseScanLease(lease);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
