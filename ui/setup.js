const STEPS = ['Welcome', 'AI provider', 'Your search', 'Adzuna', 'Import CV', 'AI hand-off', 'First scan'];
// Keep the existing storage key so people who previously dismissed setup are
// not forced back into it after upgrading. It now represents an intentional
// decision to finish the optional AI enrichment later.
const SETUP_DEFERRED_KEY = 'scout.setup.legacySkipped.v1';
const SUPPORTED_CV = /\.(pdf|docx|md|markdown|txt)$/i;

export function splitList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildConfig(form, current = {}) {
  const salary = String(form.salaryMinimum || '').trim();
  return {
    locale: String(form.locale || current.locale || 'en-GB').trim(),
    currency: String(form.currency || current.currency || 'GBP').trim().toUpperCase(),
    timezone: String(form.timezone || current.timezone || 'Europe/London').trim(),
    profile: {
      ...(current.profile || {}),
      displayName: String(form.displayName || '').trim(),
      tone: String(form.tone || '').trim(),
    },
    search: {
      ...(current.search || {}),
      roleFamilies: splitList(form.roleFamilies),
      sectors: splitList(form.sectors),
      locations: splitList(form.locations),
      exclusions: splitList(form.exclusions),
      salaryMinimum: salary === '' ? null : Number(salary),
    },
    commute: {
      ...(current.commute || {}),
      origin: String(form.commuteOrigin || '').trim(),
      mode: String(form.commuteMode || 'either'),
      maxMinutes: Number(form.commuteMax || 180),
      includeUnknown: Boolean(form.includeUnknown),
    },
  };
}

