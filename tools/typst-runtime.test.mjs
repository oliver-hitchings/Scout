import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installTypst, TYPST_ASSETS, TYPST_VERSION, typstAsset } from './typst-runtime.mjs';

test('pins official Typst 0.14.2 assets and SHA-256 digests', () => {
  assert.equal(TYPST_VERSION, '0.14.2');
  assert.equal(Object.keys(TYPST_ASSETS).length, 4);
  const asset = typstAsset('linux', 'x64');
  assert.match(asset.url, /typst\/typst\/releases\/download\/v0\.14\.2/);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
});

test('rejects a downloaded Typst archive whose checksum does not match', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-typst-checksum-'));
  try {
    await assert.rejects(() => installTypst({
      appRoot: root,
      platform: 'linux', arch: 'x64',
      fetchFn: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('tampered') }),
    }), /checksum mismatch/i);
    assert.equal(fs.existsSync(path.join(root, '.scout-runtime', 'typst')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
