import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  interviewPrepAgentPrompt, interviewPrepPath, interviewPrepPrefills,
  interviewPrepRelativePath, readInterviewPrep,
} from './interviewPrep.mjs';

const ENTRY = { id: 'acme-platform-lead-2026-07', company: 'Acme & Sons', role: 'Platform Lead' };

test('interview prep paths are opportunity-specific and traversal-safe', () => {
  assert.equal(
    interviewPrepRelativePath(ENTRY),
    'applications/acme-and-sons/interview-prep/acme-platform-lead-2026-07.md',
  );
  assert.throws(() => interviewPrepRelativePath({ ...ENTRY, id: '../evil' }), /invalid interview prep opportunity/i);
});

test('prep artifacts report missing and bounded existing content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-prep-'));
  assert.equal(readInterviewPrep(root, ENTRY).exists, false);
  const file = interviewPrepPath(root, ENTRY);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Prep\n\n## My notes\nKeep this.\n');
  const artifact = readInterviewPrep(root, ENTRY);
  assert.equal(artifact.exists, true);
  assert.match(artifact.content, /My notes/);
  assert.equal(artifact.path, interviewPrepRelativePath(ENTRY));
});

test('prep prefills distinguish general and stage-specific preparation', () => {
  assert.match(interviewPrepPrefills(ENTRY).interviewPrep, /No interview stage is recorded/);
  const staged = { ...ENTRY, application: { stages: [{ name: 'Technical interview', completed: false }] } };
  assert.match(interviewPrepPrefills(staged).interviewPrep, /recorded current stage is Technical interview/);
  assert.match(interviewPrepPrefills(staged).prepMock, /one question at a time/);
  assert.match(interviewPrepPrefills(staged).prepRefresh, /Preserve my existing My notes section/);
});

test('agent prompt pins one opportunity and the private prep paths', () => {
  const prompt = interviewPrepAgentPrompt(ENTRY, 'Help me prepare');
  assert.match(prompt, /authoritative selected opportunity/);
  assert.match(prompt, /acme-platform-lead-2026-07/);
  assert.match(prompt, /data\/companies\/acme-and-sons\.json/);
  assert.match(prompt, /Never switch to another opportunity/);
  assert.match(prompt, /Help me prepare/);
});
