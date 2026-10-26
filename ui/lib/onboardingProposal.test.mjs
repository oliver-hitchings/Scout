import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import {
  ONBOARDING_FILES, activateOnboardingProposal, buildOnboardingEvidence, createOnboardingProposal,
  activatedProposalRecovery, discardOnboardingProposal, readOnboardingProposal, recoverActivatedProposal,
  recoverOnboardingActivationAtStartup, validateOnboardingProposal,
} from './onboardingProposal.mjs';
import { readProviderHealth, recordProviderHealth, recordProviderResultHealth } from './providerHealth.mjs';
import { ProviderLifecycleUnclosedError } from './structuredTurn.mjs';
import {
  acquireProviderAuthMutation, releaseProviderAuthMutation,
} from './providerAuthMutation.mjs';
import { acquireScanLease, currentLeaseOwner } from './scanLease.mjs';
import { DEFAULT_WORKSPACE_CONFIG, writeWorkspaceConfig } from './workspace.mjs';
import { approveLivingCv, configureLivingCv, livingCvStatus } from './livingCv.mjs';

test('rebuilding a profile after Living CV approval uses the approved version instead of stale imports', (t) => {
  const workspace = root();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-reprofile-'));
  const source = path.join(parent, 'source.md');
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(parent, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, 'cv'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'cv/master-cv.md'), 'Old CV evidence.');
  fs.writeFileSync(source, '# Updated confirmed CV\n' + 'Current responsibilities with verified evidence. '.repeat(24));
  configureLivingCv(workspace, source);
  approveLivingCv(workspace, { confirmed: true, revision: livingCvStatus(workspace).revision });
  const result = buildOnboardingEvidence(workspace, DEFAULT_WORKSPACE_CONFIG);
  assert.ok(result.evidence.some(({ text }) => text.includes('Current responsibilities')));
  assert.ok(!result.evidence.some(({ text }) => text.includes('Built reliable software systems')));
});

test('a newer CV approval during profile generation cannot be overwritten by an old-evidence proposal', async (t) => {
  const workspace = root();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-reprofile-race-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(parent, { recursive: true, force: true }); });
  const source = path.join(parent, 'cv.md');
  fs.mkdirSync(path.join(workspace, 'cv'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'cv/master-cv.md'), 'Earlier CV');
  fs.writeFileSync(source, '# Approved CV\n' + 'Confirmed earlier evidence. '.repeat(30));
  configureLivingCv(workspace, source);
  approveLivingCv(workspace, { revision: livingCvStatus(workspace).revision, confirmed: true });
  const newest = fs.readFileSync(source, 'utf8') + '\nThe newest confirmed fact must survive.\n';
  await assert.rejects(createOnboardingProposal(workspace, 'codex', {
    providerStatusFn: () => ({ installed: true, authenticated: true, capabilities: { structuredOutput: true } }),
    runStructuredTurnFn: async ({ validate }) => {
      const value = validate(proposal());
      fs.writeFileSync(source, newest);
      approveLivingCv(workspace, { revision: livingCvStatus(workspace).revision, confirmed: true });
      return { ok: true, value, usage: {} };
    },
  }), /changed|regenerate/i);
  assert.equal(fs.readFileSync(path.join(workspace, 'cv/master-cv.md'), 'utf8'), newest);
});

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-onboarding-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'opportunities.json'), '{"updated":"2026-07-14","opportunities":[]}\n');
  writeWorkspaceConfig(dir, {
    ...structuredClone(DEFAULT_WORKSPACE_CONFIG),
    profile: { displayName: 'Rowan', tone: 'direct' },
    search: { roleFamilies: ['Senior Software Engineer'], sectors: ['software'], locations: ['Manchester'], exclusions: ['gambling'], salaryMinimum: 60000 },
    ai: { provider: 'codex', model: null },
  });
  fs.writeFileSync(path.join(dir, 'imports', 'rowan.txt'), 'Built reliable software systems for synthetic employers only.\n');
  return dir;
}

