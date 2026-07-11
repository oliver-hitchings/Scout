import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderCv, safeCvPath } from './cv.mjs';

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
