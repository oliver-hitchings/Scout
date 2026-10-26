import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireProcessDirectoryLock, LEGACY_DIRECTORY_LOCK_STALE_MS } from './processDirectoryLock.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-process-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'lock');
}

test('process locks preserve a live owner even when its recorded acquisition is old', (t) => {
  const directory = fixture(t);
  const first = acquireProcessDirectoryLock(directory);
  const file = path.join(directory, 'owner.json');
  const record = JSON.parse(fs.readFileSync(file));
  record.acquiredAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(acquireProcessDirectoryLock(directory), null);
  first.assertOwned();
  first.release();
  const next = acquireProcessDirectoryLock(directory);
  next.assertOwned(); next.release();
});

test('legacy empty mkdir locks recover only after their safety interval', (t) => {
  const directory = fixture(t);
  fs.mkdirSync(directory);
  assert.equal(acquireProcessDirectoryLock(directory), null);
  const old = new Date(Date.now() - LEGACY_DIRECTORY_LOCK_STALE_MS - 1000);
  fs.utimesSync(directory, old, old);
  const recovered = acquireProcessDirectoryLock(directory);
  assert.ok(recovered); recovered.release();
});

test('legacy directories containing data are preserved regardless of age', (t) => {
  const directory = fixture(t);
  fs.mkdirSync(directory);
  const file = path.join(directory, 'retained.txt');
  fs.writeFileSync(file, 'Synthetic retained content.');
  const old = new Date(Date.now() - LEGACY_DIRECTORY_LOCK_STALE_MS - 1000);
  fs.utimesSync(directory, old, old);
  assert.equal(acquireProcessDirectoryLock(directory), null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Synthetic retained content.');
});

test('a stale release cannot remove a successor ownership record', (t) => {
  const directory = fixture(t);
  const stale = acquireProcessDirectoryLock(directory);
  stale.release();
  const current = acquireProcessDirectoryLock(directory);
  assert.throws(() => stale.assertOwned(), /ownership/);
  assert.throws(() => stale.release(), /ownership/);
  current.assertOwned(); current.release();
});

test('unknown owner metadata fails closed and remains available for inspection', (t) => {
  const directory = fixture(t);
  const current = acquireProcessDirectoryLock(directory);
  current.release();
  const file = path.join(directory, 'owner.json');
  fs.writeFileSync(file, '{invalid');
  assert.throws(() => acquireProcessDirectoryLock(directory), /ownership/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});

test('linked lock roots and linked guard storage cannot redirect metadata changes', (t) => {
  const directory = fixture(t);
  const sibling = `${directory}-other`;
  fs.mkdirSync(sibling);
  fs.symlinkSync(sibling, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => acquireProcessDirectoryLock(directory), /ownership/);
  fs.unlinkSync(directory);
  fs.mkdirSync(directory);
  fs.symlinkSync(sibling, path.join(directory, '.scout'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => acquireProcessDirectoryLock(directory), /ownership/);
  assert.deepEqual(fs.readdirSync(sibling), []);
});
