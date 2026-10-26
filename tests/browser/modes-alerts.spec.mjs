import { expect, test } from '@playwright/test';

const config = {
  mode: 'background', locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto',
  profile: { displayName: 'Example Person', tone: 'Clear and direct' },
  search: { roleFamilies: ['Example role'], sectors: [], locations: ['Remote'], exclusions: [], salaryMinimum: null },
  commute: { origin: '', mode: 'any', maxMinutes: 60, includeUnknown: true },
  ai: { provider: 'codex', models: {} }, setup: { completedAt: '2026-10-01T08:00:00.000Z' },
};
const alert = { id: 'a'.repeat(64), kind: 'match', title: 'An exceptional match is ready', body: 'Open Scout to review a newly assessed exceptional match.', count: 1 };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', (route) => route.fulfill({ json: { established: true, ready: true, setupComplete: true, trackerExists: true, config, providers: {}, sync: { state: 'disabled' }, schedule: { enabled: false, runs: [] }, device: {}, remoteAccess: { state: 'disabled' }, pendingSetupSections: [] } }));
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { alerts: [alert], outbox: [alert] } }));
});

test('a nontechnical user can change background watch to active hunting in Settings', async ({ page }) => {
  let saved;
  await page.route('**/api/setup/config', async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, config: { ...config, ...saved } } });
  });
  await page.goto('/');
  await page.locator('#scout-settings').click();
  await page.getByRole('button', { name: 'Search & profile', exact: false }).click();
  await expect(page.getByLabel('How should Scout help you?')).toHaveValue('background');
  await expect(page.getByText('Background watch stays quiet')).toBeVisible();
  await page.getByLabel('How should Scout help you?').selectOption('active');
  await page.getByRole('button', { name: 'Save search mode', exact: true }).click();
  await expect.poll(() => saved?.mode).toBe('active');
  expect(saved.locale).toBeUndefined();
  await expect(page.getByText('Search mode saved.')).toBeVisible();
});

test('a late search-profile response preserves the mode chosen before Save', async ({ page }) => {
  let releaseProfile;
  const profileReady = new Promise((resolve) => { releaseProfile = resolve; });
  let profileRequested;
  const profileStarted = new Promise((resolve) => { profileRequested = resolve; });
  await page.route('**/api/search-profile', async (route) => {
    profileRequested();
    await profileReady;
    await route.fulfill({ json: { draft: null, published: { id: 'delayed-profile' } } });
  });
  await page.route('**/api/search-profile/adaptive', (route) => route.fulfill({ json: {} }));
  let saved;
  await page.route('**/api/setup/config', async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, config: { ...config, ...saved } } });
  });
  await page.goto('/');
  await page.locator('#scout-settings').click();
  await page.getByRole('button', { name: 'Search & profile', exact: false }).click();
  await profileStarted;
  await page.getByLabel('How should Scout help you?').selectOption('active');
  releaseProfile();
  await expect(page.getByText('Published version: delayed-profile')).toBeVisible();
  await expect(page.getByLabel('How should Scout help you?')).toHaveValue('active');
  await page.getByRole('button', { name: 'Save search mode', exact: true }).click();
  await expect.poll(() => saved?.mode).toBe('active');
  await expect(page.getByText('Search mode saved.')).toBeVisible();
});

test('unacknowledged alerts remain visible until the user explicitly acknowledges them', async ({ page }) => {
  let acknowledged = false;
  await page.route('**/api/notifications/acknowledge', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ id: alert.id });
    acknowledged = true;
    await route.fulfill({ json: { alerts: [], outbox: [] } });
  });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Scout notifications' })).toBeVisible();
  await expect(page.getByText(alert.title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Acknowledge notification', exact: true }).click();
  expect(acknowledged).toBe(true);
  await expect(page.getByRole('region', { name: 'Scout notifications' })).toBeHidden();
});

test('the onboarding conversation asks whether to watch quietly or hunt actively and saves the choice', async ({ page }) => {
  let saved;
  await page.route('**/api/setup/config', async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, config: { ...config, ...saved } } });
  });
  await page.goto('/');
  await page.locator('#scout-settings').click();
  await page.getByRole('button', { name: 'Search & profile', exact: false }).click();
  await page.getByRole('button', { name: 'Retune my search', exact: true }).click();
  for (let index = 0; index < 5; index += 1) await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Are you looking for a new job now?' })).toBeVisible();
  await page.getByLabel('How should Scout help you?').selectOption('active');
  await page.getByRole('button', { name: 'Save my answers', exact: true }).click();
  await expect.poll(() => saved?.mode).toBe('active');
  expect(saved.locale).toBe('fr-CA');
  expect(saved.currency).toBe('CAD');
});
