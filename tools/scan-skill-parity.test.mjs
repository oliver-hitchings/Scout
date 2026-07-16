import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Codex and Claude scan skills keep the same operational protocol', () => {
  const normalise = (text) => text
    .replace('AGENTS.md', 'ASSISTANT_RULES.md')
    .replace('CLAUDE.md', 'ASSISTANT_RULES.md')
    .replace('agent=codex', 'agent=assistant')
    .replace('agent=claude', 'agent=assistant')
    .replace('mode=primary', 'mode=scheduled')
    .replace('mode=second-pass', 'mode=scheduled')
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(
    normalise(read('.agents/skills/scan/SKILL.md')),
    normalise(read('.claude/skills/scan/SKILL.md')),
  );
});

test('packaged, Codex and Claude tailor skills stay identical', () => {
  assert.equal(read('skills/builtin/tailor/SKILL.md'), read('.agents/skills/tailor/SKILL.md'));
  assert.equal(read('skills/builtin/tailor/SKILL.md'), read('.claude/skills/tailor/SKILL.md'));
});

test('Codex and Claude interview-prep skills stay identical and preserve the safety contract', () => {
  const codex = read('.agents/skills/interview-prep/SKILL.md');
  assert.equal(codex, read('.claude/skills/interview-prep/SKILL.md'));
  assert.equal(codex, read('skills/builtin/interview-prep/SKILL.md'));
  for (const phrase of [
    'absolute date checked', 'likely questions', 'STAR stories', 'questions for the interviewer',
    '## My notes', 'preserve `## My notes` exactly', 'Never switch to another tracker entry',
    'Never send messages', 'Never', 'change tracker status', 'or commit',
  ]) assert.match(codex, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});
