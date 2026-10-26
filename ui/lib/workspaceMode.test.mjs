import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWorkspaceDefaults, validateWorkspaceConfig } from './workspace.mjs';
import { buildConfig } from '../setup.js';

test('existing workspaces default to background watch and invalid modes are rejected', () => {
  assert.equal(mergeWorkspaceDefaults({}).mode, 'background');
  assert.throws(() => validateWorkspaceConfig({ ...mergeWorkspaceDefaults({}), mode: 'unexpected' }), /mode/);
});

test('onboarding keeps each workspace mode and does not change its locale', () => {
  const config = buildConfig({ mode: 'active', locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto' });
  assert.equal(config.mode, 'active');
  assert.equal(config.locale, 'fr-CA');
});

test('mode policy feeds existing assessment thresholds and bounds scan capacity', async () => {
  const { workspaceModePolicy } = await import('./workspaceMode.mjs');
  const background = workspaceModePolicy(mergeWorkspaceDefaults({}));
  const active = workspaceModePolicy(mergeWorkspaceDefaults({ mode: 'active' }));
  assert.deepEqual([background.triage.checkScore, background.triage.actionScore, background.resultCap, background.digestHours], [85, 95, 6, 0]);
  assert.deepEqual([active.triage.checkScore, active.triage.actionScore, active.resultCap, active.digestHours], [55, 70, 60, 24]);
  assert.equal(workspaceModePolicy({ mode: 'active', triage: { checkScore: 60, actionScore: 80 } }).triage.actionScore, 80);
});

test('raising the background threshold cannot turn a generic keep recommendation into an exceptional score', async () => {
  const { gateAssessment } = await import('./scanPipeline.mjs');
  const gate = gateAssessment({ recommendation: 'keep', mandatoryRequirements: [] }, { actionScore: 95, checkScore: 85 }, {});
  assert.equal(gate.keep, false);
  assert.equal(gate.score, 70);
});
