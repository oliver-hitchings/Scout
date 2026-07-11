import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  CURRENT_WORKSPACE_SCHEMA, defaultWorkspaceRoot, mergeWorkspaceDefaults, migrateWorkspace, resolveWorkspaceRoot,
  validateWorkspaceConfig, workspacePaths,
} from './workspace.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-workspace-')); roots.push(root); return root; }

test('explicit workspace overrides backwards-compatible app root', () => {
  const appRoot = temp();
  fs.mkdirSync(path.join(appRoot, 'data'));
  fs.writeFileSync(path.join(appRoot, 'data', 'opportunities.json'), '{}');
  assert.equal(resolveWorkspaceRoot({ appRoot, argv: ['--workspace', 'C:/private/scout'], env: {} }), path.resolve('C:/private/scout'));
  assert.equal(resolveWorkspaceRoot({ appRoot, argv: [], env: {} }), path.resolve(appRoot));
});

test('fresh app defaults to Documents workspace', () => {
  const appRoot = temp();
  const home = path.join(appRoot, 'home');
  assert.equal(defaultWorkspaceRoot(home), path.join(home, 'Documents', 'Scout Workspace'));
});

test('workspace paths stay under the selected root', () => {
  const root = temp();
  for (const value of Object.values(workspacePaths(root))) assert.ok(value === path.resolve(root) || value.startsWith(`${path.resolve(root)}${path.sep}`));
});

test('migration creates a valid schema-one workspace', () => {
  const root = temp();
  const result = migrateWorkspace(root);
  assert.equal(result.to, CURRENT_WORKSPACE_SCHEMA);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'));
  assert.equal(validateWorkspaceConfig(config).schemaVersion, CURRENT_WORKSPACE_SCHEMA);
});

test('workspace defaults are merged deeply for older schema-one files', () => {
  const merged = mergeWorkspaceDefaults({
    schemaVersion: 1, locale: 'en-US', currency: 'USD', timezone: 'America/New_York',
    profile: { displayName: 'A User' }, search: { roleFamilies: ['designer'] },
  });
  assert.equal(merged.profile.tone, 'natural, direct and evidence-led');
  assert.deepEqual(merged.search.locations, []);
  assert.equal(merged.triage.actionScore, 70);
  assert.equal(merged.sources.adzuna.country, 'gb');
});
