import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  includePublicSourcePath, includeReleasePath, PUBLIC_SOURCE_FILES, RELEASE_FILES,
  sha256, stagePublicSource, stageRelease, writeChecksums,
} from './build-release.mjs';

test('release manifest is allowlisted and excludes private workspace roots', () => {
  const sources = RELEASE_FILES.map((entry) => entry.source);
  for (const privateRoot of ['profile', 'cv', 'data', 'reports', 'applications', '.env', 'workspace.json']) {
    assert.ok(!sources.some((source) => source === privateRoot || source.startsWith(`${privateRoot}/`)));
  }
  assert.ok(sources.includes('LICENSE'));
  assert.ok(sources.includes('README.md'));
  assert.ok(sources.includes('docs/QUICK_START.md'));
  assert.ok(sources.includes('docs/INSTALL_WINDOWS.md'));
  assert.ok(sources.includes('docs/INSTALL_MACOS.md'));
  assert.ok(sources.includes('docs/INSTALL_LINUX.md'));
  assert.ok(sources.includes('docs/releases'));
  assert.ok(sources.includes('docs/RELEASE.md'));
  assert.ok(!sources.includes('docs/CODEX_HANDOFF.md'));
  assert.ok(!sources.includes('docs/PLAN.md'));
});

test('release tree filter omits tests and snapshots', () => {
  assert.equal(includeReleasePath('ui/lib/workspace.mjs'), true);
  assert.equal(includeReleasePath('ui/lib/workspace.test.mjs'), false);
  assert.equal(includeReleasePath('ui/__snapshots__/screen.txt'), false);
  assert.equal(includeReleasePath('node_modules/.bin/mammoth'), false);
});

test('public source manifest includes tests and workflows but excludes private roots and installer output', () => {
  const sources = PUBLIC_SOURCE_FILES.map((entry) => entry.source);
  assert.ok(sources.includes('ui'));
  assert.ok(sources.includes('.github'));
  assert.ok(sources.includes('tools/build-release.test.mjs'));
  assert.ok(!sources.includes('docs/CODEX_HANDOFF.md'));
  assert.ok(!sources.includes('tools/commute-data.test.mjs'));
  assert.equal(includePublicSourcePath('output/Scout.exe'), false);
  assert.equal(includePublicSourcePath('Scout.iss'), true);
});

test('public source staging contains contributor inputs without private workspace or built artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-root-'));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-stage-'));
  for (const entry of PUBLIC_SOURCE_FILES) {
    const target = path.join(root, entry.source);
    if (entry.tree) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'source.txt'), 'ok');
      if (entry.source === 'installer') {
        fs.mkdirSync(path.join(target, 'output'), { recursive: true });
        fs.writeFileSync(path.join(target, 'output', 'Scout.exe'), 'built');
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.source === 'package.json' ? '{"version":"1.0.0"}' : 'ok');
    }
  }
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'private');
  const staged = stagePublicSource({ root, stageDir });
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'ui', 'source.txt')), true);
  assert.equal(fs.existsSync(path.join(staged.stageDir, '.github', 'source.txt')), true);
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'installer', 'output')), false);
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'profile')), false);
});

test('staging copies only manifest content and bundled runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-root-'));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-stage-'));
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-node-'));
  const nodeExecutable = path.join(nodeDir, 'node.exe');
  fs.writeFileSync(nodeExecutable, 'runtime');
  for (const entry of RELEASE_FILES) {
    const target = path.join(root, entry.source);
    if (entry.tree) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'runtime.mjs'), 'ok');
      fs.writeFileSync(path.join(target, 'runtime.test.mjs'), 'private fixture');
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.source === 'package.json' ? '{"version":"1.0.0"}' : 'ok');
    }
  }
  fs.mkdirSync(path.join(root, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'installer', 'ScoutLauncher.ps1'), 'launcher');
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'private');

  const staged = stageRelease({ root, stageDir, nodeExecutable, includeDependencies: false, platform: 'win32' });
  assert.equal(fs.existsSync(path.join(staged.appDir, 'ui', 'runtime.mjs')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'ui', 'runtime.test.mjs')), false);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'profile')), false);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'docs', 'QUICK_START.md')), true);
  assert.equal(fs.readFileSync(path.join(stageDir, 'runtime', 'node.exe'), 'utf8'), 'runtime');
});

test('checksums use SHA-256 and do not hash the manifest into itself', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-output-'));
  const artifact = path.join(output, 'Scout.exe');
  fs.writeFileSync(artifact, 'installer');
  const manifest = writeChecksums(output);
  assert.equal(fs.readFileSync(manifest, 'utf8'), `${sha256(artifact)}  Scout.exe\n`);
  writeChecksums(output);
  assert.equal(fs.readFileSync(manifest, 'utf8'), `${sha256(artifact)}  Scout.exe\n`);
});
