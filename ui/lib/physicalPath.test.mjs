import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-physical-path-')));
  roots.push(root);
  return root;
}

function workspace() {
  const root = path.join(temp(), 'workspace');
  fs.mkdirSync(root);
  return root;
}

function junction(target, link) {
  fs.symlinkSync(target, link, 'junction');
  return link;
}

test('returns the resolved target for an existing file inside the workspace', () => {
  const root = workspace();
  const target = path.join(root, 'data', 'record.json');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, '{}');
  assert.equal(validatePhysicalWorkspacePath(root, target), path.resolve(target));
});

test('accepts the workspace root itself', () => {
  const root = workspace();
  assert.equal(validatePhysicalWorkspacePath(root, root), path.resolve(root));
});

test('accepts a not-yet-existing path whose existing parent is inside the workspace', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'reports'));
  const target = path.join(root, 'reports', 'weekly', 'index.md');
  assert.equal(validatePhysicalWorkspacePath(root, target), path.resolve(target));
  assert.equal(fs.existsSync(target), false);
});

test('rejects a target that escapes the workspace through a parent segment', () => {
  const root = workspace();
  const target = path.join(root, '..', 'outside.txt');
  assert.throws(
    () => validatePhysicalWorkspacePath(root, target),
    /escapes its workspace/,
  );
});

test('rejects a sibling directory that merely shares the workspace name prefix', () => {
  const parent = temp();
  const root = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'workspace-other');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  assert.throws(
    () => validatePhysicalWorkspacePath(root, path.join(sibling, 'record.json')),
    /escapes its workspace/,
  );
});

test('rejects an absolute target outside the workspace', () => {
  const root = workspace();
  const outside = path.join(temp(), 'outside.txt');
  fs.writeFileSync(outside, 'x');
  assert.throws(
    () => validatePhysicalWorkspacePath(root, outside),
    /escapes its workspace/,
  );
});

test('rejects a workspace root that is itself a symlink or junction', () => {
  const real = path.join(temp(), 'real-workspace');
  fs.mkdirSync(real);
  const root = junction(real, path.join(temp(), 'workspace-link'));
  assert.throws(
    () => validatePhysicalWorkspacePath(root, path.join(root, 'record.json')),
    /workspace root is a symlink or junction/,
  );
});

test('rejects a target that traverses a junction out of the workspace', () => {
  const root = workspace();
  const outside = path.join(temp(), 'outside');
  fs.mkdirSync(outside);
  junction(outside, path.join(root, 'linked'));
  assert.throws(
    () => validatePhysicalWorkspacePath(root, path.join(root, 'linked', 'record.json')),
    /traverses a symlink or junction/,
  );
});

test('rejects a target that traverses a symlinked file inside the workspace', (t) => {
  const root = workspace();
  const outside = path.join(temp(), 'outside.txt');
  fs.writeFileSync(outside, 'x');
  try { fs.symlinkSync(outside, path.join(root, 'linked.txt'), 'file'); }
  catch { t.skip('file symlinks are unavailable'); return; }
  assert.throws(
    () => validatePhysicalWorkspacePath(root, path.join(root, 'linked.txt')),
    /traverses a symlink or junction/,
  );
});

test('rejects a not-yet-existing path under a junction even when nothing is written', () => {
  const root = workspace();
  const outside = path.join(temp(), 'outside');
  fs.mkdirSync(outside);
  junction(outside, path.join(root, 'linked'));
  const target = path.join(root, 'linked', 'reports', 'weekly', 'index.md');
  assert.throws(
    () => validatePhysicalWorkspacePath(root, target),
    /traverses a symlink or junction/,
  );
  assert.equal(fs.existsSync(target), false);
});

test('rejects a missing workspace root', () => {
  const root = path.join(temp(), 'missing');
  assert.throws(
    () => validatePhysicalWorkspacePath(root, path.join(root, 'record.json')),
    /workspace root does not exist/,
  );
});

test('uses the caller-supplied label in every failure message', () => {
  const root = workspace();
  const outside = path.join(temp(), 'outside.txt');
  fs.writeFileSync(outside, 'x');
  assert.throws(
    () => validatePhysicalWorkspacePath(root, outside, 'CV import path'),
    /CV import path escapes its workspace/,
  );
});

test('every accepted path stays inside the canonical workspace root', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'data'));
  const accepted = [
    path.join(root, 'data'),
    path.join(root, 'data', 'opportunities.json'),
    path.join(root, 'reports', 'not-created-yet.md'),
  ];
  const canonicalRoot = fs.realpathSync.native(root);
  for (const target of accepted) {
    const resolved = validatePhysicalWorkspacePath(root, target);
    const relative = path.relative(canonicalRoot, resolved);
    assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, resolved);
  }
});
