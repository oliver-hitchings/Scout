import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './mainModule.mjs';

test('recognises a directly executed module through a filesystem alias', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-main-module-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'entry.mjs');
  const alias = path.join(root, 'entry-alias.mjs');
  fs.writeFileSync(target, '');
  try { fs.symlinkSync(target, alias, 'file'); } catch { t.skip('file symlinks are unavailable'); return; }
  assert.equal(isMainModule(pathToFileURL(target), alias), true);
});

test('rejects a different entry module', () => {
  assert.equal(isMainModule(import.meta.url, path.join(os.tmpdir(), 'not-scout-entry.mjs')), false);
});
