import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const sourced = (text) => ({ text, evidenceIds: ['config-roles'] });
function syntheticProposal() {
  return {
    summary: 'Synthetic reviewed onboarding.', unresolvedQuestions: [],
    profile: { headline: sourced('Synthetic Engineer'), priorities: [sourced('Synthetic Engineer')],
      evidence: [sourced('Delivered reliable synthetic systems. '.repeat(8))], exclusions: [], tone: sourced('Clear and direct') },
    calibration: { dimensions: [{ name: 'Evidence fit', weight: 100, description: 'Synthetic evidence fit.' }],
      gates: [], actionScore: 70, checkScore: 55 },
    searchCategories: [{ id: 'synthetic-engineering', label: 'Synthetic engineering', description: 'Synthetic engineering roles',
      priority: 'primary', queries: ['Synthetic Engineer'], keeperRule: 'Confirmed evidence fit' }],
    masterCv: { title: sourced('Synthetic Profile'), profile: sourced('Delivered reliable synthetic systems. '.repeat(70)),
      skills: [sourced('Synthetic delivery'), sourced('Synthetic reliability'), sourced('Synthetic collaboration')],
      experience: [{ heading: sourced('Synthetic systems'), bullets: [sourced('Delivered reliable synthetic systems.')] }],
      education: [], otherEvidence: [] },
  };
}

