import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acknowledgeProviderAlert, readProviderHealth, recordProviderHealth,
} from './providerHealth.mjs';
import {
  acquireProviderAuthMutation, releaseProviderAuthMutation,
} from './providerAuthMutation.mjs';
import {
  markNotification, notificationView, readNotifications,
} from './notifications.mjs';

const baseTime = Date.parse('2026-10-25T08:00:00.000Z');
const at = (second) => new Date(baseTime + second * 1_000);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-alert-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function record(root, provider, kind, second, source = 'provider-operation') {
  return recordProviderHealth(root, provider, { kind, source }, {
    now: at(second), purpose: source === 'post-auth' ? 'post-auth' : source === 'periodic' ? 'periodic' : 'manual-run',
  });
}

test('ordinary provider checking and login progress stay quiet in the real health-to-outbox composition', (t) => {
  const root = fixture(t);
  for (const provider of ['codex', 'claude']) {
    for (const [second, kind] of ['check-started', 'login-started'].entries()) {
      const current = record(root, provider, kind, second, 'post-auth');
      assert.equal(current.alert, null, `${provider} ${kind} is progress, not a provider failure`);
      assert.equal(notificationView(readNotifications(root)).outbox.length, 0);
    }
  }
});

for (const provider of ['codex', 'claude']) {
  test(`${provider} failure acknowledgement survives real authentication mutation and only real success opens a new outbox episode`, (t) => {
    const root = fixture(t);
    const first = record(root, provider, 'remote-auth-failure', 0);
    assert.equal(first.state, 'sign-in-required');
    assert.equal(first.remoteAuthBarrier, true);
    const firstNotification = readNotifications(root).alerts[0];
    assert.ok(firstNotification);
    assert.equal(notificationView(readNotifications(root)).outbox.length, 1);
    acknowledgeProviderAlert(root, provider, first.alert.id, { now: at(1) });
    markNotification(root, firstNotification.id, 'acknowledged', at(1).toISOString());
    const firstAcknowledged = readProviderHealth(root, provider).alert;
    const capability = acquireProviderAuthMutation(root, provider, { now: baseTime + 2_000 });
    assert.ok(capability, 'the real authentication mutation must hold authority');
    try {
      for (const [index, signal] of [
        ['login-started', 'post-auth'],
        ['check-started', 'periodic'],
        ['local-credentials-present', 'post-auth'],
        ['network-failure', 'periodic'],
      ].entries()) {
        const current = record(root, provider, signal[0], index + 3, signal[1]);
        assert.equal(current.remoteAuthBarrier, true, signal[0]);
        assert.equal(current.state, 'sign-in-required', signal[0]);
        assert.deepEqual(current.alert, firstAcknowledged, `${signal[0]} must preserve the acknowledged failure`);
        assert.equal(readNotifications(root).alerts.length, 1, `${signal[0]} cannot create another failure episode`);
        assert.equal(notificationView(readNotifications(root)).outbox.length, 0);
      }
      const succeeded = record(root, provider, 'remote-success', 8, 'post-auth');
      assert.equal(succeeded.remoteAuthBarrier, false);
      assert.equal(succeeded.alert, null);
    } finally {
      releaseProviderAuthMutation(root, capability, { now: baseTime + 9_000 });
    }
    record(root, provider, 'check-started', 10, 'periodic');
    record(root, provider, 'local-credentials-present', 11, 'periodic');
    assert.equal(readNotifications(root).alerts.length, 1, 'post-success local checks stay quiet');
    const second = record(root, provider, 'remote-auth-failure', 12);
    assert.equal(second.alert.acknowledgedAt, null, 'a new real failure requires fresh attention');
    const state = readNotifications(root);
    assert.equal(state.alerts.length, 2, 'exactly one notification per real failure episode');
    assert.equal(state.alerts.find((item) => item.id === firstNotification.id).acknowledgedAt, at(1).toISOString());
    const view = notificationView(state);
    assert.equal(view.outbox.length, 1);
    assert.equal(view.alerts.length, 1);
    assert.notEqual(view.outbox[0].id, firstNotification.id);
    assert.equal(JSON.stringify(view).includes(root), false, 'public notification projection must not expose private paths');
  });
}
