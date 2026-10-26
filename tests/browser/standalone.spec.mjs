import { expect, test } from '@playwright/test';
import fs from 'node:fs';

const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const establishedStatus = {
  bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE', appRoot: 'SYNTHETIC_APP', appVersion: version,
  config: { locale: 'en-US', currency: 'USD', timezone: 'UTC', profile: { displayName: 'Example Person' }, search: {}, commute: {}, ai: { provider: 'codex' } },
  providers: {}, scanHealth: { healthy: true }, schedule: { enabled: false, configured: false, runs: [] },
  device: { updates: { policy: 'notify' }, startupStatus: { supported: false } }, git: { installed: true },
  sync: { state: 'disabled', enabled: false }, remoteAccess: { state: 'disabled', enabled: false }, requestAccess: 'local', pendingSetupSections: [],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', (route) => route.fulfill({ json: establishedStatus }));
});

test('phone CV review requires exact approval and preserves an editable draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let approved = 0;
  let status = { state: 'changed', sourcePath: 'SYNTHETIC_EXTERNAL_FILE.md', revision: 'reviewed-revision', versions: [], diff: [{ kind: 'removed', text: 'Old evidence' }, { kind: 'added', text: 'New confirmed evidence' }] };
  await page.route('**/api/cv/living', (route) => route.fulfill({ json: status }));
  await page.route('**/api/cv/living/approve', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmed: true, revision: 'reviewed-revision' });
    approved++;
    status = { ...status, state: 'current', profileReviewPending: true, diff: [] };
    await route.fulfill({ json: status });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.Scout?.state?.cvFiles))).toBe(true);
  await page.getByRole('button', { name: 'CV', exact: true }).click();
  await page.getByText('Living CV — keep a notes file connected', { exact: true }).click();
  await expect(page.getByLabel('CV changes')).toContainText('New confirmed evidence');
  await page.getByRole('button', { name: 'Approve this CV change' }).click();
  expect(approved).toBe(0);
  await page.getByRole('checkbox', { name: 'I reviewed this exact change' }).check();
  await page.getByRole('button', { name: 'Approve this CV change' }).click();
  await expect(page.getByText('No new changes in the source', { exact: true })).toBeVisible();
  expect(approved).toBe(1);
  await expect(page.getByRole('button', { name: 'Review my search preferences' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('phone thumbs-down feedback records a reason and stages a proposal without publishing it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let recorded;
  await page.route('**/api/feedback-learning', (route) => route.fulfill({ json: { revision: 'feedback-revision', active: { changes: [] } } }));
  await page.route('**/api/feedback', async (route) => {
    recorded = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, proposed: true, ledger: { revision: 'new-revision' } } });
  });
  await page.goto('/');
  const card = page.locator('#tab-jobs .card[data-id="new-systems-product-2026-07"]');
  await card.click();
  await card.getByRole('button', { name: 'Poor fit' }).click();
  const form = card.getByRole('region', { name: 'Job feedback' });
  await form.getByRole('combobox', { name: 'Reason', exact: true }).selectOption('responsibilities');
  await form.getByLabel('What should Scout know?').fill('The work described is outside the responsibilities I want.');
  await form.getByLabel('What should Scout know?').press('End');
  await form.getByLabel('What should Scout know?').press('Space');
  await expect(form.getByLabel('What should Scout know?')).toHaveValue(/want\. $/);
  await form.getByRole('combobox', { name: 'Use this feedback for' }).selectOption('title');
  await form.getByRole('button', { name: 'Save feedback' }).click();
  await expect(form.getByRole('status')).toContainText('waiting for your review');
  expect(recorded).toMatchObject({ opportunityId: 'new-systems-product-2026-07', decision: 'not-interested', reason: 'responsibilities', learning: { field: 'title' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('phone cover-letter edits keep PDF download disabled until the saved draft is rendered again', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let saved;
  const source = '# DRAFT\n\nA truthful synthetic cover letter.';
  await page.route('**/api/cv', (route) => route.fulfill({ json: { applications: [], outreach: ['synthetic-letter'], entries: [], letters: [{ slug: 'synthetic-letter', pdf: true, current: !saved, pdfCurrent: !saved, stale: Boolean(saved) }] } }));
  await page.route('**/api/cv/file**', (route) => route.fulfill({ contentType: 'text/plain', body: source }));
  await page.route('**/api/cv/pdf**', (route) => route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nSynthetic draft PDF body.' }));
  await page.route('**/api/cv/save', async (route) => { saved = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.Scout?.state?.cvFiles))).toBe(true);
  await page.getByRole('button', { name: 'CV', exact: true }).click();
  await page.locator('[data-cv-path="applications/synthetic-letter/outreach.md"]').click();
  await expect(page.getByRole('button', { name: 'download PDF', exact: true })).toBeEnabled();
  const editor = page.locator('#cv-text');
  await editor.fill(source + '\nA reviewed edit.');
  await expect(page.getByRole('button', { name: 'download PDF', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'save changes', exact: true }).click();
  await expect(page.locator('#cv-status')).toContainText('Saved.');
  expect(saved).toMatchObject({ path: 'applications/synthetic-letter/outreach.md', content: source + '\nA reviewed edit.' });
  await expect(page.getByRole('button', { name: 'download PDF', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'render PDF', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('phone job refresh preserves open controls and unsaved feedback while updating job facts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => window.Scout.loadOpportunities());
  const card = page.locator('#tab-jobs .card[data-id="new-systems-product-2026-07"]');
  await card.click();
  await page.evaluate(() => window.Scout.loadOpportunities());
  await expect(card).toHaveClass(/\bopen\b/);
  await card.getByRole('button', { name: 'Poor fit' }).click();
  const text = card.getByLabel('What should Scout know?');
  await text.fill('Keep this unsaved explanation while checking for new jobs.');
  await text.press('End');
  await page.evaluate(() => window.Scout.loadOpportunities());
  await expect(text).toHaveValue('Keep this unsaved explanation while checking for new jobs.');
  await expect(text).toBeFocused();
  const data = await page.evaluate(() => window.Scout.state.data);
  data.opportunities.find((entry) => entry.id === 'new-systems-product-2026-07').role = 'Updated Product Engineer';
  await page.route('**/api/opportunities', (route) => route.fulfill({ json: data }));
  await page.evaluate(() => window.Scout.loadOpportunities());
  await expect(card.locator('.top')).toContainText('Updated Product Engineer');
  await expect(text).toHaveValue('Keep this unsaved explanation while checking for new jobs.');
  await expect(text).toBeFocused();
  await page.evaluate(() => window.Scout.applyWorkspaceConfig({
    ...window.Scout.workspaceConfig,
    modePolicy: { triage: { actionScore: 1, checkScore: 0 } },
  }));
  await expect(card.locator('.chiprow > .score')).toHaveClass(/\bfit-strong\b/);
  await expect(text).toHaveValue('Keep this unsaved explanation while checking for new jobs.');
});

test('a late initial configuration response preserves an expanded feedback-button click', async ({ page }) => {
  let releaseProposal;
  const proposalReady = new Promise((resolve) => { releaseProposal = resolve; });
  let proposalRequested;
  const proposalStarted = new Promise((resolve) => { proposalRequested = resolve; });
  await page.route('**/api/setup/status', (route) => route.fulfill({ json: {
    ...establishedStatus,
    config: { ...establishedStatus.config, profile: { displayName: 'Synthetic late configuration' } },
  } }));
  await page.route('**/api/setup/proposal', async (route) => {
    proposalRequested();
    await proposalReady;
    await route.fulfill({ json: { proposal: null } });
  });
  await page.goto('/');
  await proposalStarted;
  const card = page.locator('#tab-jobs .card[data-id="new-systems-product-2026-07"]');
  await card.click();
  const feedback = card.getByRole('button', { name: 'Poor fit' });
  await feedback.scrollIntoViewIfNeeded();
  const bounds = await feedback.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  releaseProposal();
  await expect.poll(() => page.evaluate(() => window.Scout?.workspaceConfig?.profile?.displayName)).toBe('Synthetic late configuration');
  await page.mouse.up();
  const explanation = card.getByLabel('What should Scout know?');
  await expect(explanation).toBeVisible();
  await explanation.fill('A synthetic reason entered after the completed click.');
  await expect(explanation).toHaveValue('A synthetic reason entered after the completed click.');
});

test('open job actions refresh when its CV and cover-letter catalogue changes', async ({ page }) => {
  const id = 'new-systems-product-2026-07';
  let created = false;
  await page.route('**/api/cv', (route) => route.fulfill({ json: {
    applications: created ? [id] : [], outreach: created ? [id] : [], entries: [],
  } }));
  await page.goto('/');
  await page.evaluate(() => window.Scout.loadOpportunities());
  const card = page.locator('#tab-jobs .card[data-id="new-systems-product-2026-07"]');
  await card.click();
  await expect(card.getByRole('button', { name: 'create custom CV', exact: true })).toBeVisible();
  created = true;
  await page.evaluate(() => window.Scout.loadOpportunities());
  await expect(card.getByRole('button', { name: 'see custom CV', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'see cover letter', exact: true })).toBeVisible();
});

test('phone reviewed draft flow keeps local-model text editable and requires confirmation before saving', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let saves = 0; let savedText = ''; const source = '# DRAFT\n\nConfirmed synthetic CV experience.';
  await page.route('**/api/cv', (route) => route.fulfill({ json: { applications: [], outreach: [], entries: [], draftCvs: saves ? [{ slug: 'new-systems-product-2026-07', pdf: false, current: false }] : [] } }));
  await page.route('**/api/cv/drafts/generate', (route) => route.fulfill({ json: { operation: { id: 'synthetic-draft', status: 'succeeded', result: { draftId: 'synthetic-draft' } } } }));
  await page.route('**/api/cv/drafts/preview**', (route) => route.fulfill({ json: { opportunityId: 'new-systems-product-2026-07', kind: 'cv', revision: 'synthetic-revision', provider: 'local', markdown: source } }));
  await page.route('**/api/cv/drafts/save', async (route) => {
    const payload = route.request().postDataJSON(); saves++; savedText = payload.markdown;
    expect(payload).toMatchObject({ draftId: 'synthetic-draft', confirmed: true });
    await route.fulfill({ json: { ok: true, path: 'applications/new-systems-product-2026-07/draft-cv.md', slug: 'new-systems-product-2026-07', target: 'draft-cv' } });
  });
  await page.route('**/api/cv/file**', (route) => route.fulfill({ contentType: 'text/plain', body: savedText || source }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.Scout?.state?.cvFiles))).toBe(true);
  await page.getByRole('button', { name: 'CV', exact: true }).click();
  await page.getByRole('button', { name: 'Review CV options' }).click();
  await page.locator('#cv-create-opportunity').selectOption('new-systems-product-2026-07');
  await page.getByRole('button', { name: 'Create reviewed CV draft' }).click();
  await page.getByRole('button', { name: 'Generate draft from confirmed CV facts' }).click();
  await expect(page.getByLabel('Editable draft')).toHaveValue(source);
  await page.getByLabel('Editable draft').fill(source + '\nMy human-reviewed edit.');
  await page.evaluate(() => window.Scout.showUiUpdate());
  await page.getByRole('button', { name: 'Refresh Scout', exact: true }).click();
  await expect(page.locator('#ui-update-banner')).toContainText('Save or discard the application draft first.');
  await expect(page.getByLabel('Editable draft')).toHaveValue(/human-reviewed edit/);
  await page.getByRole('button', { name: 'Save reviewed draft' }).click();
  expect(saves).toBe(0);
  await expect(page.getByLabel('Editable draft')).toHaveValue(/human-reviewed edit/);
  await page.getByRole('checkbox', { name: 'I reviewed the facts and my edits' }).check();
  await page.getByRole('button', { name: 'Save reviewed draft' }).click();
  await expect(page.locator('#cv-text')).toHaveValue(/human-reviewed edit/);
  await expect(page.locator('#cv-status')).toContainText('nothing was sent');
  expect(saves).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

async function openReviewedDraftFixture(page, generationReady = Promise.resolve()) {
  const source = '# DRAFT\n\nConfirmed synthetic CV experience.';
  let generationRequested;
  const started = new Promise((resolve) => { generationRequested = resolve; });
  await page.route('**/api/cv', (route) => route.fulfill({ json: { applications: [], outreach: [], entries: [], draftCvs: [] } }));
  await page.route('**/api/cv/drafts/generate', async (route) => {
    generationRequested(route.request().postDataJSON());
    await generationReady;
    await route.fulfill({ json: { operation: { id: 'synthetic-draft', status: 'succeeded', result: { draftId: 'synthetic-draft' } } } });
  });
  await page.route('**/api/cv/drafts/preview**', (route) => route.fulfill({ json: { opportunityId: 'new-systems-product-2026-07', kind: 'cv', revision: 'synthetic-revision', provider: 'local', markdown: source } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.Scout?.state?.cvFiles))).toBe(true);
  await page.getByRole('button', { name: 'CV', exact: true }).click();
  await page.getByRole('button', { name: 'Review CV options' }).click();
  await page.locator('#cv-create-opportunity').selectOption('new-systems-product-2026-07');
  await page.getByRole('button', { name: 'Create reviewed CV draft' }).click();
  await page.getByRole('button', { name: 'Generate draft from confirmed CV facts' }).click();
  return { source, started };
}

for (const transition of [
  { name: 'another draft type', role: 'new-systems-product-2026-07', button: 'Create reviewed letter draft', heading: 'Review cover-letter draft' },
  { name: 'another role', role: 'legacy-systems-hardware-2026-07', button: 'Create reviewed CV draft', heading: 'Review CV draft' },
]) {
  test(`switching to ${transition.name} requires explicit discard of unsaved human edits`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { source } = await openReviewedDraftFixture(page);
    const edited = source + '\nA careful unsaved human edit.';
    await expect(page.getByLabel('Editable draft')).toHaveValue(source);
    await page.getByLabel('Editable draft').fill(edited);
    await page.getByRole('button', { name: 'Review CV options' }).click();
    await page.locator('#cv-create-opportunity').selectOption(transition.role);
    let acceptDiscard = false;
    let confirmations = 0;
    page.on('dialog', async (dialog) => {
      confirmations++;
      if (acceptDiscard) await dialog.accept();
      else await dialog.dismiss();
    });
    await page.getByRole('button', { name: transition.button, exact: true }).click();
    await expect(page.getByLabel('Editable draft')).toHaveValue(edited);
    expect(confirmations).toBe(1);
    acceptDiscard = true;
    await page.getByRole('button', { name: transition.button, exact: true }).click();
    await expect(page.getByRole('heading', { name: transition.heading, exact: true })).toBeVisible();
    await expect(page.getByLabel('Editable draft')).toHaveCount(0);
    expect(confirmations).toBe(2);
  });
}

test('starting another draft cannot replace generation that is still in flight', async ({ page }) => {
  let releaseGeneration;
  const generationReady = new Promise((resolve) => { releaseGeneration = resolve; });
  const { source, started } = await openReviewedDraftFixture(page, generationReady);
  expect(await started).toMatchObject({ opportunityId: 'new-systems-product-2026-07', kind: 'cv' });
  await page.getByRole('button', { name: 'Review CV options' }).click();
  await page.locator('#cv-create-opportunity').selectOption('legacy-systems-hardware-2026-07');
  await page.getByRole('button', { name: 'Create reviewed letter draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate draft from confirmed CV facts' })).toBeDisabled();
  releaseGeneration();
  await expect(page.getByLabel('Editable draft')).toHaveValue(source);
  await expect(page.getByRole('heading', { name: 'Review CV draft', exact: true })).toBeVisible();
});

test('a pending reviewed-draft save blocks switching and duplicate saves', async ({ page }) => {
  const { source } = await openReviewedDraftFixture(page);
  await expect(page.getByLabel('Editable draft')).toHaveValue(source);
  const edited = source + '\nA human edit being saved.';
  await page.getByLabel('Editable draft').fill(edited);
  let releaseSave;
  const saveReady = new Promise((resolve) => { releaseSave = resolve; });
  let saveRequested;
  const saveStarted = new Promise((resolve) => { saveRequested = resolve; });
  let saves = 0;
  await page.route('**/api/cv/drafts/save', async (route) => {
    saves++;
    saveRequested(route.request().postDataJSON());
    await saveReady;
    await route.fulfill({ json: { ok: true, path: 'applications/new-systems-product-2026-07/draft-cv.md', slug: 'new-systems-product-2026-07' } });
  });
  await page.route('**/api/cv/file**', (route) => route.fulfill({ contentType: 'text/plain', body: edited }));
  await page.getByRole('checkbox', { name: 'I reviewed the facts and my edits' }).check();
  await page.getByRole('button', { name: 'Save reviewed draft', exact: true }).click();
  expect(await saveStarted).toMatchObject({ markdown: edited, confirmed: true });
  await page.getByRole('button', { name: 'Review CV options' }).click();
  await page.getByRole('button', { name: 'Create reviewed letter draft', exact: true }).click();
  await expect(page.getByLabel('Editable draft')).toHaveValue(edited);
  await expect(page.getByRole('button', { name: 'Save reviewed draft', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Discard unsaved draft', exact: true })).toBeDisabled();
  releaseSave();
  await expect(page.locator('#cv-text')).toHaveValue(edited);
  expect(saves).toBe(1);
});