const sourced = (text) => ({ text, evidenceIds: ['config-roles'] });
function proposal() {
  return {
    summary: 'Synthetic proposal', unresolvedQuestions: [],
    profile: { headline: sourced('Senior software engineer'), priorities: [sourced('Senior software roles')], evidence: [sourced('Software delivery evidence')], exclusions: [sourced('Exclude gambling')], tone: sourced('Direct evidence-led tone') },
    calibration: { dimensions: [{ name: 'Evidence fit', weight: 100, description: 'Advert and profile evidence' }], gates: ['Mandatory requirements need evidence'], actionScore: 70, checkScore: 55 },
    searchCategories: [{ id: 'senior-software', label: 'Senior software', description: 'Senior software roles', priority: 'primary', queries: ['senior software engineer'], keeperRule: 'Evidence-led fit' }],
    masterCv: {
      title: sourced('Rowan Testwell — Senior Software Engineer'),
      profile: sourced(Array.from({ length: 255 }, () => 'software').join(' ')),
      skills: [sourced('Reliable software delivery'), sourced('Technical leadership'), sourced('Evidence-led collaboration')],
      experience: [{ heading: sourced('Synthetic software experience'), bullets: [sourced('Built reliable software systems')] }],
      education: [], otherEvidence: [],
    },
  };
}

const status = () => ({ installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } });
const run = async () => ({ value: proposal(), usage: { input_tokens: 50 } });
const healthyDoctor = () => ({ checks: { config: { ok: true }, tracker: { ok: true }, providers: { codex: { installed: true, authenticated: true } } } });

test('reviewing and activating a rebuilt profile preserves the configured scan jobs exactly', async (t) => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
  const jobs = [
    { id: 'synthetic-primary', enabled: true, provider: 'codex', mode: 'primary', time: '07:15', days: [1, 3, 5], model: 'synthetic-model' },
    { id: 'synthetic-verification', enabled: false, provider: 'claude', mode: 'second-pass', time: '08:40', days: [2, 4], model: null },
  ];
  config.schedule = { jobs };
  writeWorkspaceConfig(dir, config);
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')).schedule.jobs, jobs, 'proposal generation must leave live schedules alone');
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')).schedule.jobs, jobs, 'profile activation must retain each enabled flag, provider, model, day and time');
});

test('local setup generates and activates a validated proposal over HTTP without a provider CLI', async (t) => {
  const dir = root();
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    assert.equal(request.model, 'synthetic/model-27b');
    assert.doesNotMatch(request.messages.at(-1).content, /apiKeyFile|baseUrl/);
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json')));
  config.ai = { provider: 'local', local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'synthetic/model-27b' } };
  writeWorkspaceConfig(dir, config);
  const staged = await createOnboardingProposal(dir, 'local');
  assert.equal(staged.valid, true);
  assert.equal(readProviderHealth(dir, 'local').state, 'ready');
  assert.equal(activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: () => ({ checks: { config: { ok: true }, tracker: { ok: true }, providers: { local: { installed: true, authenticated: true } } } }) }).ok, true);
  assert.equal(calls, 1, 'approval must consume no additional provider call');
  assert.match(fs.readFileSync(path.join(dir, 'cv', 'master-cv.md'), 'utf8'), /evidence: config-roles/);
});

test('onboarding production preflight keeps a known remote auth failure authoritative', async (t) => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordProviderHealth(dir, 'codex', { kind: 'remote-auth-failure', source: 'provider-operation' }, { purpose: 'manual-run' });
  let calls = 0;
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn() { calls += 1; return run(); },
  }), /sign.in|reconnect/i);
  assert.equal(calls, 0);
});

test('onboarding commits real success health while its provider work still excludes login', async (t) => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let excluded;
  await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
    async recordProviderResultHealthFn(...args) {
      const mutation = acquireProviderAuthMutation(dir, 'codex');
      excluded = mutation === null;
      if (mutation) releaseProviderAuthMutation(dir, mutation);
      return recordProviderResultHealth(...args);
    },
  });
  assert.equal(excluded, true);
  assert.equal(readProviderHealth(dir, 'codex').state, 'ready');
});

test('onboarding evidence has stable IDs and oversized imports are never truncated', () => {
  const dir = root();
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json')));
  const evidence = buildOnboardingEvidence(dir, config);
  assert.ok(evidence.evidence.some((item) => item.id === 'config-roles'));
  assert.ok(evidence.evidence.some((item) => item.id === 'cv-0001'));
  assert.throws(() => buildOnboardingEvidence(dir, config, 10), /reduce it below/);
});

