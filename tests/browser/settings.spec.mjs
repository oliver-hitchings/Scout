import { expect, test } from '@playwright/test';

const establishedStatus = {
  bootstrap: false,
  established: true,
  ready: true,
  setupComplete: true,
  trackerExists: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE',
  appRoot: 'SYNTHETIC_APP',
  appVersion: '0.1.0-beta.14',
  config: {
    locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    profile: { displayName: 'Example Person', tone: 'natural and direct' },
    search: {
      roleFamilies: ['Product engineer'], sectors: ['Climate technology'],
      locations: ['Example City'], exclusions: ['Extensive travel'], salaryMinimum: 70000,
    },
    commute: { origin: 'Example City', mode: 'either', maxMinutes: 60, includeUnknown: true },
    ai: { provider: 'codex', model: null },
  },
  providers: {
    codex: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
    claude: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
  },
  adzunaConfigured: false,
  scanHealth: { healthy: true, lastRunAt: '2026-07-20T08:00:00.000Z' },
  schedule: { enabled: false, configured: false, runs: [] },
  device: { updates: { policy: 'notify' }, startupStatus: { supported: false }, startWithWindows: false },
  git: { installed: true },
  sync: { state: 'disabled', enabled: false },
  remoteAccess: { state: 'disabled', enabled: false, installed: false },
  requestAccess: 'local',
  pendingSetupSections: [],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(establishedStatus),
    });
  });
  await page.route('**/api/setup/proposal', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ proposal: null }) });
  });
  await page.goto('/');
  await expect(page.locator('#sync-status')).toBeVisible();
});

test('first service worker installation does not pretend Scout has updated', async ({ page }) => {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await expect(page.locator('#ui-update-banner')).toBeHidden();
});

test('backup status opens dedicated details and advanced backup settings', async ({ page }) => {
  const sync = page.locator('#sync-status');
  await sync.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Backup details' })).toBeVisible();
  await expect(dialog.getByText('Review or retune Scout')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Advanced backup settings' }).click();
  await expect(dialog.getByRole('heading', { name: 'Backup' })).toBeVisible();
  await expect(dialog.getByText('Private backup: Not set up (optional)')).toBeVisible();
  await expect(dialog.getByText(/Viewing this guide does not enable backup/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Back to settings' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(sync).toBeFocused();
});

test('scan settings offer only the selected provider until verification is requested', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Scans & schedule' }).click();
  await expect(dialog.getByText('Codex daily scan time')).toBeVisible();
  await expect(dialog.getByText('Claude verification pass time')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add verification pass' }).click();
  await expect(dialog.getByText('Claude verification pass time')).toBeVisible();
});

test('proposal and scan operations show reviewable progress and strict zero-keeper results', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.evaluate((status) => {
    const setup = window.ScoutSetup;
    setup.status = { ...status, established: false, ready: false, setupComplete: false, recovery: { available: false } };
    setup.proposal = null;
    setup.view = 'onboarding';
    setup.step = 5;
    setup.operations.proposal = {
      id: 'proposal-synthetic', type: 'proposal', status: 'running', phase: 'Generating proposal with codex',
      progress: { current: 2, total: 4 }, startedAt: new Date(Date.now() - 65000).toISOString(),
    };
    document.getElementById('setup-overlay').classList.remove('hidden');
    setup.render();
  }, establishedStatus);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Generating proposal with codex')).toBeVisible();
  await expect(dialog.getByText(/Step 2 of 4/)).toBeVisible();
  await expect(dialog.getByText(/Quitting Scout interrupts local work/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue in background' })).toBeVisible();

  await page.evaluate(() => {
    const setup = window.ScoutSetup;
    setup.operations.proposal = {
      ...setup.operations.proposal, status: 'succeeded', phase: 'Proposal ready to review',
      progress: { current: 4, total: 4 }, finishedAt: new Date().toISOString(),
    };
    setup.proposal = {
      proposalId: 'proposal-synthetic', summary: 'Synthetic reviewed proposal', unresolvedQuestions: [],
      files: ['workspace.json', 'profile/context.md', 'profile/calibration.md', 'cv/master-cv.md', 'data/search-categories.json']
        .map((path) => ({ path, staged: `Synthetic staged content for ${path}` })),
    };
    setup.render();
  });
  const activate = dialog.getByRole('button', { name: 'Approve and activate' });
  await expect(dialog.getByRole('heading', { name: 'cv/master-cv.md' })).toBeVisible();
  await expect(activate).toBeDisabled();
  await dialog.getByLabel('I reviewed all five staged files').check();
  await expect(activate).toBeEnabled();

  await page.evaluate((status) => {
    const setup = window.ScoutSetup;
    setup.status = {
      ...status, established: false, ready: true, setupComplete: false,
      scanHealth: {
        healthy: true, lastRunAt: '2026-07-21T20:00:00.000Z', candidatesFound: 40, keepersAdded: 0,
        discarded: { mandatory_unmet: 19, provider_discarded: 21 },
      },
    };
    setup.step = 6;
    setup.operations.scan = {
      id: 'scan-synthetic', type: 'scan', status: 'running', phase: 'Scoring 40 candidates',
      progress: { current: 3, total: 5 }, startedAt: new Date(Date.now() - 125000).toISOString(),
    };
    setup.render();
  }, establishedStatus);
  await expect(dialog.getByText('40 reviewed, 0 kept')).toBeVisible();
  await expect(dialog.getByText(/19 mandatory gates/)).toBeVisible();
  await expect(dialog.getByText(/21 assessment discards/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Finish setup — scan continues' })).toBeVisible();
  await expect(dialog.getByText('Codex daily scan time')).toBeVisible();
  await expect(dialog.getByText('Claude verification pass time')).toHaveCount(0);
});

test('refresh reattaches setup to a running proposal operation', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ...establishedStatus, established: false, ready: false, setupComplete: false }),
  }));
  await page.route('**/api/operations?type=proposal', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ operation: {
      id: 'proposal-reattach', type: 'proposal', status: 'running', phase: 'Validating and staging proposal',
      progress: { current: 3, total: 4 }, startedAt: '2026-07-21T20:00:00.000Z',
    } }),
  }));
  await page.reload();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Generate your evidence-led CV and search proposal' })).toBeVisible();
  await expect(dialog.getByText('Validating and staging proposal')).toBeVisible();
  await expect(dialog.getByText(/Step 3 of 4/)).toBeVisible();
});

