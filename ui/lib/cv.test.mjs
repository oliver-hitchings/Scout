import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { listCvFiles, renderCv, safeCvPath } from './cv.mjs';

const ROOT = 'C:/repo';

test('accepts the master CV', () => {
  assert.equal(safeCvPath(ROOT, 'cv/master-cv.md'), path.resolve(ROOT, 'cv/master-cv.md'));
});

test('accepts a well-formed application cv.typ and outreach.md', () => {
  assert.equal(
    safeCvPath(ROOT, 'applications/seeing-systems/cv.typ'),
    path.resolve(ROOT, 'applications/seeing-systems/cv.typ'),
  );
  assert.equal(
    safeCvPath(ROOT, 'applications/seeing-systems/outreach.md'),
    path.resolve(ROOT, 'applications/seeing-systems/outreach.md'),
  );
});

test('rejects traversal and off-whitelist paths', () => {
  assert.throws(() => safeCvPath(ROOT, '../secrets.txt'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'applications/../../etc/passwd'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'profile/context.md'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'applications/seeing-systems/notes.txt'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'applications/Bad Slug/cv.typ'), /invalid/i);
});

test('renderCv rejects invalid slugs before shelling out', () => {
  const result = renderCv(ROOT, '../../profile/context');
  assert.equal(result.ok, false);
  assert.match(result.stderr, /invalid slug/i);
});

test('lists legacy CV sources even when their PDFs and quality records are absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-list-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'legacy-role'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'legacy-role', 'cv.typ'), 'Legacy source');
    const result = listCvFiles(root);
    assert.deepEqual(result.applications, ['legacy-role']);
    assert.deepEqual(result.entries, [{
      slug: 'legacy-role', source: true, pdf: false, outreach: false, evidence: false, quality: false,
    }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('renders with the resolved managed Typst executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-render-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.typ'), 'Example');
    let invocation;
    const result = renderCv(root, 'example', {
      appRoot: 'C:/app',
      runtimeResolver: () => ({ available: true, command: 'C:/app/.scout-runtime/typst.exe', source: 'managed', version: 'typst 0.14.2' }),
      spawn: (command, args, options) => { invocation = { command, args, options }; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(result.ok, true);
    assert.equal(invocation.command, 'C:/app/.scout-runtime/typst.exe');
    assert.deepEqual(invocation.args, ['compile', '--root', '.', 'applications/example/cv.typ']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reports a Scout repair action when no Typst runtime is usable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-missing-runtime-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.typ'), 'Example');
    const result = renderCv(root, 'example', {
      runtimeResolver: () => ({ available: false, error: "Scout's managed Typst runtime is missing. Repair or reinstall Scout." }),
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /repair or reinstall Scout/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
