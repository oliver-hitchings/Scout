import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateLegacyWorkspace } from './scout.mjs';

test('legacy migration overwrites generic seed placeholders and preserves user trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-migrate-'));
  const source = path.join(root, 'legacy');
  const target = path.join(root, 'workspace');
  try {
    fs.mkdirSync(path.join(source, 'profile'), { recursive: true });
    fs.mkdirSync(path.join(source, 'cv'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.mkdirSync(path.join(source, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(source, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(source, 'profile', 'context.md'), '# Private legacy profile\n', 'utf8');
    fs.writeFileSync(path.join(source, 'cv', 'master-cv.md'), '# Example Person — Engineer\n', 'utf8');
    fs.writeFileSync(path.join(source, 'data', 'opportunities.json'), '{"opportunities":[{"id":"kept"}]}\n', 'utf8');
    fs.writeFileSync(path.join(source, 'reports', '2026-01-01.md'), '# Kept report\n', 'utf8');
    fs.writeFileSync(path.join(source, 'applications', 'example', 'outreach.md'), 'Kept draft\n', 'utf8');
    fs.writeFileSync(path.join(source, '.env'), 'ADZUNA_APP_ID=secret\n', 'utf8');

    const result = migrateLegacyWorkspace(source, target);

    assert.equal(fs.readFileSync(path.join(target, 'profile', 'context.md'), 'utf8'), '# Private legacy profile\n');
    assert.match(fs.readFileSync(path.join(target, 'cv', 'master-cv.md'), 'utf8'), /Example Person/);
    assert.match(fs.readFileSync(path.join(target, 'data', 'opportunities.json'), 'utf8'), /"kept"/);
    assert.equal(fs.readFileSync(path.join(target, 'reports', '2026-01-01.md'), 'utf8'), '# Kept report\n');
    assert.equal(fs.readFileSync(path.join(target, 'applications', 'example', 'outreach.md'), 'utf8'), 'Kept draft\n');
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'ADZUNA_APP_ID=secret\n');
    assert.equal(result.verifiedFiles, 6);
    assert.equal(result.targetRoot, target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