export function validateCvName(name) {
  if (!SUPPORTED_CV.test(String(name || ''))) {
    throw new Error('Choose a PDF, DOCX, Markdown or text CV.');
  }
  return true;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

export function formatLocalDateTime(value, locale = 'en-GB') {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'pending';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function handoffAction(ready) {
  return ready
    ? { label: 'Continue to first scan', defer: false }
    : { label: 'Finish for now', defer: true };
}

export function buildOnboardingPrompt({ workspaceRoot, provider, imported, config } = {}) {
  const cvLine = imported?.extracted
    ? `Use the locally extracted CV at ${imported.extracted} as evidence.`
    : 'No CV was imported; ask me for career evidence before drafting profile or CV content.';
  const interests = [
    ...(config?.search?.roleFamilies || []),
    ...(config?.search?.sectors || []),
  ];
  return [
    'Use $onboard-scout to finish setting up and tuning my private Scout workspace.',
    workspaceRoot ? `Workspace: ${workspaceRoot}` : '',
    provider ? `Selected AI provider: ${provider}` : '',
    cvLine,
    interests.length ? `Initial interests: ${interests.join(', ')}.` : '',
    'Read workspace.json and the imported evidence, then ask only the targeted questions needed to fill gaps in my experience, desired roles, sectors, salary/equity, locations, remote and commute preferences, dealbreakers, communication tone and employer watchlists.',
    'Never invent qualifications, achievements, compensation or contact details. Stage the profile, calibration, master CV, search lanes and source configuration for my review; validate them and ask for approval before activation.',
    'Scout must remain local-first and must never send an application or outreach message.',
  ].filter(Boolean).join('\n\n');
}

async function requestJson(pathname, options) {
  const response = await fetch(pathname, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function fieldValue(id) {
  return document.getElementById(id)?.value || '';
}

const Setup = {
  step: 0,
  status: null,
  imported: null,
  busy: false,
  preferenceStep: 0,
  preferenceDraft: null,

  el(id) { return document.getElementById(id); },

  async init() {
    if (!this.el('setup-overlay')) return;
    this.el('setup-back').addEventListener('click', () => this.move(-1));
    this.el('setup-next').addEventListener('click', () => this.next());
    this.el('setup-skip').addEventListener('click', () => this.deferSetup());
    await this.refreshStatus();
  },

  async refreshStatus({ keepOpen = false } = {}) {
    try {
      this.status = await requestJson('/api/setup/status');
      window.Scout?.applyWorkspaceConfig?.(this.status.config);
      this.el('setup-title').textContent = this.status.established ? 'Scout settings' : 'Set up Scout';
      this.el('setup-subtitle').textContent = this.status.established
        ? 'Review or retune your existing private workspace.'
        : 'A private workspace, tuned to your search.';
      const skipped = this.status.trackerExists && localStorage.getItem(SETUP_DEFERRED_KEY) === 'true';
      if (!keepOpen && (this.status.ready || skipped)) {
        this.el('setup-overlay').classList.add('hidden');
        return;
      }
      this.el('setup-overlay').classList.remove('hidden');
      this.render();
    } catch (error) {
      this.el('setup-overlay').classList.remove('hidden');
      this.el('setup-body').innerHTML = '<h2>Scout setup could not be loaded</h2><p>Check that the local Scout server is running, then retry.</p>';
      this.setMessage(error.message, 'error');
      this.el('setup-back').classList.add('hidden');
      this.el('setup-next').textContent = 'Retry';
      this.el('setup-next').onclick = () => location.reload();
    }
  },

  async openSettings() {
    this.step = 0;
    this.preferenceStep = 0;
    this.preferenceDraft = null;
    // Provider checks can take several seconds. Open the dialog immediately so
    // the Settings button never appears unresponsive while status is refreshed.
    this.el('setup-overlay').classList.remove('hidden');
    this.el('setup-title').textContent = 'Scout settings';
    this.el('setup-subtitle').textContent = 'Checking your private workspace…';
    this.el('setup-body').innerHTML = '<div class="setup-callout"><strong>Scout is checking your setup…</strong><p>This can take a few seconds while local AI providers are verified.</p></div>';
    await this.refreshStatus({ keepOpen: true });
  },

  async restartServer() {
    if (window.Scout?.chat?.streaming) {
      this.setMessage('Wait for the current AI response to finish before restarting.', 'error');
      return;
    }
    this.setBusy(true);
    this.setMessage('Restarting Scout…');
    try { await fetch('/api/restart', { method: 'POST' }); }
    catch { /* the server may drop the connection while going down */ }
    const deadline = Date.now() + 20000;
    const poll = () => {
      fetch('/', { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error(); location.reload(); })
        .catch(() => {
          if (Date.now() > deadline) {
            this.setBusy(false);
            this.setMessage('Scout did not come back. Start it again with Scout.cmd.', 'error');
          } else {
            setTimeout(poll, 500);
          }
        });
    };
    setTimeout(poll, 1500);
  },

  setMessage(message = '', kind = '') {
    const el = this.el('setup-status');
    el.textContent = message;
    el.className = `setup-status ${kind}`.trim();
  },

  setBusy(busy) {
    this.busy = busy;
    this.el('setup-next').disabled = busy;
    this.el('setup-back').disabled = busy;
  },

  renderProgress() {
    this.el('setup-progress').innerHTML = STEPS.map((label, index) =>
      `<span class="${index <= this.step ? 'done' : ''}" title="${label}"></span>`).join('');
  },

  render() {
    this.setMessage();
    this.renderProgress();
    this.el('setup-back').classList.toggle('hidden', this.step === 0);
    // The optional hand-off uses the primary Finish for now action. Keep the
    // legacy footer control hidden so users are not offered duplicate exits.
    this.el('setup-skip').classList.add('hidden');
    const renderers = [
      this.renderWelcome,
      this.renderProviders,
      this.renderPreferences,
      this.renderAdzuna,
      this.renderImport,
      this.renderHandoff,
      this.renderFirstScan,
    ];
    renderers[this.step].call(this);
  },

  renderWelcome() {
    const established = this.status?.established;
    const schedule = this.status?.schedule || {};
    const scheduleText = schedule.enabled
      ? `${this.escape(schedule.provider || 'provider')} daily at ${this.escape(schedule.time || '')}; next run ${this.escape(formatLocalDateTime(schedule.nextRunAt, this.status?.config?.locale))}; last result ${this.escape(schedule.lastResult || 'unknown')}`
      : schedule.configured
        ? 'A daily scan is saved in the workspace, but the Windows task is not active.'
        : 'Daily scanning is off. Run one supervised scan before enabling it.';
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame setup-scout-welcome" role="img" aria-label="Scout welcomes you"></span></div><div class="scout-bubble tail-left">
      <h2>${established ? 'Review or retune Scout' : 'Hi, I’m Scout. Let’s find work that fits you.'}</h2>
      <p>${established ? 'Your existing tracker, profile, calibration and CV stay in place. Changes are staged for review; nothing is reset.' : 'I build your search from the CV and preferences you choose to share—not from unrelated AI chat history. Your search stays in your private workspace'} at <strong>${this.escape(this.status?.workspaceRoot || '')}</strong>.</p>
      <p class="meta">Scout ${this.escape(this.status?.appVersion || '')} · App: ${this.escape(this.status?.appRoot || '')}</p>
      <div class="setup-grid">
        <div class="setup-callout"><strong>No automatic sending</strong><p>Scout drafts material for your review. It never applies or sends outreach for you.</p></div>
        <div class="setup-callout"><strong>Local workspace</strong><p>Scout has no telemetry or hosted profile. Codex or Claude receives the career context needed for the task you ask it to perform, under that provider’s account terms.</p></div>
        <div class="setup-callout"><strong>Daily scan</strong><p>${scheduleText}</p></div>
      </div>
      <p>You can move or back up the workspace independently. API credentials stay in its ignored <code>.env</code> file and are never shown again here.</p>
      <p class="meta">Something stuck? <button id="setup-restart" class="act" type="button">Restart Scout</button> restarts the local server and reloads this page.</p></div></div>`;
    this.el('setup-restart').addEventListener('click', () => this.restartServer());
    this.el('setup-next').textContent = established ? 'Review settings' : 'Start setup';
  },

  providerCard(name) {
    const provider = this.status?.providers?.[name] || {};
    const selected = (this.status?.config?.ai?.provider || '') === name;
    const state = !provider.installed ? 'Not installed' : provider.authenticated ? 'Installed and signed in' : 'Installed; sign-in required';
    const login = name === 'codex' ? 'codex login' : 'claude auth login';
    const guide = name === 'codex' ? 'https://developers.openai.com/codex/cli/' : 'https://docs.anthropic.com/en/docs/claude-code/setup';
    return `<label class="setup-provider ${provider.authenticated ? 'available' : ''}">
      <input type="radio" name="setup-provider" value="${name}" ${selected ? 'checked' : ''} ${provider.authenticated ? '' : 'disabled'}>
      <strong>${name[0].toUpperCase() + name.slice(1)}</strong>
      <span class="meta">${state}</span>
      ${provider.authenticated ? '' : `<span class="meta"><a href="${guide}" target="_blank" rel="noreferrer">Official installation guide</a>. Install the provider, run <code>${login}</code>, complete its official login flow, then refresh. Your provider account may have separate usage limits or costs.</span>`}
    </label>`;
  },

  renderProviders() {
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready"></span></div><div class="scout-bubble tail-left">
      <h2>Choose an AI provider</h2>
      <p>Scout uses the provider's official CLI and account login. Scout does not ask for or store an AI password or API key.</p>
      <div class="setup-provider-list">${this.providerCard('codex')}${this.providerCard('claude')}</div>
      <button id="setup-provider-refresh" class="act" type="button">Refresh provider status</button>
      <p class="meta">One signed-in provider is required. A second provider is optional and can later perform a verification pass.</p></div></div>`;
    this.el('setup-provider-refresh').addEventListener('click', async () => {
      this.setBusy(true);
      this.setMessage('Checking providers…');
      await this.refreshStatus({ keepOpen: true });
      this.setBusy(false);
    });
    this.el('setup-next').textContent = 'Continue';
  },

  renderPreferences() {
    const c = this.status?.config || {};
    if (!this.preferenceDraft) this.preferenceDraft = {
      displayName: c.profile?.displayName || '', tone: c.profile?.tone || '',
      roleFamilies: (c.search?.roleFamilies || []).join(', '), sectors: (c.search?.sectors || []).join(', '),
      locations: (c.search?.locations || []).join(', '), exclusions: (c.search?.exclusions || []).join(', '),
      salaryMinimum: c.search?.salaryMinimum ?? '', currency: c.currency || 'GBP', locale: c.locale || 'en-GB', timezone: c.timezone || 'Europe/London',
      commuteOrigin: c.commute?.origin || '', commuteMode: c.commute?.mode || 'either', commuteMax: c.commute?.maxMinutes ?? 180,
      includeUnknown: c.commute?.includeUnknown !== false,
    };
    const d = this.preferenceDraft;
    const option = (value, label) => `<option value="${value}" ${d.commuteMode === value ? 'selected' : ''}>${label}</option>`;
    const questions = [
      ['First, what should I call you?', 'I’ll also match the tone you want in CVs and outreach drafts.', `<label class="setup-field">Your name<input id="setup-name" autocomplete="name" value="${this.escape(d.displayName)}" required></label><label class="setup-field">Writing tone<input id="setup-tone" value="${this.escape(d.tone)}" placeholder="Natural, direct and evidence-led"></label>`],
      ['What kind of work should I look for?', 'Use job titles or role families you would genuinely consider. These answers become search queries after you approve the setup.', `<label class="setup-field wide">Role families <span>comma-separated</span><input id="setup-roles" value="${this.escape(d.roleFamilies)}" placeholder="Software engineer, product manager, data analyst"></label><label class="setup-field wide">Sectors <span>comma-separated</span><input id="setup-sectors" value="${this.escape(d.sectors)}" placeholder="Developer tools, climate, healthcare"></label>`],
      ['Where can the right role be?', 'I use travel time rather than simple mileage when commute information is available.', `<label class="setup-field wide">Locations <span>comma-separated</span><input id="setup-locations" value="${this.escape(d.locations)}"></label><label class="setup-field wide">Commute origin<input id="setup-commute-origin" value="${this.escape(d.commuteOrigin)}" placeholder="Town, city or postcode"></label><label class="setup-field">Mode<select id="setup-commute-mode">${option('either','Car or public transport')}${option('car','Car')}${option('public','Public transport')}${option('any','No filter')}</select></label><label class="setup-field">Maximum minutes<input id="setup-commute-max" type="number" min="0" max="1440" value="${this.escape(d.commuteMax)}"></label><label class="setup-field wide"><span><input id="setup-include-unknown" type="checkbox" ${d.includeUnknown ? 'checked' : ''}> Include roles with unknown commute</span></label>`],
      ['What compensation makes a move worthwhile?', 'This guides the search; it is not inserted into applications.', `<label class="setup-field">Minimum base salary<input id="setup-salary" type="number" min="0" step="1000" value="${this.escape(d.salaryMinimum)}"></label><label class="setup-field">Currency<input id="setup-currency" maxlength="3" value="${this.escape(d.currency)}"></label>`],
      ['What should I rule out immediately?', 'Keep these to genuine dealbreakers so I don’t hide an unusual but excellent role.', `<label class="setup-field wide">Hard exclusions <span>comma-separated</span><textarea id="setup-exclusions">${this.escape(d.exclusions)}</textarea></label>`],
    ];
    const q = questions[this.preferenceStep];
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is asking a question"></span></div><div class="scout-bubble tail-left"><div class="meta">Question ${this.preferenceStep + 1} of ${questions.length}</div><h2>${q[0]}</h2><p>${q[1]}</p><div class="setup-grid">${q[2]}</div></div></div>`;
    this.el('setup-next').textContent = this.preferenceStep === questions.length - 1 ? 'Save my answers' : 'Answer';
  },

  capturePreferenceQuestion() {
    const d = this.preferenceDraft;
    const value = (id, key) => { const el = this.el(id); if (el) d[key] = el.value; };
    [['setup-name','displayName'],['setup-tone','tone'],['setup-roles','roleFamilies'],['setup-sectors','sectors'],['setup-locations','locations'],['setup-commute-origin','commuteOrigin'],['setup-commute-mode','commuteMode'],['setup-commute-max','commuteMax'],['setup-salary','salaryMinimum'],['setup-currency','currency'],['setup-exclusions','exclusions']].forEach(([id,key]) => value(id,key));
    const unknown = this.el('setup-include-unknown'); if (unknown) d.includeUnknown = unknown.checked;
  },

  renderAdzuna() {
    this.el('setup-body').innerHTML = `
      <h2>Add Adzuna search (optional)</h2>
      <p>Register for an Adzuna developer account, then paste the application ID and API key below. Scout saves them only to the private workspace's ignored <code>.env</code> file.</p>
      ${this.status?.adzunaConfigured ? '<div class="setup-callout"><strong>Adzuna is configured</strong><p>The saved values are deliberately not displayed. Leave both fields empty to keep them unchanged.</p></div>' : ''}
      <div class="setup-grid">
        <label class="setup-field">Application ID<input id="setup-adzuna-id" type="password" autocomplete="off" spellcheck="false"></label>
        <label class="setup-field">API key<input id="setup-adzuna-key" type="password" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="meta">You can skip this and use Scout's public sources. Add credentials later by returning to setup or editing the workspace's local environment file.</p>`;
    this.el('setup-next').textContent = 'Continue';
  },

  renderImport() {
    const imported = this.imported;
    this.el('setup-body').innerHTML = `
      <h2>Import your existing CV (optional)</h2>
      <p>Scout accepts PDF, DOCX, Markdown and plain text up to 10 MB. Text extraction happens locally. Scanned PDFs need OCR before they can be used.</p>
      <label class="setup-field"><span>CV file</span><input id="setup-cv-file" type="file" accept=".pdf,.docx,.md,.markdown,.txt"></label>
      ${imported ? `<h3>Extracted preview</h3><div id="setup-cv-preview" class="setup-preview"></div><p class="meta">Saved locally as ${this.escape(imported.extracted)}</p>` : ''}`;
    if (imported) this.el('setup-cv-preview').textContent = imported.text || '';
    this.el('setup-next').textContent = imported ? 'Continue' : 'Import or skip';
  },

  renderHandoff() {
    const action = handoffAction(this.status?.ready);
    const prompt = buildOnboardingPrompt({
      workspaceRoot: this.status?.workspaceRoot,
      provider: this.status?.config?.ai?.provider,
      imported: this.imported,
      config: this.status?.config,
    });
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready to talk"></span></div><div class="scout-bubble tail-left">
      <h2>Would you like me to strengthen your CV and search?</h2>
      <p>I can ask a few focused questions about the work you want, your experience, achievements and dealbreakers. I’ll use your answers to propose a stronger evidence-led CV and better-matched searches.</p>
      <p><button id="setup-open-chat" class="act primary" type="button">${this.status?.ready ? 'Talk to Scout again' : 'Start questions'}</button></p>
      <p class="meta">This is optional. You can finish setup now and return from Settings whenever you are ready. Nothing is activated without your review and approval.</p>
      <details><summary class="meta">Already started?</summary><p><button id="setup-review-chat" class="act" type="button">Review staged changes</button> <button id="setup-approve-chat" class="act" type="button">Approve after review</button></p></details>
      </div></div>
      <textarea id="setup-ai-prompt" class="setup-prompt hidden" readonly></textarea>
      <div class="setup-callout"><strong>${this.status?.ready ? 'CV and search enrichment complete' : 'Your initial setup is complete'}</strong><p>${this.status?.ready ? 'Your approved evidence and settings are ready for a supervised first scan.' : 'Scout can already save your preferences. The optional interview makes your CV and opportunity scoring more useful, but it does not block you from finishing setup.'}</p></div>`;
    this.el('setup-ai-prompt').value = prompt;
    this.el('setup-open-chat').addEventListener('click', () => this.openScoutChat('ask'));
    this.el('setup-review-chat').addEventListener('click', () => this.openScoutChat('review'));
    this.el('setup-approve-chat').addEventListener('click', () => this.openScoutChat('approve'));
    this.el('setup-next').textContent = action.label;
  },

  renderFirstScan() {
    const health = this.status?.scanHealth || {};
    const schedule = this.status?.schedule || {};
    const healthy = Boolean(health.lastRunAt && health.healthy);
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready to search"></span></div><div class="scout-bubble tail-left">
      <h2>${healthy ? 'Your first scan is ready to review' : 'Run your first search with me'}</h2>
      <p>I search using your approved role families and search lanes, then apply your locations, exclusions, compensation preferences and evidence-based scoring. I do not use unrelated AI conversations.</p>
      <div class="setup-callout"><strong>${healthy ? 'Healthy supervised scan completed' : 'Supervised first'}</strong><p>${healthy ? `Last run: ${this.escape(formatLocalDateTime(health.lastRunAt, this.status?.config?.locale))}. Review the dashboard before enabling automation.` : 'Keep this window open. A full source check can take several minutes and no application will be sent.'}</p></div>
      <p><button id="setup-run-scan" class="act primary" type="button" ${this.busy ? 'disabled' : ''}>${healthy ? 'Run another supervised scan' : 'Run supervised scan'}</button></p>
      <div class="setup-callout"><strong>Optional daily scan</strong><p>${schedule.enabled ? `Enabled at ${this.escape(schedule.time || '')} using ${this.escape(schedule.provider || '')}.` : 'Disabled until you choose to enable it after reviewing a healthy scan.'}</p>
      <label class="setup-field">Daily time<input id="setup-schedule-time" type="time" value="${this.escape(schedule.time || '07:30')}"></label>
      <p><button id="setup-schedule-toggle" class="act" type="button" ${healthy ? '' : 'disabled'}>${schedule.enabled ? 'Disable daily scan' : 'Enable daily scan'}</button></p></div></div>`;
    this.el('setup-run-scan').addEventListener('click', () => this.runSupervisedScan());
    this.el('setup-schedule-toggle').addEventListener('click', () => this.toggleSchedule());
    this.el('setup-next').textContent = 'Finish';
  },

  async runSupervisedScan() {
    this.setBusy(true); this.setMessage('Scout is searching and scoring. This can take several minutes…');
    try {
      await requestJson('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: this.status?.config?.ai?.provider }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render(); this.setMessage('Scan completed. Review the dashboard results before enabling automation.', 'good');
      window.Scout?.loadOpportunities?.();
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async toggleSchedule() {
    this.setBusy(true);
    try {
      const enabled = this.status?.schedule?.enabled;
      await requestJson('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: enabled ? 'remove' : 'install', time: fieldValue('setup-schedule-time') || '07:30', provider: this.status?.config?.ai?.provider }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render(); this.setMessage(enabled ? 'Daily scan disabled.' : 'Daily scan enabled and verified.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  openScoutChat(prefill = 'ask') {
    window.Scout?.openChat?.('setup-onboarding', prefill);
  },

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  },

  move(delta) {
    if (this.busy) return;
    if (this.step === 2 && delta < 0 && this.preferenceStep > 0) {
      this.capturePreferenceQuestion();
      this.preferenceStep -= 1;
      this.render();
      return;
    }
    this.step = Math.max(0, Math.min(STEPS.length - 1, this.step + delta));
    this.render();
  },

  selectedProvider() {
    return document.querySelector('input[name="setup-provider"]:checked')?.value || '';
  },

  readPreferences() {
    return buildConfig(this.preferenceDraft || {}, this.status?.config);
  },

  async next() {
    if (this.busy) return;
    try {
      this.setBusy(true);
      if (this.step === 1) {
        const provider = this.selectedProvider();
        if (!provider) throw new Error('Sign in to Codex or Claude, refresh the status, then choose it.');
        const result = await requestJson('/api/setup/config', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ai: { provider, model: null } }),
        });
        this.status.config = result.config;
      }
      if (this.step === 2) {
        this.capturePreferenceQuestion();
        if (this.preferenceStep < 4) {
          this.preferenceStep += 1;
          this.renderPreferences();
          return;
        }
        const config = this.readPreferences();
        if (!config.profile.displayName) throw new Error('Enter your name so Scout can identify the workspace profile.');
        if (!config.search.roleFamilies.length) throw new Error('Add at least one role family or job title to search for.');
        if (!config.search.locations.length) throw new Error('Add at least one location or enter Remote.');
        if (!Number.isFinite(config.search.salaryMinimum) && config.search.salaryMinimum !== null) throw new Error('Minimum salary must be a number or blank.');
        if (!config.locale || !config.currency || !config.timezone) throw new Error('Locale, currency and timezone are required.');
        const result = await requestJson('/api/setup/config', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
        });
        this.status.config = result.config;
        window.Scout?.applyWorkspaceConfig?.(result.config);
      }
      if (this.step === 3) {
        const appId = fieldValue('setup-adzuna-id').trim();
        const apiKey = fieldValue('setup-adzuna-key').trim();
        if ((appId && !apiKey) || (!appId && apiKey)) throw new Error('Enter both Adzuna values, or leave both blank to skip.');
        if (appId && apiKey) {
          const result = await requestJson('/api/setup/credentials', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, apiKey }),
          });
          this.status.adzunaConfigured = result.configured;
          this.el('setup-adzuna-id').value = '';
          this.el('setup-adzuna-key').value = '';
        }
      }
      if (this.step === 4 && !this.imported) {
        const file = this.el('setup-cv-file')?.files?.[0];
        if (file) {
          validateCvName(file.name);
          if (file.size > 10 * 1024 * 1024) throw new Error('CV must be no larger than 10 MB.');
          this.setMessage('Extracting CV locally…');
          const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
          this.imported = await requestJson('/api/setup/import-cv', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, base64 }),
          });
          this.renderImport();
          this.setMessage('CV imported. Review the extracted preview, then continue.', 'good');
          return;
        }
      }
      if (this.step === 4) {
        this.status = await requestJson('/api/setup/status');
        window.Scout?.applyWorkspaceConfig?.(this.status.config);
      }
      if (this.step === 5) {
        await this.refreshStatus({ keepOpen: true });
        const action = handoffAction(this.status.ready);
        if (!action.defer) { this.step += 1; this.render(); }
        else this.deferSetup();
        return;
      }
      if (this.step === STEPS.length - 1) { this.el('setup-overlay').classList.add('hidden'); return; }
      this.step += 1;
      this.render();
    } catch (error) {
      this.setMessage(error.message, 'error');
    } finally {
      this.setBusy(false);
    }
  },

  async copyPrompt() {
    const input = this.el('setup-ai-prompt');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    this.setMessage('Onboarding prompt copied.', 'good');
  },

  deferSetup() {
    if (!this.status?.trackerExists || this.status?.ready) return;
    localStorage.setItem(SETUP_DEFERRED_KEY, 'true');
    this.el('setup-overlay').classList.add('hidden');
  },
};

if (typeof window !== 'undefined') window.ScoutSetup = Setup;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Setup.init());
  else Setup.init();
}
