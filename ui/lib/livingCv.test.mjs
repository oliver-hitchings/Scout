import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as livingCv from './livingCv.mjs';
import { atomicWriteFile } from './atomicWrite.mjs';
import { approveLivingCv, configureLivingCv, livingCvStatus } from './livingCv.mjs';

const original = '# Synthetic CV\n\n' + 'Confirmed experience and evidence. '.repeat(30);
const changed = original + '\n## New evidence\nA confirmed additional responsibility.\n';
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-living-cv-'));
  const root = path.join(parent, 'workspace');
  fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), original);
  const source = path.join(parent, 'source.md');
  fs.writeFileSync(source, changed);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { root, source };
}

test('an external change stays a reviewable diff until the exact source and master are approved', (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  const status = livingCvStatus(root);
  assert.equal(status.state, 'changed');
  assert.ok(status.diff.some((line) => line.kind === 'added' && line.text.includes('New evidence')));
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), original);
  assert.throws(() => approveLivingCv(root, { revision: status.revision }), /confirm/i);
  const approved = approveLivingCv(root, { revision: status.revision, confirmed: true });
  assert.equal(approved.state, 'current');
  assert.equal(approved.profileReviewPending, true);
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), changed);
  assert.equal(approved.versions.length, 2);
  const currentId = createHash('sha256').update(changed).digest('hex');
  assert.ok(approved.versions.some(({ id }) => id === currentId));
  assert.equal(fs.readFileSync(path.join(root, 'cv/versions', `${currentId}.md`), 'utf8'), changed);
});

test('source edits, local CV edits and workspace boundaries invalidate an old approval', (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  let revision = livingCvStatus(root).revision;
  fs.appendFileSync(source, '\nAnother confirmed fact.\n');
  assert.throws(() => approveLivingCv(root, { revision, confirmed: true }), /changed|review/i);
  revision = livingCvStatus(root).revision;
  fs.appendFileSync(path.join(root, 'cv/master-cv.md'), '\nA local edit.\n');
  assert.throws(() => approveLivingCv(root, { revision, confirmed: true }), /changed|review/i);
  const other = path.join(path.dirname(root), 'other');
  fs.mkdirSync(other);
  assert.equal(livingCvStatus(other).state, 'disconnected');
  assert.throws(() => configureLivingCv(root, path.join(root, 'cv/master-cv.md')), /external|outside/i);
});

test('JSON sources are bounded Markdown envelopes; invalid or missing sources keep the CV and versions', (t) => {
  const { root, source } = fixture(t);
  const json = source.replace(/md$/, 'json');
  fs.writeFileSync(json, JSON.stringify({ markdown: changed }));
  configureLivingCv(root, json);
  const status = livingCvStatus(root);
  approveLivingCv(root, { revision: status.revision, confirmed: true });
  const versions = livingCvStatus(root).versions;
  fs.writeFileSync(json, JSON.stringify({ unrelated: 'not a CV' }));
  assert.equal(livingCvStatus(root).state, 'unavailable');
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), changed);
  fs.rmSync(json);
  assert.equal(livingCvStatus(root).state, 'unavailable');
  assert.deepEqual(livingCvStatus(root).versions, versions);
  configureLivingCv(root, null);
  assert.equal(livingCvStatus(root).state, 'disconnected');
  assert.deepEqual(livingCvStatus(root).versions, versions);
});

test('version tampering fails closed', (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  let status = livingCvStatus(root);
  approveLivingCv(root, { revision: status.revision, confirmed: true });
  status = livingCvStatus(root);
  fs.writeFileSync(path.join(root, 'cv/versions', `${status.versions[0].id}.md`), 'tampered');
  fs.appendFileSync(source, '\nFurther evidence.\n');
  assert.throws(() => approveLivingCv(root, { revision: livingCvStatus(root).revision, confirmed: true }), /version|digest/i);
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), changed);
});

