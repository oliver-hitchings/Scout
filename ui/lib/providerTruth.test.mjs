import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  acknowledgeProviderAlert, providerPreflight, readProviderHealth, recordProviderHealth,
} from './providerHealth.mjs';
import {
  acquireProviderAuthMutation, releaseProviderAuthMutation,
} from './providerAuthMutation.mjs';
import { publicProviderStatus } from './providerPresentation.mjs';
import { providerCardPresentation, providerLoginPanelHtml } from '../setup.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-truth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a real auth mutation cannot hide a remote authentication failure', async (t) => {
  const root = fixture(t);
  const mutation = acquireProviderAuthMutation(root, 'codex');
  assert.ok(mutation);
  try {
    recordProviderHealth(root, 'codex', {
      kind: 'remote-auth-failure', source: 'provider-operation',
    }, { purpose: 'manual-run' });
    assert.equal(readProviderHealth(root, 'codex').remoteAuthBarrier, true);
  } finally {
    releaseProviderAuthMutation(root, mutation);
  }
  recordProviderHealth(root, 'codex', {
    kind: 'local-credentials-present', source: 'periodic',
  }, { purpose: 'periodic' });
  assert.equal((await providerPreflight(root, 'codex', 'manual-run')).ok, false);
});

test('rechecking and signing in preserve an acknowledged remote-auth failure until real success', async (t) => {
  const root = fixture(t);
  const failed = recordProviderHealth(root, 'claude', {
    kind: 'remote-auth-failure', source: 'provider-operation',
  }, { purpose: 'manual-run' });
  acknowledgeProviderAlert(root, 'claude', failed.alert.id);
  const acknowledged = readProviderHealth(root, 'claude').alert;
  for (const kind of ['check-started', 'login-started', 'local-credentials-present', 'network-failure']) {
    const current = recordProviderHealth(root, 'claude', {
      kind, source: 'periodic',
    }, { purpose: 'periodic' });
    assert.equal(current.state, 'sign-in-required', kind);
    assert.deepEqual(current.alert, acknowledged, kind);
    assert.equal(current.shouldNotify, false, kind);
  }
  assert.equal((await providerPreflight(root, 'claude', 'manual-run')).ok, false);
  recordProviderHealth(root, 'claude', {
    kind: 'remote-success', source: 'provider-operation',
  }, { purpose: 'manual-run' });
  assert.equal((await providerPreflight(root, 'claude', 'manual-run')).ok, true);
  assert.equal(readProviderHealth(root, 'claude').alert, null);
});

test('ordinary checking and login progress never create provider-failure alerts', (t) => {
  const root = fixture(t);
  for (const kind of ['check-started', 'login-started']) {
    const current = recordProviderHealth(root, 'codex', {
      kind, source: 'startup',
    }, { purpose: 'startup' });
    assert.equal(current.alert, null, kind);
    assert.equal(current.shouldNotify, false, kind);
  }
});

test('real local credentials stay visibly unverified across the card and sign-in panel', (t) => {
  const root = fixture(t);
  const health = recordProviderHealth(root, 'codex', {
    kind: 'local-credentials-present', source: 'startup',
  }, { purpose: 'startup' });
  const status = publicProviderStatus({
    installed: true, authenticated: true, capabilities: { structuredOutput: true },
  }, health);
  assert.match(providerCardPresentation(status).label, /unverified|not.*verified/i);
  assert.match(providerLoginPanelHtml('codex', status), /not.*verified|unverified/i);
  assert.doesNotMatch(providerLoginPanelHtml('codex', status), /Codex is signed in\./);
});
