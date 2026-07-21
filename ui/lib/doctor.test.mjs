import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.mjs';
import { seedWorkspace } from './workspace.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const unavailableProviders = () => ({
  codex: { installed: false, authenticated: false },
  claude: { installed: false, authenticated: false },
});
const managedTypst = () => ({ available: true, source: 'managed', command: '/app/.scout-runtime/typst', version: 'typst 0.14.2' });

test('restore validation accepts a structurally valid workspace before provider setup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-doctor-'));
  try {
    seedWorkspace(APP_ROOT, root);
    assert.equal(doctor(root, { providerDetector: unavailableProviders, typstResolver: managedTypst }).ok, false);
    const restoreHealth = doctor(root, { requireProvider: false, providerDetector: unavailableProviders, typstResolver: managedTypst });
    assert.equal(restoreHealth.ok, true);
    assert.equal(restoreHealth.providerSetupRequired, true);
    assert.equal(restoreHealth.checks.typst.source, 'managed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
