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
