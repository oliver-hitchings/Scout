import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compactCandidates, gateAssessment, validateAssessments, validateWrittenScanArtifacts, writeScanArtifacts } from './scanPipeline.mjs';

const dimensions = [{ name: 'Fit', score: 90, maximum: 100, evidence: 'Advert and profile' }];
const assessment = (status = 'met') => ({
  candidateId: 'candidate-001', categoryId: 'software', summary: 'Synthetic fit', hardExclusionMatches: [],
  mandatoryRequirements: [{ requirement: 'AWS', advertEvidence: 'AWS is required', advertEvidenceId: 'provider-aws', status, profileEvidence: status === 'met' ? 'Built systems on AWS' : null }],
  dimensions, recommendation: 'keep',
});

test('candidate input is deduplicated, capped and descriptions are bounded', () => {
  const job = { company: 'Acme', title: 'Engineer', url: 'https://example.test/job', description: 'x'.repeat(2000) };
  const result = compactCandidates({ one: { jobs: [job, job] } }, 40);
  assert.equal(result.length, 1);
  assert.equal(result[0].description.length, 1200);
});

test('candidate input collapses the same cross-provider role and preserves every source', () => {
  const description = 'Build reliable Kubernetes services with AWS observability and mentor engineers.';
  const result = compactCandidates({
    one: { jobs: [{ company: 'Acme Ltd', title: 'Senior Platform Engineer', location: 'London, UK', url: 'https://a.test/1?utm_source=feed', source: 'adzuna', providerId: 'a1', description }] },
    two: { jobs: [{ company: 'Acme', title: 'Senior Platform Engineer', location: 'London', url: 'https://g.test/9', source: 'ats-greenhouse', providerId: 'g9', description }] },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].duplicateCount, 2);
  assert.deepEqual(result[0].sources, ['https://a.test/1', 'https://g.test/9']);
});

test('candidate input keeps similar but distinct openings separate', () => {
  const common = { company: 'Acme', location: 'London', source: 'ats-greenhouse', description: 'Build reliable platform services.' };
  const result = compactCandidates({ one: { jobs: [
    { ...common, title: 'Software Engineer', providerId: 'one', url: 'https://x.test/1' },
    { ...common, title: 'Software Engineer', providerId: 'two', url: 'https://x.test/2' },
    { ...common, title: 'Staff Software Engineer', providerId: 'three', url: 'https://x.test/3' },
  ] } });
  assert.equal(result.length, 3);
});