test('settings opens a hub and retuning is explicit and dismissible', async ({ page }) => {
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Scout settings' })).toBeVisible();
  await expect(dialog.locator('.settings-card')).toHaveCount(7);
  await expect(dialog.getByText('Review settings')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Search & profile' }).click();
  await expect(dialog.getByRole('heading', { name: 'Search & profile' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Retune my search' }).click();
  await expect(dialog.getByRole('heading', { name: 'Retune Scout' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Choose an AI provider' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
});

test('a slow initial setup response cannot replace an explicit Settings view', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  let releaseInitial;
  let statusRequests = 0;
  await page.route('**/api/setup/status', async (route) => {
    statusRequests += 1;
    if (statusRequests === 1) {
      await new Promise((resolve) => { releaseInitial = resolve; });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...establishedStatus,
          pendingSetupSections: [{ id: 'start-with-windows', title: 'Start with Windows' }],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(establishedStatus),
    });
  });

  await page.reload();
  await expect.poll(() => Boolean(releaseInitial)).toBe(true);
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.settings-card')).toHaveCount(7);

  releaseInitial();
  await expect.poll(() => statusRequests).toBe(2);
  await page.waitForTimeout(100);
  await expect(dialog.locator('.settings-card')).toHaveCount(7);
  await expect(dialog.getByRole('heading', { name: 'Scout setup update' })).toHaveCount(0);
});

test('settings close remains reachable on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('button', { name: 'Settings' }).click();
  const close = page.getByRole('button', { name: 'Close settings' });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y).toBeGreaterThanOrEqual(0);
});

test('mandatory first-run setup cannot be dismissed', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bootstrap: true,
        workspaceRoot: 'SYNTHETIC_WORKSPACE',
        appRoot: 'SYNTHETIC_APP',
        appVersion: '0.1.0-beta.14',
        git: { installed: true },
        sync: { state: 'disabled', enabled: false },
        pendingSetupSections: [],
      }),
    });
  });
  await page.reload();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Welcome to Scout' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});

test('a stale UI prompts for a safe refresh and protects dirty work', async ({ page }) => {
  await page.route('**/api/app-info', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ name: 'Scout', version: '0.1.0-beta.14', uiBuildId: 'newer-build' }),
    });
  });
  await page.reload();

  const banner = page.locator('#ui-update-banner');
  await expect(banner).toContainText('Scout has updated');
  await page.evaluate(() => { window.Scout.cvState.dirty = true; });
  await banner.getByRole('button', { name: 'Refresh Scout' }).click();
  await expect(banner).toContainText('Save or discard the open CV changes first');

  await page.evaluate(() => { window.Scout.cvState.dirty = false; });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await banner.getByRole('button', { name: 'Refresh Scout' }).click();
  await expect(banner).toContainText('Close or finish the open Scout settings first');
  await page.getByRole('button', { name: 'Close settings' }).click();

  await Promise.all([
    page.waitForNavigation(),
    banner.getByRole('button', { name: 'Refresh Scout' }).click(),
  ]);
});
