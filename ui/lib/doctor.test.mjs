import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor, publicDoctor } from './doctor.mjs';
import { seedWorkspace } from './workspace.mjs';
import { recordProviderHealth } from './providerHealth.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const unavailableProviders = () => ({
  codex: { installed: false, authenticated: false },
  claude: { installed: false, authenticated: false },
});
const managedTypst = () => ({ available: true, source: 'managed', command: '/app/.scout-runtime/typst', version: 'typst 0.14.2' });

test('doctor cannot advertise local credentials as signed in after a real remote auth failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-doctor-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedWorkspace(APP_ROOT, root);
  recordProviderHealth(root, 'codex', {
    kind: 'remote-auth-failure', source: 'provider-operation',
  }, { purpose: 'manual-run' });
  const result = publicDoctor(doctor(root, {
    providers: { codex: { installed: true, authenticated: true, capabilities: { structuredOutput: true } } },
    typstResolver: managedTypst,
  }));
  assert.equal(result.checks.providers.codex.authenticated, false);
  assert.equal(result.providerSetupRequired, true);
  assert.equal(result.ok, false);
});

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

test('public doctor projection omits paths, configuration values and provider diagnostics', () => {
  const privatePath = ['', 'Users', 'private', 'Scout Workspace'].join('/');
  const projected = publicDoctor({
    ok: false,
    workspaceRoot: privatePath,
    providerSetupRequired: true,
    checks: {
      config: { ok: false, error: `failed at ${privatePath}`, value: { displayName: 'Private Person' } },
      tracker: { ok: true, path: `${privatePath}/data/opportunities.json` },
      git: { ok: false, version: `git private@example.test ${privatePath}`, optional: true },
      typst: { ok: true, command: `${privatePath}/typst`, source: 'managed', optional: false },
      providers: {
        codex: {
          installed: true,
          authenticated: false,
          executable: `${privatePath}/codex`,
          authMessage: `token=${['PRIVATE', 'SECRET'].join('-')}`,
          capabilities: { structuredOutput: true, privateValue: 'secret' },
        },
      },
      adzuna: { ok: false, optional: true },
    },
  });
  assert.deepEqual(projected, {
    ok: false,
    providerSetupRequired: true,
    checks: {
      config: { ok: false },
      tracker: { ok: true },
      git: { ok: false, optional: true },
      typst: { ok: true, optional: false },
      providers: {
        codex: {
          installed: true,
          authenticated: false,
          capabilities: { structuredOutput: true },
        },
      },
      adzuna: { ok: false, optional: true },
    },
  });
  assert.doesNotMatch(JSON.stringify(projected), /Users|Private Person|person@|token|SECRET|path|command|version/i);
});
