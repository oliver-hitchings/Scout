import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { setupReadiness } from './setupReadiness.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture({ approved = false, history = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-ready-')); roots.push(root);
  for (const [file, text] of [['profile/context.md', 'x'.repeat(600)], ['profile/calibration.md', 'x'.repeat(150)], ['cv/master-cv.md', 'x'.repeat(600)]]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text);
  }
  if (approved) { fs.mkdirSync(path.join(root, '.scout/onboarding'), { recursive: true }); fs.writeFileSync(path.join(root, '.scout/onboarding/activated.json'), '{}'); }
  return { root, tracker: { opportunities: history ? [{ id: 'legacy-role-2026-07' }] : [] } };
}
const config = { profile: { displayName: 'Sam' }, search: { roleFamilies: ['Software Engineer'], locations: ['Remote'], exclusions: [], salaryMinimum: null }, ai: { provider: 'codex' } };
const providers = { codex: { installed: true, authenticated: true } };
test('fresh setup requires explicit activation evidence', () => { const f = fixture(); assert.equal(setupReadiness(f.root, config, providers, f.tracker).ready, false); });
test('approved profession-neutral setup is ready with an empty tracker', () => { const f = fixture({ approved: true }); assert.equal(setupReadiness(f.root, config, providers, f.tracker).ready, true); });
test('established beta workspaces are grandfathered without resetting', () => { const f = fixture({ history: true }); const r = setupReadiness(f.root, config, providers, f.tracker); assert.equal(r.established, true); assert.equal(r.ready, true); });
test('missing provider authentication blocks readiness', () => { const f = fixture({ approved: true }); assert.equal(setupReadiness(f.root, config, { codex: { installed: true, authenticated: false } }, f.tracker).ready, false); });