test('onboarding evidence refuses import symlinks before reading provider input', () => {
  if (process.platform === 'win32') return;
  const dir = root();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-host-secret-')), 'secret.txt');
  fs.writeFileSync(outside, 'SYNTHETIC_HOST_SECRET');
  fs.symlinkSync(outside, path.join(dir, 'imports', 'escaped.txt'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json')));
  assert.throws(
    () => buildOnboardingEvidence(dir, config),
    /symlink|junction/,
  );
});

test('proposal validation rejects invented evidence IDs and bad score arithmetic', () => {
  const valid = proposal();
  const evidence = [{ id: 'config-roles' }];
  assert.equal(validateOnboardingProposal(valid, evidence), valid);
  const invented = structuredClone(valid);
  invented.masterCv.title.evidenceIds = ['invented'];
  assert.throws(() => validateOnboardingProposal(invented, evidence), /unknown evidence IDs/);
  const arithmetic = structuredClone(valid);
  arithmetic.calibration.dimensions[0].weight = 99;
  assert.throws(() => validateOnboardingProposal(arithmetic, evidence), /total 100/);
});

test('proposal staging, explicit zero-AI activation and discard are isolated', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run, now: () => '2026-07-14T10:00:00.000Z' });
  assert.equal(staged.valid, true);
  assert.equal(readOnboardingProposal(dir).files.length, 5);
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, false, { doctorFn: healthyDoctor }), /explicit/);
  const active = activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor, now: () => '2026-07-14T10:05:00.000Z' });
  assert.equal(active.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'cv', 'master-cv.md'), 'utf8'), /evidence: config-roles/);
  assert.equal(readOnboardingProposal(dir), null);
  assert.equal(discardOnboardingProposal(dir).ok, true);
  assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activated.json')), true);
});

test('activation holds the shared backup lease across every active-file replacement', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: run,
  });
  let checked = false;
  activateOnboardingProposal(dir, staged.proposalId, true, {
    doctorFn: healthyDoctor,
    _testHooks: {
      beforeWrite(relative) {
        if (checked || relative !== 'workspace.json') return;
        checked = true;
        const backup = acquireScanLease(dir, currentLeaseOwner(), {
          kind: 'backup',
          runId: 'activation-backup',
          phase: 'checkpoint',
        });
        assert.equal(backup, null);
      },
    },
  });
  assert.equal(checked, true);
});

test('ordinary failure after activation-marker publication removes the marker before rollback', async () => {
  const dir = root();
  const original = Object.fromEntries(ONBOARDING_FILES.map((relative) => [
    relative, fs.existsSync(path.join(dir, relative))
      ? fs.readFileSync(path.join(dir, relative), 'utf8')
      : null,
  ]));
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: run,
  });
  assert.throws(
    () => activateOnboardingProposal(dir, staged.proposalId, true, {
      doctorFn: healthyDoctor,
      _testHooks: {
        afterActivatedMarker() { throw new Error('synthetic terminal write failure'); },
      },
    }),
    /synthetic terminal write failure/,
  );
  assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activated.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), false);
  for (const relative of ONBOARDING_FILES) {
    if (original[relative] === null) assert.equal(fs.existsSync(path.join(dir, relative)), false);
    else assert.equal(fs.readFileSync(path.join(dir, relative), 'utf8'), original[relative]);
  }
});

test('onboarding records remote-auth failure without resending proposal generation', async () => {
  const dir = root();
  let invocations = 0;
  const remoteAuthFailure = async () => {
    invocations += 1;
    const error = new Error('codex structured turn failed: authentication is required');
    Object.defineProperty(error, 'reasonCode', { value: 'authentication-required' });
    throw error;
  };

  await assert.rejects(
    createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status,
      runStructuredTurnFn: remoteAuthFailure,
    }),
    /authentication is required/,
  );

  assert.equal(invocations, 1);
  assert.equal(readProviderHealth(dir, 'codex').state, 'sign-in-required');
  assert.equal(readProviderHealth(dir, 'codex').remoteAuthBarrier, true);
  assert.equal(readOnboardingProposal(dir), null);
});

