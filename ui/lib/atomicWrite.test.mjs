import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from './atomicWrite.mjs';

test('atomic writes flush and replace a complete file without leaving temporary data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-atomic-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'record.json');
  atomicWriteFile(file, '{"version":1}\n', { mode: 0o600 });
  atomicWriteFile(file, '{"version":2,"complete":true}\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, complete: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['record.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('critical workspace writers use the shared atomic replacement path', () => {
  const criticalModules = [
    'chatStore.mjs', 'companyStore.mjs', 'cvQuality.mjs', 'env.mjs',
    'onboardingProposal.mjs', 'recoveryBackup.mjs', 'scanPipeline.mjs',
    'trackerPersistence.mjs', 'workspace.mjs', 'workspaceSync.mjs',
  ];
  for (const module of criticalModules) {
    const source = fs.readFileSync(new URL(module, import.meta.url), 'utf8');
    assert.match(source, /atomicWriteFile/);
    assert.doesNotMatch(source, /writeFileSync\(/, `${module} bypasses atomic workspace persistence`);
  }
});
