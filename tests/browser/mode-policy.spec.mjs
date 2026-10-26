import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedWorkspace, loadWorkspaceConfig, writeWorkspaceConfig } from '../../ui/lib/workspace.mjs';

test('real setup responses preserve background score labels and apply current saved mode policy', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-browser-mode-policy-'));
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  const previousWorkspace = process.env.SCOUT_WORKSPACE;
  const previousDevice = process.env.SCOUT_DEVICE_SETTINGS;
  process.env.SCOUT_WORKSPACE = root;
  process.env.SCOUT_DEVICE_SETTINGS = path.join(root, '.scout', 'device-settings.json');
  seedWorkspace(appRoot, root);
  writeWorkspaceConfig(root, { ...loadWorkspaceConfig(root), mode: 'background', ai: { provider: null }, schedule: { jobs: [] },
    setup: { completedAt: '2026-10-26T08:00:00.000Z' },
  });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'Synthetic profile evidence. '.repeat(15));
  fs.writeFileSync(path.join(root, 'profile', 'calibration.md'), 'Synthetic calibration evidence. '.repeat(10));
  fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), 'Synthetic approved evidence. '.repeat(30));
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), JSON.stringify({ updated: '2026-10-26', opportunities: [
    { id: 'synthetic-policy-role-2026-10', company: 'Synthetic Company', role: 'Synthetic Role', score: 82, status: 'new', sources: [] },
  ] }));
  const { createServer, providerDetection, drainRuntimeWork } = await import('../../ui/server.mjs');
  // Only provider discovery is replaced. All configuration API bodies and
  // browser rendering use the production server and application unchanged.
  providerDetection.detect = async () => ({});
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let releaseStatus;
  try {
    let statusStarted;
    const started = new Promise((resolve) => { statusStarted = resolve; });
    const released = new Promise((resolve) => { releaseStatus = resolve; });
    await page.route('**/api/setup/status', async (route) => {
      const response = await route.fetch();
      statusStarted();
      await released;
      await route.fulfill({ response });
    });
    await page.goto(base);
    await started;
    const score = page.locator('#tab-jobs [data-id="synthetic-policy-role-2026-10"] .score');
    await expect(score).toHaveClass('score fit-weak');
    releaseStatus();
    await expect.poll(() => page.evaluate(() => Boolean(window.ScoutSetup?.status?.config))).toBe(true);
    await page.evaluate(async () => {
      // Complete the same refresh path that applies the real status config.
      await window.ScoutSetup.refreshStatus({ keepOpen: true });
    });
    await expect(score).toHaveClass('score fit-weak');
    await expect(score).toBeVisible();

    for (const [mode, triage, fit] of [
      ['active', { actionScore: 70, checkScore: 55 }, 'fit-strong'],
      ['background', { actionScore: 98, checkScore: 93 }, 'fit-weak'],
      ['active', { actionScore: 98, checkScore: 93 }, 'fit-weak'],
    ]) {
      const saved = await page.evaluate(async (changes) => {
        const response = await fetch('/api/setup/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes) });
        const result = await response.json();
        window.Scout.applyWorkspaceConfig(result.config);
        return { status: response.status, config: result.config };
      }, { mode, triage });
      expect(saved.status).toBe(200);
      expect(saved.config.modePolicy.mode).toBe(mode);
      await expect(score).toHaveClass(`score ${fit}`);
      await page.evaluate(() => window.ScoutSetup.refreshStatus({ keepOpen: true }));
      await expect(score).toHaveClass(`score ${fit}`);
    }
  } finally {
    releaseStatus?.();
    await page.close();
    await drainRuntimeWork();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    if (previousWorkspace === undefined) delete process.env.SCOUT_WORKSPACE;
    else process.env.SCOUT_WORKSPACE = previousWorkspace;
    if (previousDevice === undefined) delete process.env.SCOUT_DEVICE_SETTINGS;
    else process.env.SCOUT_DEVICE_SETTINGS = previousDevice;
  }
});