test('onboarding proposal generation obeys the durable per-provider auth barrier', async () => {
  const dir = root();
  const mutation = acquireProviderAuthMutation(dir, 'codex', {
    owner: { host: 'synthetic-host', pid: 42, processStart: 'synthetic-start' },
    mutationId: 'onboarding-auth-mutation',
  });
  let invocations = 0;
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: async () => {
      invocations += 1;
      return { value: proposal(), usage: {} };
    },
  }), (error) => error.reasonCode === 'provider-auth-in-progress');
  assert.equal(invocations, 0);
  assert.equal(readOnboardingProposal(dir), null);

  const claude = await createOnboardingProposal(dir, 'claude', {
    providerStatusFn: status,
    runStructuredTurnFn: async () => {
      invocations += 1;
      return { value: proposal(), usage: {} };
    },
  });
  assert.equal(claude.provider, 'claude');
  assert.equal(invocations, 1);
  releaseProviderAuthMutation(dir, mutation);
});

test('onboarding transfers provider-work fencing until an unclosed turn really closes', async () => {
  const dir = root();
  let close;
  const closure = new Promise((resolve) => { close = resolve; });
  let releases = 0;
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: async () => {
      throw new ProviderLifecycleUnclosedError('provider child remains open', closure);
    },
    recordProviderResultHealthFn: async () => {},
    acquireProviderWorkFn: () => ({ provider: 'codex', workId: 'onboarding-work-01' }),
    renewProviderWorkFn: (_root, capability) => capability,
    releaseProviderWorkFn: () => { releases += 1; },
  }), /provider child remains open/);
  assert.equal(releases, 0);
  close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
});

test('activation rejects stale targets and rolls back every active file if doctor fails', async () => {
  const dir = root();
  let staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  fs.appendFileSync(path.join(dir, '.scout', 'onboarding', 'cv', 'master-cv.md'), '\ntampered\n');
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor }), /staged cv\/master-cv.md changed/);
  discardOnboardingProposal(dir);

  staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'context.md'), 'changed after generation\n');
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor }), /changed after proposal/);
  discardOnboardingProposal(dir);

  staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  const before = Object.fromEntries(ONBOARDING_FILES.map((relative) => [relative, fs.existsSync(path.join(dir, ...relative.split('/'))) ? fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8') : null]));
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: () => ({ checks: {} }) }), /doctor rejected/);
  for (const relative of ONBOARDING_FILES) {
    const file = path.join(dir, ...relative.split('/'));
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before[relative], relative);
  }
});

test('startup reconciles a prepared activation after process death at every replacement', async () => {
  for (const interruptedAfter of ONBOARDING_FILES) {
    const dir = root();
    const staged = await createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status, runStructuredTurnFn: run,
    });
    const crash = new Error(`synthetic process death after ${interruptedAfter}`);
    crash.simulateProcessDeath = true;
    assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, {
      doctorFn: healthyDoctor,
      now: () => '2026-07-14T10:05:00.000Z',
      _testHooks: {
        afterWrite(relative) {
          if (relative === interruptedAfter) throw crash;
        },
      },
    }), /synthetic process death/);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), true);
    const recovered = recoverOnboardingActivationAtStartup(dir, { doctorFn: healthyDoctor });
    assert.equal(recovered.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'))).setup.completedAt,
      '2026-07-14T10:05:00.000Z');
  }
});

test('activation recovery preserves conflicting post-crash user state and its intent', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  });
  const crash = new Error('synthetic process death');
  crash.simulateProcessDeath = true;
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, {
    doctorFn: healthyDoctor,
    _testHooks: {
      afterWrite(relative) {
        if (relative === 'workspace.json') throw crash;
      },
    },
  }), /synthetic process death/);
  const context = path.join(dir, 'profile', 'context.md');
  fs.mkdirSync(path.dirname(context), { recursive: true });
  fs.writeFileSync(context, 'a legitimate post-crash user mutation\n');

  assert.throws(
    () => recoverOnboardingActivationAtStartup(dir, { doctorFn: healthyDoctor }),
    /conflicts with prepared onboarding activation/,
  );
  assert.equal(fs.readFileSync(context, 'utf8'), 'a legitimate post-crash user mutation\n');
  assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), true);
  assert.throws(() => discardOnboardingProposal(dir), /requires recovery/);
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  }), /requires recovery/);
});