test('mandatory advert language is assigned stable signals that assessments cannot omit', () => {
  const candidates = compactCandidates({ one: { jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job', description: 'AWS is required. Mentoring is helpful.' }] } });
  assert.deepEqual(candidates[0].mandatorySignals, [{ id: 'mandatory-01', text: 'AWS is required' }]);
  assert.throws(() => validateAssessments({ assessments: [assessment('met')] }, candidates), /omitted mandatory advert evidence/);
  const covered = assessment('unknown');
  covered.mandatoryRequirements[0].advertEvidenceId = 'mandatory-01';
  assert.equal(validateAssessments({ assessments: [covered] }, candidates).assessments.length, 1);
});

test('normalized source requirement summaries are mandatory without keyword heuristics', () => {
  const candidates = compactCandidates({ one: { jobs: [{
    company: 'Example', title: 'Senior Rust Engineer', url: 'https://example.test/rust',
    description: 'Build cross-platform libraries.',
    requirements: 'Rust software engineer with cross-platform experience; fluent in English; eligible for stock options',
  }] } });
  assert.deepEqual(candidates[0].mandatorySignals, [
    { id: 'mandatory-01', text: 'Rust software engineer with cross-platform experience' },
    { id: 'mandatory-02', text: 'fluent in English' },
  ]);
  const missingRust = {
    ...assessment('unknown'), candidateId: candidates[0].candidateId,
    mandatoryRequirements: [
      { requirement: 'Rust and cross-platform experience', advertEvidence: candidates[0].mandatorySignals[0].text, advertEvidenceId: 'mandatory-01', status: 'unknown', profileEvidence: null },
      { requirement: 'English', advertEvidence: candidates[0].mandatorySignals[1].text, advertEvidenceId: 'mandatory-02', status: 'met', profileEvidence: 'English CV evidence' },
    ],
  };
  assert.equal(validateAssessments({ assessments: [missingRust] }, candidates).assessments.length, 1);
  assert.equal(gateAssessment(missingRust, { actionScore: 70, checkScore: 55 }).score, 69);
  assert.equal(gateAssessment(missingRust, { actionScore: 70, checkScore: 55 }).eligibility, 'check');
});

test('mandatory and exclusion gates recompute trusted scores and bands', () => {
  assert.deepEqual(gateAssessment(assessment('unmet'), { actionScore: 70, checkScore: 55 }), {
    eligibility: 'ineligible', score: 54, keep: false, reasons: ['AWS'],
  });
  assert.deepEqual(gateAssessment(assessment('unknown'), { actionScore: 70, checkScore: 55 }), {
    eligibility: 'check', score: 69, keep: true, reasons: ['AWS'],
  });
  const excluded = assessment('met');
  excluded.hardExclusionMatches = ['gambling'];
  assert.equal(gateAssessment(excluded, { actionScore: 70, checkScore: 55 }).keep, false);
  assert.throws(() => validateAssessments({ assessments: [{ ...assessment('met'), dimensions: [{ ...dimensions[0], score: 101 }] }] }, [{ candidateId: 'candidate-001' }]), /invalid score/);
  assert.throws(() => validateAssessments({ assessments: [] }, [{ candidateId: 'candidate-001' }]), /covered 0 of 1/);
});

test('runtime writes canonical scan records and preserves user tracker state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-scan-pipeline-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const existing = { updated: '2026-07-01', opportunities: [{
    id: 'acme-engineer-2026-07', company: 'Acme', role: 'Engineer', score: 60, status: 'watch',
    sources: ['https://example.test/job'], tags: ['user-tag'], notes: 'user note', contacts: [{ name: 'Synthetic' }], log: [{ date: '2026-07-01', event: 'replied', note: '' }],
  }] };
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify(existing)}\n`);
  const candidates = [{ candidateId: 'candidate-001', company: 'Acme', role: 'Engineer', url: 'https://example.test/job', source: 'hiring_cafe' }];
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', queries: ['engineer'], startedAt: '2026-07-14T10:00:00Z', candidates,
    sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [] } },
    assessmentResult: { assessments: [assessment('met')] }, policy: { actionScore: 70, checkScore: 55 },
  });
  assert.equal(artifacts.run.schemaVersion, 2);
  assert.deepEqual(artifacts.run.sources_checked, ['hiring_cafe']);
  assert.deepEqual(artifacts.run.queries_checked, ['engineer']);
  assert.equal(artifacts.run.candidates_found, 1);
  assert.equal(artifacts.run.duplicates_collapsed, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8')).opportunities[0];
  assert.equal(saved.status, 'watch');
  assert.equal(saved.notes, 'user note');
  assert.deepEqual(saved.contacts, [{ name: 'Synthetic' }]);
  assert.deepEqual(saved.log, [{ date: '2026-07-01', event: 'replied', note: '' }]);
  assert.equal(saved.eligibility.status, 'eligible');
  assert.equal(validateWrittenScanArtifacts(root, artifacts.run).run.agent, 'codex');
});

test('two same-day providers remain visible in one combined report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-combined-report-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const input = {
    sources: { ats: { configured: true, status: 'healthy', count: 0 } },
    candidates: [], assessmentResult: { assessments: [] }, policy: {}, startedAt: new Date().toISOString(),
  };
  writeScanArtifacts(root, { ...input, provider: 'claude', mode: 'primary' });
  const second = writeScanArtifacts(root, { ...input, provider: 'codex', mode: 'second-pass' });
  const report = fs.readFileSync(second.report, 'utf8');
  assert.match(report, /## Scan runs/);
  assert.match(report, /claude primary/);
  assert.match(report, /codex second-pass/);
});

test('later cross-provider reposts update one opportunity without losing user-owned state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-dedupe-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const description = 'Build reliable Kubernetes services with AWS observability and mentor engineers across production systems.';
  const existing = { updated: '2026-06-01', opportunities: [{
    id: 'acme-senior-platform-engineer-2026-06', company: 'Acme Ltd', role: 'Senior Platform Engineer', location: 'London, UK',
    status: 'interview', notes: 'Keep this note', application: { stages: [{ name: 'Interview' }] },
    sources: ['https://a.test/old'], sourceReferences: [{ source: 'adzuna', providerId: 'a1', url: 'https://a.test/old' }],
    jobIdentity: { company: 'acme', title: 'senior platform engineer', location: 'london uk', advertFingerprint: description },
    tags: [], contacts: [], log: [],
  }] };
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify(existing)}\n`);
  const candidates = compactCandidates({ ats: { jobs: [{
    company: 'Acme', title: 'Senior Platform Engineer', location: 'London', source: 'ats-greenhouse', providerId: 'g9',
    url: 'https://g.test/new', description,
  }] } });
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { ats: { configured: true, status: 'healthy', count: 1 } },
    candidates, assessmentResult: { assessments: [assessment('met')] }, policy: { actionScore: 70, checkScore: 55 },
    startedAt: '2026-08-01T10:00:00Z',
  });
  assert.equal(artifacts.tracker.opportunities.length, 1);
  assert.equal(artifacts.run.keepers_added, 0);
  assert.equal(artifacts.run.keepers_updated, 1);
  const saved = artifacts.tracker.opportunities[0];
  assert.equal(saved.id, 'acme-senior-platform-engineer-2026-06');
  assert.equal(saved.status, 'interview');
  assert.equal(saved.notes, 'Keep this note');
  assert.deepEqual(saved.application, { stages: [{ name: 'Interview' }] });
  assert.deepEqual(saved.sources, ['https://a.test/old', 'https://g.test/new']);
});

test('zero configured sources is degraded and still produces a truthful empty run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-empty-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { hiring_cafe: { configured: false, status: 'unavailable', count: 0 } },
    queries: [], candidates: [], assessmentResult: null, policy: {}, startedAt: '2026-07-14T10:00:00Z',
  });
  assert.equal(artifacts.run.degraded, true);
  assert.deepEqual(artifacts.run.errors, ['no job sources are configured']);
  assert.equal(artifacts.run.candidates_found, 0);
});

test('trusted runtime applies configured hard exclusions even when provider omits them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-exclusion-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const candidates = [{ candidateId: 'candidate-001', company: 'BetCo', role: 'Engineer', url: 'https://example.test/job', source: 'ats', description: 'Gambling platform' }];
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { ats: { configured: true, status: 'healthy', count: 1 } },
    candidates, assessmentResult: { assessments: [assessment('met')] }, policy: { actionScore: 70, checkScore: 55 },
    exclusions: ['gambling'], startedAt: '2026-07-14T10:00:00Z',
  });
  assert.equal(artifacts.tracker.opportunities.length, 0);
  assert.equal(artifacts.run.discarded.hard_exclusion, 1);
});
