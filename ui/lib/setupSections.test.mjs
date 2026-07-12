import assert from 'node:assert/strict';
import test from 'node:test';
import { completedWorkspaceSections, pendingWorkspaceSections, WORKSPACE_SETUP_SECTIONS } from './setupSections.mjs';

test('legacy completed setup is grandfathered at section version one', () => {
  const completed = completedWorkspaceSections({ completedAt: '2026-07-12T00:00:00Z' });
  assert.deepEqual(Object.keys(completed), Object.keys(WORKSPACE_SETUP_SECTIONS));
  assert.equal(pendingWorkspaceSections({ completedAt: '2026-07-12T00:00:00Z' }).length, 0);
});

test('fresh and partially completed setup expose only incomplete sections', () => {
  assert.equal(pendingWorkspaceSections({}).length, Object.keys(WORKSPACE_SETUP_SECTIONS).length);
  const pending = pendingWorkspaceSections({ completedSections: { welcome: 1, provider: 1 } });
  assert.equal(pending.some((section) => section.id === 'welcome'), false);
  assert.equal(pending.some((section) => section.id === 'search'), true);
});