test('startup finalises activation after death in each terminal cleanup window', async () => {
  for (const hook of ['afterActivatedMarker', 'afterProposalRemoval']) {
    const dir = root();
    const staged = await createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status, runStructuredTurnFn: run,
    });
    const crash = new Error(`synthetic process death at ${hook}`);
    crash.simulateProcessDeath = true;
    assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, {
      doctorFn: healthyDoctor,
      now: () => '2026-07-14T10:05:00.000Z',
      _testHooks: { [hook]: () => { throw crash; } },
    }), /synthetic process death/);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), true);
    const recovered = recoverOnboardingActivationAtStartup(dir, { doctorFn: healthyDoctor });
    assert.equal(recovered.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), false);
    assert.equal(readOnboardingProposal(dir), null);
  }
});

test('activated empty master CV recovery is narrow, backed up, and integrity checked', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  const active = path.join(dir, 'cv', 'master-cv.md');
  const reviewed = fs.readFileSync(path.join(dir, '.scout', 'onboarding', 'cv', 'master-cv.md'), 'utf8');
  fs.writeFileSync(active, '');
  assert.equal(activatedProposalRecovery(dir).available, true);
  assert.throws(() => recoverActivatedProposal(dir, false, { doctorFn: healthyDoctor }), /explicit recovery confirmation/);
  const recovered = recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor, now: () => '2026-07-14T11:00:00.000Z' });
  assert.equal(recovered.restoredBytes, Buffer.byteLength(reviewed));
  assert.equal(fs.readFileSync(active, 'utf8'), reviewed);
  assert.equal(fs.statSync(path.join(recovered.backupDir, 'cv', 'master-cv.md')).size, 0);
  assert.equal(activatedProposalRecovery(dir).available, false);
});

test('activated CV recovery cannot overlap another workspace mutation owner', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  fs.writeFileSync(path.join(dir, 'cv', 'master-cv.md'), '');
  const lease = acquireScanLease(dir, currentLeaseOwner(), {
    kind: 'backup', runId: 'recovery-overlap', phase: 'checkpoint',
  });
  assert.throws(
    () => recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor }),
    /mutation|progress|authority|lease/i,
  );
  assert.ok(lease);
});

test('activated CV recovery never rolls back after its mutation fence is lost during doctor', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  const active = path.join(dir, 'cv', 'master-cv.md');
  fs.writeFileSync(active, '');
  const successorContent = '# Successor-owned master CV\n\nThis content belongs to the new mutation owner.\n';
  assert.throws(
    () => recoverActivatedProposal(dir, true, {
      doctorFn: () => {
        fs.rmSync(path.join(dir, '.scout', 'scan-lease.json'), { force: true });
        fs.writeFileSync(active, successorContent);
        return healthyDoctor();
      },
    }),
    /mutation|progress|authority|lease/i,
  );
  assert.equal(fs.readFileSync(active, 'utf8'), successorContent);
});

test('activated master CV recovery refuses unrelated active-file drift', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  fs.writeFileSync(path.join(dir, 'cv', 'master-cv.md'), '');
  fs.appendFileSync(path.join(dir, 'profile', 'context.md'), '\nunreviewed change\n');
  assert.equal(activatedProposalRecovery(dir).available, false);
  assert.throws(() => recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor }), /no longer matches/);
});

test('activated master CV recovery refuses workspace drift beyond activation time', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  fs.writeFileSync(path.join(dir, 'cv', 'master-cv.md'), '');
  const workspaceFile = path.join(dir, 'workspace.json');
  const config = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  config.search.locations = ['Unreviewed place'];
  fs.writeFileSync(workspaceFile, `${JSON.stringify(config, null, 2)}\n`);
  assert.equal(activatedProposalRecovery(dir).available, false);
  assert.throws(() => recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor }), /workspace\.json no longer matches/);
});

test('generated onboarding instructions use the workspace locale for every proposal', async () => {
  const dir = root();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    config.locale = 'fr-CA';
    writeWorkspaceConfig(dir, config);
    let prompt;
    await createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status,
      runStructuredTurnFn: async (options) => {
        prompt = options.prompt;
        return run();
      },
    });
    assert.match(prompt, /Create concise profile and CV content using the workspace locale fr-CA/);
    assert.doesNotMatch(prompt, /UK[- ]English|British English/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
