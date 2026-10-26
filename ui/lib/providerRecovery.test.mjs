import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerRecoveryView } from './providerRecovery.mjs';
import { recordProviderHealth } from './providerHealth.mjs';
import { readPublicRunSummaries } from './scanHealth.mjs';
import { runScanPipeline } from './scanPipeline.mjs';

const JOB = { id: 'claude-primary', enabled: true, time: '07:30', mode: 'primary', provider: 'claude' };
const config = { ai: { provider: 'codex' }, schedule: { jobs: [JOB] } };
const blocked = (extra) => ({
  state: 'abandoned', terminalReason: 'sign-in-required', provider: 'claude', scheduleJobId: null, ...extra,
});
const usable = { state: 'ready', alert: null, checkedAt: '2026-10-25T08:00:00.000Z' };
const expired = (acknowledgedAt = null) => ({
  state: 'sign-in-required',
  checkedAt: '2026-10-25T07:30:00.000Z',
  alert: { id: 'provider-health:claude:sign-in-required', acknowledgedAt },
});
const view = (records, runs = [], cfg = config) => providerRecoveryView(
  '/synthetic', cfg, runs, (_root, provider) => {
    if (!records[provider]) throw new Error('unreadable');
    return records[provider];
  },
);

test('an expired session names the provider and its enabled scheduled jobs', () => {
  assert.deepEqual(view({ claude: expired(), codex: usable }), [{
    provider: 'claude',
    signInRequired: true,
    alertId: 'provider-health:claude:sign-in-required',
    acknowledged: false,
    jobs: [{ id: 'claude-primary', time: '07:30', mode: 'primary' }],
    missedJobIds: [],
    manualBlocked: false,
  }]);
  assert.equal(view({ claude: expired('2026-10-25T09:00:00.000Z') })[0].acknowledged, true);
});

test('a provider nothing uses, or whose record cannot be read, never raises a warning', () => {
  assert.deepEqual(view({ claude: expired() }, [], { ai: { provider: 'codex' }, schedule: { jobs: [] } }), []);
  assert.deepEqual(view({}), []);
  assert.deepEqual(view({ claude: expired() }, [], {
    ai: { provider: 'codex' }, schedule: { jobs: [{ ...JOB, enabled: false }] },
  }), []);
});

test('after reconnecting, a blocked scheduled window is offered until a later run supersedes it', () => {
  const runs = [blocked({ scheduleJobId: 'claude-primary' })];
  const [entry] = view({ claude: usable }, runs);
  assert.equal(entry.signInRequired, false);
  assert.deepEqual(entry.missedJobIds, ['claude-primary']);
  assert.equal(entry.manualBlocked, false);

  const later = [{ state: 'complete', provider: 'claude', scheduleJobId: 'claude-primary', terminalReason: null }, ...runs];
  assert.deepEqual(view({ claude: usable }, later), []);
});

test('after reconnecting, only the newest blocked manual scan is offered for retry', () => {
  assert.equal(view({ claude: usable }, [blocked()])[0].manualBlocked, true);
  const superseded = [
    { state: 'complete', provider: 'claude', scheduleJobId: 'claude-primary', terminalReason: null },
    blocked(),
  ];
  assert.deepEqual(view({ claude: usable }, superseded), []);
  // Another provider's blocked run never leaks into this provider's banner.
  assert.deepEqual(view({ claude: usable }, [blocked({ provider: 'codex' })]), []);
});

test('only a sign-in failure is offered for resume, not other abandoned runs', () => {
  assert.deepEqual(view({ claude: usable }, [blocked({ terminalReason: 'network-unavailable' })]), []);
  assert.deepEqual(view({ claude: usable }, [blocked({ state: 'failed' })]), []);
});

// The real producer of a blocked run (preflight failure) feeding the real consumer.
const COMPATIBILITY = Object.freeze({
  schemaVersion: 3,
  mode: 'primary',
  purpose: 'manual-discovery',
  profileVersion: 'profile-v1',
  sourceConfigFingerprint: 'a'.repeat(64),
  journalSchemaVersion: 1,
  artifactSchemaVersion: 1,
  pipelineVersion: 'pipeline-v1',
  rankingVersion: 'ranking-v1',
  promptVersion: 'prompt-v2',
  assessmentSchemaVersion: 2,
  provider: 'claude',
  model: 'provider-default',
  mutationSchemaVersion: 1,
  targetRevision: 'tracker-v1',
  scheduleJobId: 'none',
  logicalWindowId: 'none',
  stageArtifactSchemaVersion: 1,
  lanePlanGeneration: 'none',
  lanePlanRevision: 'b'.repeat(64),
  laneSelectionFingerprint: 'c'.repeat(64),
});

async function blockedRun(root, overrides = {}) {
  const result = await runScanPipeline({
    root,
    compatibility: { ...COMPATIBILITY, ...overrides },
    stages: Object.fromEntries(['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'].map((id) => [id, async () => assert.fail('blocked before any scan work')])),
    healthPreflight: async () => ({ ok: false, state: 'sign-in-required' }),
  });
  assert.equal(result.outcome, 'abandoned');
}

test('a real preflight-blocked scheduled and manual run both resume after a successful re-authentication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-recovery-'));
  try {
    await blockedRun(root, { scheduleJobId: 'claude-primary', logicalWindowId: 'window-1' });
    recordProviderHealth(root, 'claude', { kind: 'remote-auth-failure', source: 'scheduled-preflight' }, { purpose: 'scheduled-job' });
    const read = () => providerRecoveryView(root, config, readPublicRunSummaries(root).runs);

    assert.equal(read()[0].signInRequired, true);
    assert.deepEqual(read()[0].missedJobIds, ['claude-primary']);

    recordProviderHealth(root, 'claude', { kind: 'remote-success', source: 'post-auth' }, { purpose: 'post-auth' });
    assert.deepEqual(read().map(({ provider, signInRequired, missedJobIds, manualBlocked }) => (
      { provider, signInRequired, missedJobIds, manualBlocked }
    )), [{ provider: 'claude', signInRequired: false, missedJobIds: ['claude-primary'], manualBlocked: false }]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await blockedRun(root);
    assert.deepEqual(read().map(({ missedJobIds, manualBlocked }) => ({ missedJobIds, manualBlocked })), [
      { missedJobIds: ['claude-primary'], manualBlocked: true },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
