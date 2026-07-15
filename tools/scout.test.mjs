import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectScanSources, migrateLegacyWorkspace, runScanWith } from './scout.mjs';
import { DEFAULT_WORKSPACE_CONFIG, writeWorkspaceConfig } from '../ui/lib/workspace.mjs';

function scanRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-runtime-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-14","opportunities":[]}\n');
  writeWorkspaceConfig(root, { ...structuredClone(DEFAULT_WORKSPACE_CONFIG), ai: { provider: 'codex', model: null } });
  return root;
}

const authenticated = () => ({ installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } });

test('an absent ATS configuration does not degrade a healthy configured source', async () => {
  const root = scanRoot();
  const config = { ...structuredClone(DEFAULT_WORKSPACE_CONFIG), search: { ...DEFAULT_WORKSPACE_CONFIG.search, roleFamilies: ['engineer'] } };
  writeWorkspaceConfig(root, config);
  const collected = await collectScanSources(root, config, {
    fetchAts: async () => ({ status: 'unavailable', available: false, count: 0, reason: 'no supported ATS portals enabled', jobs: [] }),
    fetchCafe: async () => ({ status: 'healthy', available: true, count: 1, jobs: [{ title: 'Engineer', company: 'Example', url: 'https://example.test/job' }] }),
    fetchAdzunaFn: async () => { throw new Error('Adzuna must be skipped without credentials'); },
  });
  assert.equal(collected.sources.ats.configured, false);
  assert.equal(collected.sources.hiring_cafe.configured, true);
  assert.equal(collected.sources.hiring_cafe.status, 'healthy');
  assert.equal(collected.sources.adzuna.configured, false);
});

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

test('runtime scan skips AI for a healthy empty source result and needs no Git repository', async () => {
  const root = scanRoot();
  let providerCalls = 0;
  let released = false;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-14T10:00:00Z', queries: ['rare role'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
    }),
    runStructuredTurnFn: async () => { providerCalls += 1; throw new Error('must not run'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'lock-1' } }),
    releaseLockFn: () => { released = true; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'healthy-empty');
  assert.equal(result.scan.candidates_found, 0);
  assert.equal(providerCalls, 0);
  assert.equal(released, true);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('runtime scan refuses lock contention before collecting sources', async () => {
  const root = scanRoot();
  let collected = false;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => { collected = true; return {}; },
    acquireLockFn: () => ({ ok: false, lock: { agent: 'claude' } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /already running/);
  assert.equal(collected, false);
});

test('runtime scan records provider failure truthfully and always releases its lock', async () => {
  const root = scanRoot();
  let released = false;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-14T10:00:00Z', queries: ['engineer'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job' }] } },
    }),
    runStructuredTurnFn: async () => { throw new Error('bounded provider failed'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'lock-2' } }),
    releaseLockFn: () => { released = true; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.scan.degraded, true);
  assert.deepEqual(result.scan.errors, ['bounded provider failed']);
  assert.equal(released, true);
  assert.match(fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8'), /bounded provider failed/);
});
