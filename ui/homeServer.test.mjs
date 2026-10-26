import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedWorkspace } from './lib/workspace.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-home-api-'));
process.env.SCOUT_WORKSPACE = root;
process.env.SCOUT_DEVICE_SETTINGS = path.join(root, 'device.json');
const { createServer } = await import('./server.mjs');

test('home dashboard endpoints are read only, versioned, bounded and omit private fields', async () => {
  seedWorkspace(path.resolve('.'), root);
  const configFile = path.join(root, 'workspace.json');
  const config = JSON.parse(fs.readFileSync(configFile));
  config.profile.displayName = 'PRIVATE PROFILE SENTINEL';
  fs.writeFileSync(configFile, JSON.stringify(config));
  const tracker = path.join(root, 'data', 'opportunities.json');
  fs.writeFileSync(tracker, JSON.stringify({ opportunities: [
    { id: 'example-role-2026-10', role: 'Synthetic role', company: 'Example', score: 99, status: 'new', firstSeen: '2026-10-26', sources: ['https://example.test/job?token=PRIVATE#secret'], notes: 'PRIVATE NOTES SENTINEL' },
    { id: 'weak', role: 'Weak', company: 'Example', score: 40, status: 'new' },
    { id: 'closed', role: 'Closed', company: 'Example', score: 99, status: 'closed' },
  ] }));
  const before = fs.readFileSync(tracker, 'utf8');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).schemaVersion, 1);
    const response = await fetch(`${base}/api/summary`);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.mode, 'background');
    assert.deepEqual(summary.newMatches, [{ id: 'example-role-2026-10', title: 'Synthetic role', employer: 'Example', score: 99, link: 'https://example.test/job', firstSeen: '2026-10-26' }]);
    assert.equal(summary.newMatchCount, 1);
    assert.equal(summary.matchesTruncated, false);
    assert.ok(summary.scanHealth);
    assert.deepEqual(summary.providers, []);
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|notes|profile|workspaceRoot|appRoot/);
    assert.equal(fs.readFileSync(tracker, 'utf8'), before);
    assert.equal((await fetch(`${base}/api/summary`, { method: 'POST' })).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('summary sanitises provider/scan state and states every omitted match explicitly', async () => {
  const { buildHomeSummary } = await import('./lib/homeSummary.mjs');
  const summary = buildHomeSummary({ config: { mode: 'active', triage: { actionScore: 70 } },
    tracker: { opportunities: Array.from({ length: 205 }, (_, i) => ({ id: `synthetic-${i}`, role: 'Role', company: 'Example', score: 80, status: 'shortlist', firstSeen: '2026-10-26' })) },
    scanHealth: { healthy: false, reason: 'PRIVATE', errors: ['PRIVATE'], lastRunAt: '2026-10-26T08:00:00.000Z' },
    providers: [{ provider: 'local', state: 'ready', checkedAt: '2026-10-26T08:00:00.000Z', raw: 'PRIVATE' }],
    notifications: { alerts: Array.from({ length: 220 }, (_, i) => ({ id: `${i}`.padStart(64, 'a'), kind: 'digest', count: 1, createdAt: '2026-10-26T08:00:00.000Z', body: 'PRIVATE' })) },
  });
  assert.equal(summary.newMatchCount, 205);
  assert.equal(summary.newMatches.length, 200);
  assert.equal(summary.matchesTruncated, true);
  assert.equal(summary.pendingAlertCount, 220);
  assert.equal(summary.pendingAlerts.length, 220);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
  assert.deepEqual(summary.providers, [{ provider: 'local', state: 'ready', checkedAt: '2026-10-26T08:00:00.000Z' }]);
});

test('a real coordinated scan publishes first-seen dates and preserves them through rechecks', async () => {
  const { coordinateScanArtifacts } = await import('./lib/scanPipeline.mjs');
  const { acquireScanLease, currentLeaseOwner, releaseScanLease } = await import('./lib/scanLease.mjs');
  const { openRunJournal } = await import('./lib/runJournal.mjs');
  const { canonicalMutationRecipe, trackerMergeRecipe } = await import('./lib/scanMutationProjection.mjs');
  fs.mkdirSync(root, { recursive: true });
  seedWorkspace(path.resolve('.'), root);
  const input = (at) => ({
    provider: 'codex', mode: 'primary', startedAt: at,
    candidates: [{ candidateId: 'candidate-001', vacancyId: 'synthetic-first-seen', company: 'Example', role: 'Synthetic role', source: 'ats', url: 'https://example.test/first-seen', preRankScore: 98 }],
    sources: { ats: { status: 'healthy', count: 1 } },
    assessmentResult: { assessments: [{ candidateId: 'candidate-001', recommendation: 'keep', mandatoryRequirements: [], responsibilityFit: { rating: 'strong' } }] },
    policy: { actionScore: 95, checkScore: 85 },
  });
  function scan(id, at) {
    const run = openRunJournal(root, id);
    const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: id });
    try { assert.ok(coordinateScanArtifacts(root, input(at), { run, lease }).mutationReceipt); }
    finally { releaseScanLease(lease); }
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const summary = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/summary`)).json();
    scan('synthetic-first-seen-1', '2026-10-26T08:00:00.000Z');
    assert.equal((await summary()).newMatches[0].firstSeen, '2026-10-26');
    scan('synthetic-first-seen-1', '2026-10-26T08:00:00.000Z');
    assert.equal((await summary()).newMatches[0].firstSeen, '2026-10-26', 'receipt recovery preserves the discovery date');
    scan('synthetic-first-seen-2', '2026-10-27T08:00:00.000Z');
    assert.equal((await summary()).newMatches[0].firstSeen, '2026-10-26');
    const file = path.join(root, 'data', 'opportunities.json');
    const legacy = JSON.parse(fs.readFileSync(file));
    delete legacy.opportunities[0].firstSeen;
    fs.writeFileSync(file, JSON.stringify(legacy));
    scan('synthetic-first-seen-3', '2026-10-28T08:00:00.000Z');
    assert.equal((await summary()).newMatches[0].firstSeen, null, 'unknown legacy discovery dates must not be invented');
    const current = JSON.parse(fs.readFileSync(file));
    current.opportunities[0].firstSeen = 'not a calendar date';
    fs.writeFileSync(file, JSON.stringify(current));
    scan('synthetic-first-seen-4', '2026-10-29T08:00:00.000Z');
    assert.equal((await summary()).newMatches[0].firstSeen, null);
    const legacyRecipe = trackerMergeRecipe(JSON.stringify(legacy), JSON.stringify(legacy));
    assert.equal(Object.hasOwn(canonicalMutationRecipe('tracker', legacyRecipe).upserts[0], 'firstSeen'), false, 'old recipe canonical bytes keep the absent optional field absent');
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('local summary reports fresh physical storage pressure without mutating workspace files', async () => {
  const { RUN_STORAGE_WARNING_BYTES } = await import('./lib/runRetention.mjs');
  fs.mkdirSync(root, { recursive: true });
  seedWorkspace(path.resolve('.'), root);
  const directory = path.join(root, '.scout/scan-input');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'synthetic-storage.json');
  const descriptor = fs.openSync(file, 'w');
  try { fs.ftruncateSync(descriptor, RUN_STORAGE_WARNING_BYTES.artifacts); }
  finally { fs.closeSync(descriptor); }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const summary = await (await fetch(`http://127.0.0.1:${server.address().port}/api/summary`)).json();
    assert.equal(summary.storagePressure.state, 'warning');
    assert.deepEqual(summary.storagePressure.warnings, [{ area: 'artifacts', level: 'warning' }]);
    assert.equal(JSON.stringify(summary).includes(root), false);
    assert.equal(fs.existsSync(path.join(root, '.scout/notifications-runtime.json')), false, 'summary remains read-only');
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