test('actual onboarding approval survives reviewed operational settings and profile publication while evidence stays bound', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-setup-approval-'));
  const root = path.join(parent, 'workspace');
  const previousWorkspace = process.env.SCOUT_WORKSPACE;
  const previousDevice = process.env.SCOUT_DEVICE_SETTINGS;
  process.env.SCOUT_WORKSPACE = root;
  process.env.SCOUT_DEVICE_SETTINGS = path.join(parent, 'device.json');
  let providerCalls = 0;
  const provider = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    providerCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(syntheticProposal()) } }] }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const runtime = await import('./server.mjs');
  const { localProviderStatus } = await import('./lib/localProvider.mjs');
  const { loadWorkspaceConfig } = await import('./lib/workspace.mjs');
  const { runScan } = await import('../tools/scout.mjs');
  const originalDetection = runtime.providerDetection.detect;
  runtime.providerDetection.detect = async () => ({ local: localProviderStatus({ local: loadWorkspaceConfig(root).ai.local, root }) });
  const server = runtime.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.ok, true, `${route}: ${response.status} ${JSON.stringify(value)}`);
    await runtime.drainScheduledCheckpoints();
    return value;
  };
  t.after(async () => {
    await runtime.drainScheduledCheckpoints();
    runtime.providerDetection.detect = originalDetection;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    if (previousWorkspace === undefined) delete process.env.SCOUT_WORKSPACE;
    else process.env.SCOUT_WORKSPACE = previousWorkspace;
    if (previousDevice === undefined) delete process.env.SCOUT_DEVICE_SETTINGS;
    else process.env.SCOUT_DEVICE_SETTINGS = previousDevice;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await request('/api/workspace/create', {});
  await request('/api/setup/config', {
    profile: { displayName: 'Synthetic Profile', tone: 'Clear and direct' },
    search: { roleFamilies: ['Synthetic Engineer'], locations: ['Remote'], exclusions: [], salaryMinimum: null },
    ai: { provider: 'local', local: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'synthetic-model' } },
  });
  await request('/api/setup/import-cv', { name: 'synthetic.md', base64: Buffer.from('Delivered reliable synthetic systems. '.repeat(70)).toString('base64') });
  const started = await request('/api/setup/proposal', { provider: 'local' });
  let operation;
  const deadline = Date.now() + 10000;
  do {
    operation = (await request(`/api/operations/${started.operation.id}`)).operation;
    if (['succeeded', 'failed'].includes(operation.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(operation.status, 'succeeded', operation.error);
  await request('/api/setup/activate', { proposalId: operation.result.proposalId, confirmed: true });
  assert.equal((await request('/api/setup/status')).readiness.approved, true);
  assert.equal(providerCalls, 1, 'onboarding must use only the synthetic HTTP boundary');
  const configFile = path.join(root, 'workspace.json');
  const markerFile = path.join(root, '.scout/onboarding/activated.json');
  const activatedConfig = fs.readFileSync(configFile);
  const marker = fs.readFileSync(markerFile);

  for (const [label, change] of [
    ['mode', { mode: 'active' }],
    ['schedule', { schedule: { jobs: [{ id: 'synthetic-daily', enabled: true, provider: 'local', mode: 'primary', time: '07:30', days: [1], model: null }] } }],
    ['setup bookkeeping', { setup: { completedAt: '2026-01-01T00:00:00.000Z', completedSections: { 'first-scan': 1 }, deferredSections: { cv: '2026-01-02T00:00:00.000Z' } } }],
  ]) {
    await t.test(`${label} does not revoke reviewed evidence`, async () => {
      await request('/api/setup/config', change);
      const status = await request('/api/setup/status');
      assert.equal(status.readiness.approved, true);
      assert.equal(status.ready, true);
      assert.deepEqual(fs.readFileSync(markerFile), marker, 'settings cannot rewrite or mint approval');
    });
    fs.writeFileSync(configFile, activatedConfig);
  }
  await t.test('actual reviewed search-profile publication and mode choice admit production runScan', async () => {
    const profile = await request('/api/search-profile');
    await request('/api/search-profile/publish', { revision: profile.draftRevision, confirmed: true });
    await request('/api/setup/config', { mode: 'active' });
    assert.equal((await request('/api/setup/status')).readiness.approved, true);
    let entered = false;
    const result = await runScan(root, 'local', 'primary', { runScanWithFn: async () => {
      entered = true;
      return { ok: true, skipped: true, reason: 'synthetic-scan-boundary' };
    } });
    assert.equal(result.ok, true);
    assert.equal(entered, true, 'the unmodified production readiness guard must admit the scan');
    assert.deepEqual(fs.readFileSync(markerFile), marker);
  });
  const publishedConfig = fs.readFileSync(configFile);
  const rejected = async (expectedMarker = marker) => {
    assert.equal((await request('/api/setup/status')).readiness.approved, false);
    let entered = false;
    await assert.rejects(runScan(root, 'local', 'primary', { runScanWithFn: async () => { entered = true; return { ok: true }; } }), /approved/);
    assert.equal(entered, false);
    assert.deepEqual(fs.readFileSync(markerFile), expectedMarker, 'an invalidation never rewrites approval');
  };
  for (const [label, change] of [
    ['provider', { ai: { provider: 'codex' } }],
    ['model', { ai: { local: { ...loadWorkspaceConfig(root).ai.local, model: 'synthetic-other-model' } } }],
    ['endpoint', { ai: { local: { ...loadWorkspaceConfig(root).ai.local, baseUrl: 'http://127.0.0.1:9/v1' } } }],
    ['profile', { profile: { tone: 'Changed reviewed evidence tone' } }],
    ['search', { search: { roleFamilies: ['Changed synthetic role'] } }],
    ['triage', { triage: { actionScore: 80 } }],
    ['locale', { locale: 'en-CA' }],
    ['currency', { currency: 'CAD' }],
    ['timezone', { timezone: 'America/Toronto' }],
    ['sources', { sources: { adzuna: { country: 'ca' } } }],
    ['commute', { commute: { maxMinutes: 30 } }],
    ['unknown search-profile field', { searchProfile: { ...loadWorkspaceConfig(root).searchProfile, futureApprovalField: 'unreviewed' } }],
    ['unknown config field', { futureApprovalField: 'unreviewed' }],
    ['unknown setup field', { setup: { futureApprovalField: 'unreviewed' } }],
  ]) {
    await t.test(`${label} changes still invalidate approval`, async () => {
      await request('/api/setup/config', change);
      await rejected();
      await request('/api/setup/config', { mode: 'background' });
      await rejected(); // An operational save cannot bless an unrelated edit.
    });
    fs.writeFileSync(configFile, publishedConfig);
  }
  for (const relative of ['profile/context.md', 'profile/calibration.md', 'cv/master-cv.md', 'data/search-categories.json']) {
    await t.test(`${relative} remains bound to the exact reviewed bytes`, async () => {
      const file = path.join(root, relative);
      const before = fs.readFileSync(file);
      try { fs.appendFileSync(file, '\nSynthetic unreviewed evidence change.\n'); await rejected(); }
      finally { fs.writeFileSync(file, before); }
    });
  }
  await t.test('legacy approval uses only the original hash-verified staged config', async () => {
    const legacy = JSON.parse(marker);
    delete legacy.configApproval;
    const legacyBytes = Buffer.from(JSON.stringify(legacy));
    const stagedFile = path.join(root, '.scout/onboarding/workspace.json');
    const stagedBytes = fs.readFileSync(stagedFile);
    fs.writeFileSync(markerFile, legacyBytes);
    try {
      assert.equal((await request('/api/setup/status')).readiness.approved, true);
      fs.appendFileSync(stagedFile, '\nSynthetic unreviewed staged change.\n');
      await rejected(legacyBytes);
      fs.rmSync(stagedFile);
      await rejected(legacyBytes);
      fs.writeFileSync(stagedFile, stagedBytes);
      const unbound = { ...legacy, stagedHashes: {} };
      const unboundBytes = Buffer.from(JSON.stringify(unbound));
      fs.writeFileSync(markerFile, unboundBytes);
      await rejected(unboundBytes);
    } finally {
      fs.writeFileSync(stagedFile, stagedBytes);
      fs.writeFileSync(markerFile, marker);
    }
  });
  await t.test('malformed or newer binding versions fail closed without legacy downgrade', async () => {
    for (const binding of [{ schemaVersion: 2, digest: '0'.repeat(64) }, { schemaVersion: 1, digest: 'invalid' }]) {
      const invalid = Buffer.from(JSON.stringify({ ...JSON.parse(marker), configApproval: binding }));
      fs.writeFileSync(markerFile, invalid);
      try { await rejected(invalid); }
      finally { fs.writeFileSync(markerFile, marker); }
    }
  });
  assert.equal(providerCalls, 1, 'settings and rejected scans must not contact a provider');
});
