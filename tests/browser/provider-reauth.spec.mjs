import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const EXPIRED = {
  provider: 'claude',
  signInRequired: true,
  alertId: 'provider-health:claude:sign-in-required',
  acknowledged: false,
  jobs: [{ id: 'claude-primary', time: '07:30', mode: 'primary' }],
  missedJobIds: [],
  manualBlocked: false,
};
const RECONNECTED = {
  ...EXPIRED, signInRequired: false, alertId: null, missedJobIds: ['claude-primary'], manualBlocked: true,
};

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
let providers;
let posts;

test.beforeEach(async ({ page }) => {
  providers = [];
  posts = [];
  await page.context().route('**/service-worker.js', (route) => route.abort());
  await page.route('**/api/setup/status', (route) => route.fulfill(json({
    bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
    config: { locale: 'en-GB', ai: { provider: 'codex', models: {} }, search: {}, commute: {} },
    providers: {
      codex: { installed: true, authenticated: true, healthState: 'ready', capabilities: { structuredOutput: true } },
      claude: { installed: true, authenticated: false, healthState: 'sign-in-required', capabilities: { structuredOutput: true } },
    },
    scanHealth: { healthy: true, lastRunAt: null }, schedule: { enabled: false, runs: [] },
    sync: { state: 'disabled' }, device: { updates: { policy: 'notify' }, startupStatus: {} }, remoteAccess: {}, pendingSetupSections: [],
  })));
  await page.route('**/api/opportunities', (route) => route.fulfill(json({
    updated: '2026-10-25', opportunities: [], triage: { action: [], unlock: [], followups: [], other: [] },
    pipeline: { summary: {}, new: [], watch: [], active: [], recentlyClosed: [], flags: [] },
    scanHealth: { healthy: true, lastRunAt: null }, categories: [],
    workspaceConfig: { ai: { provider: 'codex' }, commute: {} }, trackerRevision: 'synthetic',
  })));
  await page.route('**/api/scans/latest', (route) => route.fulfill(json({ scan: null })));
  await page.route('**/api/scan/runs', (route) => route.fulfill(json({ state: 'waiting', runs: [] })));
  await page.route('**/api/scan/queue', (route) => route.fulfill(json({ state: 'waiting', requests: [] })));
  await page.route('**/api/cv', (route) => route.fulfill(json({ master: 'cv/master-cv.md', masterRender: {}, applications: [], entries: [] })));
  await page.route('**/api/provider-health', (route) => route.fulfill(json({ providers })));
  await page.route('**/api/provider-health/acknowledge', (route) => {
    posts.push(['acknowledge', route.request().postDataJSON()]);
    providers = providers.map((entry) => ({ ...entry, acknowledged: true }));
    return route.fulfill(json({ ok: true }));
  });
  await page.route('**/api/schedule', (route) => {
    posts.push(['schedule', route.request().postDataJSON()]);
    return route.fulfill(json({ ok: true }));
  });
  await page.route('**/api/scan', (route) => {
    posts.push(['scan', route.request().postDataJSON()]);
    return route.fulfill(json({ operation: { id: 'op-1', type: 'scan', status: 'running', startedAt: new Date().toISOString() } }, 202));
  });
  await page.route('**/api/operations**', (route) => route.fulfill(json({
    operation: { id: 'op-1', type: 'scan', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
  })));
});

test('an expired session raises a persistent warning that names the provider and its scheduled jobs', async ({ page }) => {
  providers = [EXPIRED];
  await page.goto('/');
  const banner = page.locator('#provider-health-banner');
  await expect(banner).toContainText('Claude sign-in has expired');
  await expect(banner).toContainText('claude-primary (07:30)');
  await expect(banner.getByRole('button', { name: 'Reconnect Claude' })).toBeVisible();
  await page.getByRole('button', { name: 'Shortlist' }).click();
  await expect(banner).toContainText('Claude sign-in has expired');
});

test('Reconnect opens the guided sign-in in AI provider settings', async ({ page }) => {
  providers = [EXPIRED];
  await page.goto('/');
  await page.getByRole('button', { name: 'Reconnect Claude' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'AI providers' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign in to Claude with Scout' })).toBeVisible();
});

test('Remind me later acknowledges the alert and leaves a quiet reminder with Reconnect', async ({ page }) => {
  providers = [EXPIRED];
  await page.goto('/');
  await page.getByRole('button', { name: 'Remind me later' }).click();
  await expect.poll(() => posts).toEqual([['acknowledge', { provider: 'claude', alertId: EXPIRED.alertId }]]);
  const banner = page.locator('#provider-health-banner');
  await expect(banner).toContainText('Claude still needs sign-in');
  await expect(banner.getByRole('button', { name: 'Remind me later' })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Reconnect Claude' })).toBeVisible();
});

test('a rejected reminder shows why and keeps every action available', async ({ page }) => {
  providers = [EXPIRED];
  await page.route('**/api/provider-health/acknowledge', (route) => route.fulfill(json({ error: 'provider alert changed; refresh and retry' }, 409)));
  await page.goto('/');
  await page.getByRole('button', { name: 'Remind me later' }).click();
  const banner = page.locator('#provider-health-banner');
  await expect(banner).toContainText('provider alert changed');
  await expect(banner.getByRole('button', { name: 'Remind me later' })).toBeEnabled();
});

test('after reconnecting, Run missed scan now starts the blocked scheduled job through the scheduler', async ({ page }) => {
  providers = [RECONNECTED];
  await page.goto('/');
  const banner = page.locator('#provider-health-banner');
  await expect(banner).toContainText('Claude is signed in again');
  await expect(banner).toContainText('Missed scheduled scan: claude-primary');
  await banner.getByRole('button', { name: 'Run missed scan now' }).click();
  await expect.poll(() => posts).toEqual([['schedule', { action: 'run-now', id: 'claude-primary', provider: 'claude' }]]);
  await expect(banner).toContainText('Missed scan started');
  await expect(banner.getByRole('button')).toHaveCount(0);
});

test('after reconnecting, Retry now runs a manual scan with the reconnected provider', async ({ page }) => {
  providers = [RECONNECTED];
  await page.goto('/');
  await page.getByRole('button', { name: 'Retry now' }).click();
  // The workspace default is Codex; the blocked scan belonged to Claude.
  await expect.poll(() => posts).toEqual([['scan', { provider: 'claude' }]]);
  await expect(page.locator('#provider-health-banner')).toBeHidden();
});

test('Not now hides the reconnected notice until the page is reloaded', async ({ page }) => {
  providers = [RECONNECTED];
  await page.goto('/');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('#provider-health-banner')).toBeHidden();
  expect(posts).toEqual([]);
  await page.reload();
  await expect(page.locator('#provider-health-banner')).toContainText('Claude is signed in again');
});

test('no warning appears while every provider is healthy', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scan-now')).toBeVisible();
  await expect(page.locator('#provider-health-banner')).toBeHidden();
});

test('local provider settings preserve edits and save a model without a CLI sign-in', async ({ page }) => {
  let config = { locale: 'en-GB', ai: { provider: null, models: {}, local: {} }, search: {}, commute: {} };
  const local = { installed: true, authenticated: true, healthState: 'ready', capabilities: { structuredOutput: true } };
  await page.route('**/api/setup/status', (route) => route.fulfill(json({
    bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
    config, providers: { codex: {}, claude: {}, local }, scanHealth: { healthy: true },
    schedule: { enabled: false, runs: [] }, sync: { state: 'disabled' },
    device: { updates: { policy: 'notify' }, startupStatus: {} }, remoteAccess: {}, pendingSetupSections: [],
  })));
  await page.route('**/api/provider-login/status**', (route) => route.fulfill(json({ session: null, csrfToken: ['synthetic', 'browser', 'csrf'].join('-') })));
  await page.route('**/api/setup/config', (route) => {
    const body = route.request().postDataJSON();
    posts.push(['config', body]);
    config = { ...config, ai: { ...config.ai, ...body.ai } };
    return route.fulfill(json({ ok: true, config }));
  });
  await page.route('**/api/provider-health/check', (route) => {
    posts.push(['check', route.request().postDataJSON()]);
    return route.fulfill(json({ ok: true, state: 'ready', verified: true }));
  });
  await page.goto('/');
  await page.evaluate(() => window.ScoutSetup.openSettings('providers'));
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="setup-provider"][value="local"]').check();
  await dialog.getByLabel('Server base URL').fill('http://localhost:8000/v1');
  await dialog.getByLabel('Model name', { exact: true }).fill('synthetic/model-27b');
  await page.evaluate(() => window.ScoutSetup.renderProviderSettings());
  await expect(dialog.getByLabel('Model name', { exact: true })).toHaveValue('synthetic/model-27b');
  await expect(dialog.locator('input[name="setup-provider"][value="local"]')).toBeChecked();
  await dialog.getByRole('button', { name: 'Save and check local model' }).click();
  await expect.poll(() => posts.some(([kind]) => kind === 'check')).toBe(true);
  await dialog.getByRole('button', { name: 'Save AI settings' }).click();
  await expect.poll(() => config.ai.provider).toBe('local');
  expect(config.ai.local.model).toBe('synthetic/model-27b');
  expect(config.ai.local.apiKeyFile).toBeNull();
  await expect(dialog.locator('[data-provider-login="local"]')).toHaveCount(0);
});

test('remote settings keep local model transport read-only and roundtrip its exact approved settings', async ({ page }) => {
  const local = { baseUrl: 'https://model.example.test/v1', model: 'synthetic/model' };
  let saved;
  const config = { locale: 'en-GB', ai: { provider: 'codex', models: {}, local }, search: {}, commute: {} };
  await page.route('**/api/setup/status', (route) => route.fulfill(json({
    bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
    requestAccess: 'remote-owner', config,
    providers: { codex: { installed: true, authenticated: true, healthState: 'ready' }, claude: {}, local: {} },
    scanHealth: { healthy: true }, schedule: { enabled: false, runs: [] }, sync: { state: 'disabled' },
    device: { updates: { policy: 'notify' }, startupStatus: {} }, remoteAccess: {}, pendingSetupSections: [],
  })));
  await page.route('**/api/provider-login/status**', (route) => route.fulfill(json({ session: null, csrfToken: randomUUID() })));
  await page.route('**/api/setup/config', (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill(json({ ok: true, config }));
  });
  await page.goto('/');
  await page.evaluate(() => window.ScoutSetup.openSettings('providers'));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Server base URL')).toBeDisabled();
  await expect(dialog.getByLabel('API-key file (optional)')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save and check local model' })).toBeDisabled();
  await expect(dialog).toContainText('Local model settings can only be changed on the Scout host');
  await dialog.getByRole('button', { name: 'Save AI settings' }).click();
  await expect.poll(() => saved?.ai.local).toEqual(local);
});

test('local model URL editing explains remote data disclosure and unencrypted transport', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.ScoutSetup.openSettings('providers'));
  const dialog = page.getByRole('dialog');
  const warning = dialog.locator('#setup-local-transport-warning');
  await dialog.getByLabel('Server base URL').fill('https://model.example.test/v1');
  await expect(warning).toContainText('receives your CV and job text');
  await dialog.getByLabel('Server base URL').fill('https://127.model.example.test/v1');
  await expect(warning).toContainText('receives your CV and job text');
  await dialog.getByLabel('Server base URL').fill('http://192.168.2.1:8000/v1');
  await expect(warning).toContainText('without transport encryption');
  await dialog.getByLabel('Server base URL').fill('http://127.0.0.1:8000/v1');
  await expect(warning).toBeEmpty();
});
