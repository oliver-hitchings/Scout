import { expect, test } from '@playwright/test';

function opportunities(engine = 'legacy-discovery', role = 'Synthetic opportunity') {
  return {
    discoveryEngine: engine,
    opportunities: [{ id: 'synthetic-role', company: 'Synthetic Studio', role, status: 'new', score: 88, sources: [] }],
    triage: { action: [], unlock: [], followups: [], other: [] },
    pipeline: { summary: {}, new: [], watch: [], active: [], recentlyClosed: [], flags: [] },
    categories: [{ id: 'priority', label: 'Priority' }],
    workspaceConfig: { locale: 'hr-HR', ai: { provider: null }, commute: {} },
    scanHealth: { healthy: false, lastRunAt: null }, trackerRevision: 'synthetic',
  };
}

test.beforeEach(async ({ page }) => {
  await page.context().route('**/service-worker.js', (route) => route.abort());
  await page.route('**/api/setup/status', (route) => route.fulfill({ json: {
    bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
    searchProfilePublished: false,
    config: { locale: 'hr-HR', ai: { provider: null }, search: {}, commute: {} },
    providers: {}, scanHealth: { healthy: false, lastRunAt: null },
    schedule: { enabled: false, runs: [] }, sync: { state: 'disabled' },
    device: { updates: { policy: 'notify' }, startupStatus: {} }, remoteAccess: {}, pendingSetupSections: [],
  } }));
  await page.route('**/api/setup/proposal', (route) => route.fulfill({ json: { proposal: null } }));
  await page.route('**/api/operations?type=*', (route) => route.fulfill({ json: { operation: null } }));
  await page.route('**/api/opportunities', (route) => route.fulfill({ json: opportunities() }));
  await page.route('**/api/cv', (route) => route.fulfill({ json: { applications: [], entries: [], masterRender: {} } }));
  await page.route('**/api/scans/latest', (route) => route.fulfill({ json: { scan: null } }));
  await page.route('**/api/scan/runs', (route) => route.fulfill({ json: { state: 'waiting', runs: [] } }));
  await page.route('**/api/scan/queue', (route) => route.fulfill({ json: { state: 'waiting', requests: [] } }));
  await page.route('**/api/feedback-learning', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/provider-health', (route) => route.fulfill({ json: { providers: [] } }));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Scout?.state.data));
});

test('legacy search disclosure stays visible and leads to the profile review until publication', async ({ page }) => {
  const banner = page.locator('#discovery-mode-banner');
  await expect(banner).toContainText('Earlier search settings are active');
  await expect(banner).toContainText('ranking the complete pool only after');
  await banner.getByRole('button', { name: 'Review search profile' }).click();
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await expect(page.locator('#setup-body')).toContainText('Review your search profile');
  await page.locator('#setup-close').click();
  await page.unroute('**/api/opportunities');
  await page.route('**/api/opportunities', (route) => route.fulfill({ json: opportunities('ranked-discovery') }));
  await page.evaluate(() => window.Scout.loadOpportunities());
  await expect(banner).toBeHidden();
});

test('scan progress wraps at intermediate phone widths and remains an announced status', async ({ page }) => {
  await page.evaluate(() => window.Scout.showOperation({
    type: 'scan', status: 'running', phase: 'Assessing selected opportunities and checking mandatory evidence',
    progress: { current: 3, total: 5 }, startedAt: new Date().toISOString(),
    estimate: { totalSecondsLow: 180, totalSecondsHigh: 420 },
  }));
  const status = page.locator('#scan-status');
  for (const width of [381, 540, 700]) {
    await page.setViewportSize({ width, height: 800 });
    const size = await status.evaluate((element) => ({
      visible: element.clientWidth, required: element.scrollWidth,
      height: element.clientHeight, requiredHeight: element.scrollHeight,
      whitespace: getComputedStyle(element).whiteSpace,
    }));
    expect(size.required, `progress text clipped at ${width}px`).toBeLessThanOrEqual(size.visible + 1);
    expect(size.requiredHeight).toBeLessThanOrEqual(size.height + 1);
    expect(size.whitespace).toBe('normal');
  }
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
  await expect(status).toHaveAttribute('title', await status.textContent());
});

test('a delayed refresh cannot overwrite the opportunity the user just refreshed', async ({ page }) => {
  await page.unroute('**/api/opportunities');
  const pending = [];
  await page.route('**/api/opportunities', (route) => { pending.push(route); });
  await page.evaluate(() => { window.syntheticRefreshes = [window.Scout.loadOpportunities(), window.Scout.loadOpportunities()]; });
  await expect.poll(() => pending.length).toBe(2);
  await pending[1].fulfill({ json: opportunities('ranked-discovery', 'Latest opportunity') });
  await expect(page.locator('#tab-jobs')).toContainText('Latest opportunity');
  await pending[0].fulfill({ json: opportunities('legacy-discovery', 'Stale opportunity') });
  await page.evaluate(() => Promise.all(window.syntheticRefreshes));
  await expect(page.locator('#tab-jobs')).toContainText('Latest opportunity');
  await expect(page.locator('#tab-jobs')).not.toContainText('Stale opportunity');
  await expect(page.locator('#discovery-mode-banner')).toBeHidden();
});

test('commute preferences explain their assessment and dashboard limits', async ({ page }) => {
  await page.locator('#discovery-mode-banner').getByRole('button', { name: 'Review search profile' }).click();
  await expect(page.locator('#setup-body')).toContainText('Review your search profile');
  await page.evaluate(() => {
    window.ScoutSetup.preferenceStep = 2;
    window.ScoutSetup.renderPreferences();
  });
  await expect(page.locator('#setup-body')).toContainText('They do not filter newly discovered jobs.');
});
