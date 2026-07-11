import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditRelease, loadMarkers, main } from './release-audit.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-audit-'));
}

test('passes clean tracked files and build output', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'README.md'), '# Generic project\n');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'app.txt'), 'packaged application\n');
  const result = auditRelease({ root, trackedFiles: ['README.md'], buildDirs: ['dist'], markers: ['Casey Exampleperson'] });
  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, 2);
});

test('reports marker and secret rules without retaining their values', () => {
  const root = fixture();
  const marker = 'Casey Exampleperson';
  const token = ['ghp_', 'A'.repeat(36)].join('');
  fs.writeFileSync(path.join(root, 'profile.txt'), `${marker}\n${token}\n`);
  const result = auditRelease({ root, trackedFiles: ['profile.txt'], buildDirs: [], markers: [marker] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: 'personal-marker-1' },
    { line: 2, rule: 'github-token' },
  ]);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('ignores documented placeholder credential assignments', () => {
  const root = fixture();
  const example = [`${'API'}_KEY=replace-me`, `${'PASS'}WORD=<your-password>`].join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'example.env'), example);
  const result = auditRelease({ root, trackedFiles: ['example.env'], buildDirs: [] });
  assert.equal(result.ok, true);
});

test('ignores credential variable expressions and binary files', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'source.mjs'), "const apiKey = String(env.ADZUNA_API_KEY || '').trim();\nconst token = crypto.randomUUID();\n");
  fs.writeFileSync(path.join(root, 'runtime.exe'), Buffer.from([77, 90, 0, 1, 2, 3]));
  const result = auditRelease({ root, trackedFiles: ['source.mjs', 'runtime.exe'], buildDirs: [] });
  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, 1);
});

test('loads sorted unique markers from file and environment', () => {
  const root = fixture();
  const file = path.join(root, 'markers.txt');
  fs.writeFileSync(file, '# private CI file\nSecond marker\nFirst marker\nSecond marker\n');
  assert.deepEqual(loadMarkers({ markerFile: file, envMarkers: 'Third marker\nFirst marker' }), [
    'First marker', 'Second marker', 'Third marker',
  ]);
});

test('stage mode scans an exported tree without requiring Git metadata', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'README.md'), '# Scout\n');
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => { writes.push(String(value)); return true; };
  try {
    const result = main(['--root', root, '--stage'], {});
    assert.equal(result.ok, true);
    assert.equal(result.filesScanned, 1);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(writes.join(''), /Release audit passed/);
});
