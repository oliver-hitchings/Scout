import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ONBOARDING_FILES, activateOnboardingProposal, buildOnboardingEvidence, createOnboardingProposal,
  discardOnboardingProposal, readOnboardingProposal, validateOnboardingProposal,
} from './onboardingProposal.mjs';
import { DEFAULT_WORKSPACE_CONFIG, writeWorkspaceConfig } from './workspace.mjs';

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

test('onboarding evidence has stable IDs and oversized imports are never truncated', () => {
  const dir = root();
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json')));
  const evidence = buildOnboardingEvidence(dir, config);
  assert.ok(evidence.evidence.some((item) => item.id === 'config-roles'));
  assert.ok(evidence.evidence.some((item) => item.id === 'cv-0001'));
  assert.throws(() => buildOnboardingEvidence(dir, config, 10), /reduce it below/);
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