test('FIFO sources are rejected before a blocking open at the process boundary', { skip: process.platform === 'win32' }, (t) => {
  const { root, source } = fixture(t);
  fs.rmSync(source);
  assert.equal(spawnSync('mkfifo', [source]).status, 0);
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { configureLivingCv } from ${JSON.stringify(new URL('./livingCv.mjs', import.meta.url).href)};
    try { configureLivingCv(${JSON.stringify(root)}, ${JSON.stringify(source)}); process.exitCode = 2; }
    catch { process.exitCode = 0; }
  `], { timeout: 1500, encoding: 'utf8' });
  assert.equal(child.status, 0, `FIFO source handling did not finish: ${child.signal || child.stderr}`);
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), original);
});

test('interrupted CV approval recovers master and profiling provenance together without replay', (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  const revision = livingCvStatus(root).revision;
  assert.throws(() => approveLivingCv(root, { revision, confirmed: true }, {
    writeFile(file, value, options) {
      if (file.endsWith('living-cv.json')) throw new Error('synthetic config replacement failure');
      atomicWriteFile(file, value, options);
    },
  }), /synthetic config/);
  assert.equal(livingCvStatus(root).state, 'recovery-needed');
  assert.throws(() => livingCv.approvedLivingCvEvidence(root), /recover/i);
  const recovered = livingCv.recoverLivingCvApproval(root);
  assert.equal(recovered.state, 'current');
  assert.equal(livingCv.approvedLivingCvEvidence(root), changed);
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), changed);
  assert.equal(recovered.versions.length, 2);
  assert.deepEqual(livingCv.recoverLivingCvApproval(root), recovered);
});

test('CV approval recovery preserves an unexpected post-crash edit and its pending evidence', (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  assert.throws(() => approveLivingCv(root, { revision: livingCvStatus(root).revision, confirmed: true }, {
    writeFile(file, value, options) {
      if (file.endsWith('living-cv.json')) throw new Error('synthetic crash');
      atomicWriteFile(file, value, options);
    },
  }), /synthetic crash/);
  fs.writeFileSync(path.join(root, 'cv/master-cv.md'), 'A post-crash manual edit.');
  assert.throws(() => livingCv.recoverLivingCvApproval(root), /conflict/i);
  assert.equal(fs.readFileSync(path.join(root, 'cv/master-cv.md'), 'utf8'), 'A post-crash manual edit.');
  assert.ok(fs.existsSync(path.join(root, 'cv/living-cv-approval.json')));
  assert.equal(livingCvStatus(root).versions.length, 2);
});

for (const boundary of ['living-cv-approval.json', 'master-cv.md', 'living-cv.json']) {
  test(`approval recovers after interruption immediately after ${boundary} replacement`, (t) => {
    const { root, source } = fixture(t);
    configureLivingCv(root, source);
    assert.throws(() => approveLivingCv(root, { revision: livingCvStatus(root).revision, confirmed: true }, {
      writeFile(file, value, options) {
        atomicWriteFile(file, value, options);
        if (file.endsWith(boundary)) throw new Error('synthetic replacement interruption');
      },
    }), /synthetic replacement/);
    assert.equal(livingCvStatus(root).state, 'recovery-needed');
    const recovered = livingCv.recoverLivingCvApproval(root);
    assert.equal(recovered.state, 'current');
    assert.equal(livingCv.approvedLivingCvEvidence(root), changed);
    assert.equal(recovered.versions.length, 2);
  });
}

test('starting a scan recovers a pending CV approval before readiness or provider work', async (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  assert.throws(() => approveLivingCv(root, { revision: livingCvStatus(root).revision, confirmed: true }, {
    writeFile(file, value, options) { atomicWriteFile(file, value, options); if (file.endsWith('master-cv.md')) throw new Error('synthetic interruption'); },
  }), /interruption/);
  const { runScan } = await import('../../tools/scout.mjs');
  let ready = false;
  await runScan(root, 'codex', 'primary', {
    assertScanReadyFn() { assert.equal(livingCv.approvedLivingCvEvidence(root), changed); ready = true; },
    async runScanWithFn() { assert.equal(ready, true); return { ok: true }; },
  });
  assert.equal(livingCvStatus(root).state, 'current');
});

test('source checks do not mistake a generated master for a new external edit, and disconnect retires active evidence', (t) => {
  const { root, source } = fixture(t);
  configureLivingCv(root, source);
  approveLivingCv(root, { revision: livingCvStatus(root).revision, confirmed: true });
  fs.appendFileSync(path.join(root, 'cv/master-cv.md'), '\nA reviewed local presentation change.');
  assert.equal(livingCvStatus(root).state, 'current');
  configureLivingCv(root, null);
  assert.equal(livingCv.approvedLivingCvEvidence(root), null);
  assert.equal(livingCvStatus(root).versions.length, 2);
});
