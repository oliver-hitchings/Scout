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
  return { label: ready ? 'Continue to first scan' : 'Activate a proposal to continue', defer: false, ready: Boolean(ready) };
}

export function shouldAutoRunFirstScan(scanHealth = {}, ready = true) {
  return Boolean(ready && !scanHealth.lastRunAt);
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
  incrementalSection: null,
  proposal: null,
  restoredPreferences: null,
  pendingRecoveryKey: null,

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
      if (this.status.bootstrap) {
        this.proposal = null;
        this.el('setup-overlay').classList.remove('hidden');
        this.renderBootstrap();
        return;
      }
      if (this.status.sync?.enabled && !this.pendingRecoveryKey) {
        const pending = await requestJson('/api/sync/recovery-key', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        this.pendingRecoveryKey = pending.recoveryKey || null;
      }
      this.proposal = (await requestJson('/api/setup/proposal')).proposal;
      window.Scout?.applyWorkspaceConfig?.(this.status.config);
      this.el('setup-title').textContent = this.status.established ? 'Scout settings' : 'Set up Scout';
      this.el('setup-subtitle').textContent = this.status.established
        ? 'Review or retune your existing private workspace.'
        : 'A private workspace, tuned to your search.';
      const skipped = this.status.trackerExists && localStorage.getItem(SETUP_DEFERRED_KEY) === 'true';
      const pending = this.status.pendingSetupSections || [];
      if (!keepOpen && this.pendingRecoveryKey) {
        this.el('setup-overlay').classList.remove('hidden');
        this.render();
        return;
      }
      if (!keepOpen && pending.length && (this.status.setupComplete || this.status.established || this.status.ready || skipped)) {
        this.incrementalSection = pending[0];
        this.el('setup-overlay').classList.remove('hidden');
        this.render();
        return;
      }
      if (!keepOpen && (this.status.setupComplete || this.status.established || this.status.ready || skipped)) {
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
    this.incrementalSection = null;
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
    for (const id of ['setup-run-scan', 'setup-schedule-save', 'setup-schedule-disable']) {
      const button = this.el(id); if (button) button.disabled = busy;
    }
  },

  renderProgress() {
    this.el('setup-progress').innerHTML = STEPS.map((label, index) =>
      `<span class="${index <= this.step ? 'done' : ''}" title="${label}"></span>`).join('');
  },

  render() {
    this.setMessage();
    this.el('setup-next').classList.remove('hidden');
    if (this.incrementalSection) return this.renderIncrementalSection();
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
    const restored = this.restoredPreferences;
    const schedule = this.status?.schedule || {};
    const scheduleText = schedule.enabled
      ? `${this.escape(schedule.provider || 'provider')} daily at ${this.escape(schedule.time || '')}; next run ${this.escape(formatLocalDateTime(schedule.nextRunAt, this.status?.config?.locale))}; last result ${this.escape(schedule.lastResult || 'unknown')}`
      : schedule.configured
        ? 'A daily scan is saved in the workspace, but this computer’s scheduler is not active.'
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
        ${this.status?.device ? `<div class="setup-callout"><strong>Windows startup</strong><label class="setup-field"><span><input id="setup-start-with-windows" type="checkbox" ${this.status.device.startWithWindows ? 'checked' : ''}> Start Scout when I sign into Windows</span></label><p><button id="setup-save-device" class="act" type="button">Save startup setting</button></p></div>` : ''}
      </div>
      ${this.remoteAccessPanelHtml()}
      ${restored ? `<div class="setup-callout"><strong>Choose settings for this computer</strong><p>Your work has been restored. Device integrations stay off until you confirm them here.</p>${this.status?.device && restored.startWithWindows ? '<label class="setup-field"><span><input id="restore-start-with-windows" type="checkbox"> Start Scout with Windows on this computer</span></label>' : ''}${this.status?.schedule?.configured ? `<label class="setup-field"><span><input id="restore-daily-schedule" type="checkbox"> Enable the saved ${this.escape(this.status.schedule.time || '')} daily scan on this computer</span></label>` : ''}<p><button id="restore-apply-device" class="act primary" type="button">Apply selected settings</button> <button id="restore-keep-device-local" class="act" type="button">Keep them off</button></p></div>` : ''}
      <p>You can move or back up the workspace independently. API credentials stay in its ignored <code>.env</code> file and are never shown again here.</p>
      <p class="meta">Something stuck? <button id="setup-restart" class="act" type="button">Restart Scout</button> restarts the local server and reloads this page.</p></div></div>
      ${established ? this.backupPanelHtml() : ''}`;
    this.el('setup-restart').addEventListener('click', () => this.restartServer());
    this.el('setup-save-device')?.addEventListener('click', () => this.saveDeviceSetting());
    this.bindRemoteAccessPanel();
    this.el('restore-apply-device')?.addEventListener('click', () => this.applyRestoredPreferences());
    this.el('restore-keep-device-local')?.addEventListener('click', () => { this.restoredPreferences = null; this.render(); this.setMessage('Device integrations remain off. You can enable them later in Settings.', 'good'); });
    if (established) this.bindBackupPanel();
    this.el('setup-next').textContent = established ? 'Review settings' : 'Start setup';
  },

  renderIncrementalSection() {
    this.el('setup-title').textContent = 'Scout setup update';
    this.el('setup-subtitle').textContent = 'Only this new setting needs your attention.';
    this.el('setup-progress').innerHTML = '<span class="done" title="Windows startup"></span>';
    this.el('setup-back').classList.add('hidden');
    this.el('setup-skip').classList.remove('hidden');
    this.el('setup-skip').textContent = 'Later';
    this.el('setup-next').textContent = 'Save setting';
    this.el('setup-body').innerHTML = `<div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout has a new setting"></span></div><div class="scout-bubble tail-left"><h2>Should I start with Windows?</h2><p>This keeps Scout available in the notification-area arrow after you sign in. You can change it later in Settings.</p><label class="setup-field"><span><input id="setup-start-with-windows" type="checkbox" ${this.status?.device?.startWithWindows ? 'checked' : ''}> Start Scout when I sign into Windows</span></label></div></div>`;
  },

  async saveDeviceSetting() {
    const enabled = Boolean(this.el('setup-start-with-windows')?.checked);
    const result = await requestJson('/api/device/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startWithWindows: enabled }) });
    this.status.device = result.settings;
    this.setMessage('Windows startup setting saved.', 'good');
  },

  remoteAccessPanelHtml() {
    const remote = this.status?.remoteAccess || { state: 'disabled' };
    const local = this.status?.requestAccess !== 'remote-owner';
    if (remote.enabled && remote.origin) {
      return `<section class="setup-callout"><strong>Private Remote Access: on</strong><p>Only <strong>${this.escape(remote.ownerLogin || 'the configured owner')}</strong> can open Scout through Tailscale.</p><p><a href="${this.escape(remote.origin)}" target="_blank" rel="noreferrer">${this.escape(remote.origin)}</a></p><p>On your phone or laptop, install and sign in to Tailscale with that same login, open this address, then use your browser's <strong>Add to Home Screen</strong> or <strong>Install app</strong> action.</p><p class="meta">The host computer must be awake and signed in. Scout remains bound to this computer only; this is not a public internet address.</p>${local ? '<p><button id="setup-copy-remote-url" class="act" type="button">Copy address</button> <button id="setup-disable-remote" class="act" type="button">Turn off remote access</button></p>' : '<p class="meta">Remote hosting settings can only be changed on the Scout host computer.</p>'}</section>`;
    }
    if (!local) {
      return `<section class="setup-callout"><strong>Private Remote Access: ${this.escape(remote.state || 'off')}</strong><p>Finish setup on the Scout host computer.</p></section>`;
    }
    if (!remote.installed) {
      return `<section class="setup-callout"><strong>Private Remote Access (optional)</strong><p>Use this Scout workspace and its chats from your phone and laptop without exposing Scout to the public internet.</p><p><a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Install Tailscale from its official site</a>, sign in, then return here.</p><p><button id="setup-refresh-remote" class="act" type="button">Check again</button></p></section>`;
    }
    if (remote.state === 'setup-required') {
      return `<section class="setup-callout"><strong>Private Remote Access needs setup</strong><p>${this.escape(remote.blocker || 'Sign in to Tailscale on this computer.')}</p><p><button id="setup-refresh-remote" class="act" type="button">Check again</button></p></section>`;
    }
    const authorization = remote.state === 'authorizing' && remote.authorizationUrl
      ? `<p><a href="${this.escape(remote.authorizationUrl)}" target="_blank" rel="noreferrer">Authorize HTTPS in Tailscale</a>, then retry the same setup.</p>` : '';
    const portHelp = remote.customPortRequired
      ? '<p class="meta">HTTPS ports 443 and 8443 already have Serve mappings. Enter a different free port; Scout will not alter those mappings.</p>'
      : `<p class="meta">Scout will use HTTPS port ${this.escape(remote.suggestedPort || 443)} unless you choose another free port.</p>`;
    return `<section class="setup-callout"><strong>Private Remote Access (optional)</strong><p>Tailscale detected ${remote.ownerLogin ? `the signed-in owner <strong>${this.escape(remote.ownerLogin)}</strong>` : 'a signed-in account'}. Only this exact login will be accepted.</p>${remote.blocker ? `<p>${this.escape(remote.blocker)}</p>` : ''}${authorization}${portHelp}<label class="setup-field">HTTPS port (leave blank for automatic)<input id="setup-remote-port" type="number" min="1" max="65535" placeholder="${this.escape(remote.suggestedPort || '')}"></label>${this.status?.device ? '<label class="setup-field"><span><input id="setup-remote-startup" type="checkbox" checked> Start Scout automatically with Windows</span></label>' : ''}<label class="setup-field"><span><input id="setup-remote-confirm" type="checkbox"> I confirm only the detected Tailscale owner should have access</span></label><p><button id="setup-enable-remote" class="act primary" type="button">${remote.state === 'authorizing' ? 'Retry setup' : 'Enable private remote access'}</button> <button id="setup-refresh-remote" class="act" type="button">Check again</button></p><p class="meta">Scout inspects existing Tailscale Serve settings first and manages only its own mapping. It never enables Funnel, LAN access or router forwarding.</p></section>`;
  },

  bindRemoteAccessPanel() {
    this.el('setup-refresh-remote')?.addEventListener('click', () => this.refreshRemoteAccess());
    this.el('setup-enable-remote')?.addEventListener('click', () => this.enableRemoteAccess());
    this.el('setup-disable-remote')?.addEventListener('click', () => this.disableRemoteAccess());
    this.el('setup-copy-remote-url')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(this.status?.remoteAccess?.origin || '');
      this.setMessage('Remote address copied.', 'good');
    });
  },

  async refreshRemoteAccess() {
    this.setMessage('Checking Tailscale and existing Serve mappings...');
    try {
      this.status.remoteAccess = await requestJson('/api/remote-access/status');
      this.render();
      this.setMessage('Remote access status refreshed.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async enableRemoteAccess() {
    if (!this.el('setup-remote-confirm')?.checked) return this.setMessage('Confirm the detected owner before enabling remote access.', 'error');
    const port = fieldValue('setup-remote-port').trim();
    this.setMessage('Configuring Scout\'s private Tailscale address...');
    try {
      const result = await requestJson('/api/remote-access/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ httpsPort: port || null, confirmOwner: true, startWithWindows: this.el('setup-remote-startup')?.checked !== false }),
      });
      this.status.remoteAccess = result;
      if (result.state !== 'authorizing') await this.refreshStatus({ keepOpen: true });
      this.render();
      this.setMessage(result.state === 'authorizing' ? 'Approve HTTPS with Tailscale, then select Retry setup.' : result.startupWarning || 'Private remote access is ready.', result.startupWarning ? 'warning' : 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async disableRemoteAccess() {
    if (!confirm('Turn off Scout private remote access? Local use will continue.')) return;
    try {
      await requestJson('/api/remote-access/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await this.refreshStatus({ keepOpen: true });
      this.render();
      this.setMessage('Private remote access is off. Unrelated Tailscale mappings were left unchanged.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  providerCard(name) {
    const provider = this.status?.providers?.[name] || {};
    const selected = (this.status?.config?.ai?.provider || '') === name;
    const compatible = Boolean(provider.authenticated && provider.capabilities?.structuredOutput !== false);
    const state = !provider.installed ? 'Not installed'
      : !provider.authenticated ? 'Installed; sign-in required'
        : compatible ? 'Installed, signed in and compatible' : 'Installed and signed in; CLI update required';
    const login = name === 'codex' ? 'codex login' : 'claude auth login';
    const guide = name === 'codex' ? 'https://developers.openai.com/codex/cli/' : 'https://docs.anthropic.com/en/docs/claude-code/setup';
    return `<label class="setup-provider ${compatible ? 'available' : ''}">
      <input type="radio" name="setup-provider" value="${name}" ${selected ? 'checked' : ''} ${compatible ? '' : 'disabled'}>
      <strong>${name[0].toUpperCase() + name.slice(1)}</strong>
      <span class="meta">${state}</span>
      ${compatible ? '' : provider.authenticated
        ? `<span class="meta">Update this CLI from its <a href="${guide}" target="_blank" rel="noreferrer">official installation guide</a>, then refresh. Scout requires schema-constrained output for bounded workflows.</span>`
        : `<span class="meta"><a href="${guide}" target="_blank" rel="noreferrer">Official installation guide</a>. Open Windows PowerShell or your normal terminal, run <code>${login}</code>, complete its official CLI login flow, then refresh. A desktop-app login may not authenticate the command-line provider Scout uses. Your provider account may have separate usage limits or costs.</span>`}
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
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready to talk"></span></div><div class="scout-bubble tail-left">
      <h2>Generate your evidence-led CV and search proposal</h2>
      <p>Scout will use the answers and evidence you supplied to propose a CV, profile, scoring calibration and search lanes. Activation is required before the first scan.</p>
      <p><button id="setup-generate-proposal" class="act primary" type="button">${this.proposal ? 'Regenerate proposal' : 'Generate proposal'}</button></p>
      <p class="meta">Scout sends only your bounded setup answers and imported CV evidence. It stages validated changes for review and never activates them automatically.</p>
      ${this.proposal ? `<div class="setup-callout"><strong>Proposal ready</strong><p>${this.escape(this.proposal.summary || '')}</p>${(this.proposal.unresolvedQuestions || []).length ? `<p class="bad">Resolve first: ${this.escape(this.proposal.unresolvedQuestions.join('; '))}</p>` : ''}<details><summary>Review staged files</summary>${(this.proposal.files || []).map((file) => `<h3>${this.escape(file.path)}</h3><pre class="setup-preview">${this.escape(file.staged)}</pre>`).join('')}</details><p><button id="setup-activate-proposal" class="act primary" type="button" ${(this.proposal.unresolvedQuestions || []).length ? 'disabled' : ''}>Approve and activate</button> <button id="setup-discard-proposal" class="act" type="button">Discard</button></p></div>` : ''}
      </div></div>
      <div class="setup-callout"><strong>${this.status?.ready ? 'Proposal activated' : 'Review and activation required'}</strong><p>${this.status?.ready ? 'Your approved evidence and settings are ready for a supervised first scan.' : 'Generate a complete proposal, review all five files and activate them before continuing.'}</p></div>`;
    this.el('setup-generate-proposal').addEventListener('click', () => this.generateProposal());
    this.el('setup-activate-proposal')?.addEventListener('click', () => this.activateProposal());
    this.el('setup-discard-proposal')?.addEventListener('click', () => this.discardProposal());
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
      <p><button id="setup-run-scan" class="act primary" type="button" ${this.busy ? 'disabled' : ''}>${healthy ? 'Scan now' : 'Run first scan now'}</button></p>
      <div class="setup-callout"><strong>Daily scan schedule</strong><p>${schedule.enabled ? `Enabled at ${this.escape(schedule.time || '')} using ${this.escape(schedule.provider || '')}. Change the time below and save to update it.` : 'Choose when Scout should scan each day. It can be enabled after the first healthy scan.'}</p>
      <label class="setup-field">Daily time<input id="setup-schedule-time" type="time" value="${this.escape(schedule.time || '07:30')}"></label>
      <p><button id="setup-schedule-save" class="act" type="button" ${healthy ? '' : 'disabled'}>${schedule.enabled ? 'Save daily scan time' : 'Enable daily scan'}</button>${schedule.enabled ? ' <button id="setup-schedule-disable" class="act" type="button">Disable daily scan</button>' : ''}</p></div></div>
      ${this.backupPanelHtml()}`;
    this.el('setup-run-scan').addEventListener('click', () => this.runSupervisedScan());
    this.el('setup-schedule-save').addEventListener('click', () => this.saveSchedule());
    this.el('setup-schedule-disable')?.addEventListener('click', () => this.disableSchedule());
    this.bindBackupPanel();
    this.el('setup-next').textContent = 'Finish';
  },

  async runSupervisedScan() {
    this.setBusy(true); this.setMessage('Scout is searching and scoring. This can take several minutes…');
    try {
      const result = await requestJson('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: this.status?.config?.ai?.provider }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render();
      this.setMessage(result.status === 'degraded'
        ? 'Scan completed with degraded source coverage. Review the source details and retry before enabling automation.'
        : 'Scan completed. Review the dashboard results before enabling automation.', result.status === 'degraded' ? 'warning' : 'good');
      window.Scout?.loadOpportunities?.();
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  renderBootstrap() {
    const git = this.status?.git || {};
    this.el('setup-title').textContent = 'Welcome to Scout';
    this.el('setup-subtitle').textContent = 'Start locally or restore your private workspace.';
    this.el('setup-progress').innerHTML = '';
    this.el('setup-back').classList.add('hidden');
    this.el('setup-next').classList.add('hidden');
    this.el('setup-skip').classList.add('hidden');
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame setup-scout-welcome" role="img" aria-label="Scout welcomes you"></span></div><div class="scout-bubble tail-left">
      <h2>How would you like to begin?</h2>
      <p>Scout stores your CV, job tracker and chats in a private folder on this computer. Online backup is optional; Scout works fully without GitHub.</p>
      <div class="setup-grid">
        <div class="setup-callout"><strong>Set up Scout for the first time</strong><p>Create a new local workspace. You can add private backup at the end or later in Settings.</p><button id="setup-create-workspace" class="act primary" type="button">Create my local workspace</button></div>
        <div class="setup-callout"><strong>Restore my existing workspace</strong><p>Use a private GitHub repository made by Scout backup. Tracked career files remain readable in that private repository; credentials, generated documents and chat transcripts are encrypted.</p><button id="setup-show-restore" class="act" type="button">Restore existing workspace</button></div>
      </div>
      <div id="setup-restore-form" class="setup-callout hidden">
        <strong>Restore from private GitHub</strong>
        <p>${git.installed && git.credentialManager ? 'Git and Git Credential Manager are ready. GitHub will open its normal browser sign-in if needed.' : 'Install Git for Windows with Git Credential Manager, then return here and check again.'}</p>
        ${git.installed && git.credentialManager ? '' : '<p><a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">Install Git for Windows</a> <button id="setup-check-git" class="act" type="button">Check again</button></p>'}
        <label class="setup-field">Private repository HTTPS URL<input id="setup-restore-url" type="url" placeholder="https://github.com/your-name/scout-workspace"></label>
        <label class="setup-field">Recovery passphrase or recovery key<input id="setup-restore-secret" type="password" autocomplete="off"></label>
        <p><button id="setup-restore-workspace" class="act primary" type="button" ${git.installed && git.credentialManager ? '' : 'disabled'}>Restore securely</button></p>
        <p class="meta">Restore requires an empty Scout workspace folder and never overwrites existing work.</p>
      </div></div></div>`;
    this.el('setup-create-workspace').addEventListener('click', () => this.createWorkspace());
    this.el('setup-show-restore').addEventListener('click', () => this.el('setup-restore-form').classList.remove('hidden'));
    this.el('setup-check-git')?.addEventListener('click', () => location.reload());
    this.el('setup-restore-workspace')?.addEventListener('click', () => this.restoreWorkspace());
  },

  async createWorkspace() {
    this.setMessage('Creating your local private workspace…');
    try {
      await requestJson('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      this.el('setup-next').classList.remove('hidden');
      await this.refreshStatus({ keepOpen: true });
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async restoreWorkspace() {
    const remoteUrl = fieldValue('setup-restore-url').trim();
    const secret = fieldValue('setup-restore-secret').trim();
    if (!remoteUrl || !secret) return this.setMessage('Enter the private repository URL and a recovery secret.', 'error');
    this.setMessage('Signing in, validating and restoring your private workspace…');
    try {
      const result = await requestJson('/api/workspace/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remoteUrl, secret }),
      });
      this.restoredPreferences = result.devicePreferences || {};
      this.el('setup-next').classList.remove('hidden');
      await this.refreshStatus({ keepOpen: true });
      this.setMessage(result.devicePreferences ? 'Workspace restored. Review this computer’s startup and schedule preferences before enabling them.' : 'Workspace restored successfully.', 'good');
      window.Scout?.loadOpportunities?.();
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async applyRestoredPreferences() {
    this.setMessage('Applying the settings you selected for this computer…');
    try {
      if (this.el('restore-start-with-windows')?.checked) {
        await requestJson('/api/device/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startWithWindows: true }),
        });
      }
      if (this.el('restore-daily-schedule')?.checked) {
        await requestJson('/api/schedule', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'install', time: this.status?.schedule?.time || '07:30', provider: this.status?.config?.schedule?.provider || this.status?.config?.ai?.provider }),
        });
      }
      this.restoredPreferences = null;
      await this.refreshStatus({ keepOpen: true });
      this.render();
      this.setMessage('Selected settings are active on this computer.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  backupPanelHtml() {
    const sync = this.status?.sync || { state: 'disabled' };
    const git = this.status?.git || {};
    const gitReady = Boolean(git.installed && git.credentialManager);
    const labels = {
      synced: 'Synced', syncing: 'Backing up', offline: 'Offline — changes saved locally',
      pending: 'Backup pending', 'needs-attention': 'Needs attention', disabled: 'Not enabled', 'setup-required': 'Git setup required',
    };
    if (this.pendingRecoveryKey) return `<section class="setup-callout recovery-key-panel" role="status" aria-labelledby="recovery-key-title"><strong id="recovery-key-title">Save your emergency recovery key</strong><p>This key can restore Scout if you forget the passphrase. It will disappear after you confirm it is saved.</p><code id="setup-recovery-key" class="recovery-key" tabindex="0">${this.escape(this.pendingRecoveryKey)}</code><p><button id="setup-copy-recovery" class="act" type="button">Copy key</button> <button id="setup-save-recovery" class="act" type="button">Save key to file</button></p><label class="setup-field"><span><input id="setup-confirm-recovery" type="checkbox"> I saved the recovery key somewhere secure</span></label><p><button id="setup-finish-recovery" class="act primary" type="button">Finish backup setup</button></p></section>`;
    if (sync.enabled) return `<div class="setup-callout"><strong>Private backup: ${this.escape(labels[sync.state] || sync.state)}</strong><p>Your private GitHub repository is connected. Automatic backup can be turned off without deleting local work or GitHub history.</p>${sync.error ? `<details><summary>Technical details</summary><pre class="setup-preview">${this.escape(sync.error)}</pre></details>` : ''}<p><button id="setup-backup-now" class="act" type="button">Back up now</button> ${['offline', 'pending', 'needs-attention'].includes(sync.state) ? '<button id="setup-retry-backup" class="act" type="button">Retry</button> ' : ''}<button id="setup-disable-backup" class="act" type="button">Turn off automatic backup</button></p></div>`;
    return `<div class="setup-callout"><strong>Optional private backup</strong><p>Scout works fully on this computer without GitHub. A private repository lets you restore on another computer. Tracked career files are readable in that private repository; credentials, generated documents and chat transcripts are encrypted.</p><p><button id="setup-show-backup" class="act" type="button">Set up private backup</button> <button id="setup-skip-backup" class="act" type="button">Not now</button></p><div id="setup-backup-form" class="hidden"><p>${gitReady ? 'Git and Git Credential Manager are ready. GitHub will use its normal browser sign-in.' : 'Install Git for Windows with Git Credential Manager before connecting a private repository.'}</p>${gitReady ? '' : '<p><a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">Install Git for Windows</a> <button id="setup-backup-check-git" class="act" type="button">Check again</button></p>'}<p>A repository is a private online folder with version history. On GitHub, create an empty repository named <code>scout-workspace</code>, select <strong>Private</strong>, and do not add a README, licence or .gitignore.</p><p><a href="https://github.com/new" target="_blank" rel="noreferrer">Create a private GitHub repository</a></p><label class="setup-field">Repository HTTPS URL<input id="setup-backup-url" type="url" placeholder="https://github.com/your-name/scout-workspace"></label><label class="setup-field">Recovery passphrase (at least 12 characters)<input id="setup-backup-passphrase" type="password" autocomplete="new-password"></label><label class="setup-field"><span><input id="setup-backup-confirm" type="checkbox"> I understand tracked career files are readable in my private repository and I will save the emergency recovery key.</span></label><p><button id="setup-connect-backup" class="act primary" type="button" ${gitReady ? '' : 'disabled'}>Connect and create first backup</button></p></div></div>`;
  },

  bindBackupPanel() {
    this.el('setup-show-backup')?.addEventListener('click', () => this.el('setup-backup-form').classList.remove('hidden'));
    this.el('setup-skip-backup')?.addEventListener('click', () => this.setMessage('Private backup skipped. You can enable it later in Settings.', 'good'));
    this.el('setup-backup-check-git')?.addEventListener('click', () => location.reload());
    this.el('setup-connect-backup')?.addEventListener('click', () => this.connectBackup());
    this.el('setup-backup-now')?.addEventListener('click', () => this.backupNow());
    this.el('setup-retry-backup')?.addEventListener('click', () => this.retryBackup());
    this.el('setup-disable-backup')?.addEventListener('click', () => this.disableBackup());
    this.el('setup-copy-recovery')?.addEventListener('click', () => this.copyRecoveryKey());
    this.el('setup-save-recovery')?.addEventListener('click', () => this.saveRecoveryKey());
    this.el('setup-finish-recovery')?.addEventListener('click', () => this.finishRecoveryKey());
  },

  async connectBackup() {
    const remoteUrl = fieldValue('setup-backup-url').trim();
    const passphrase = fieldValue('setup-backup-passphrase');
    if (!this.el('setup-backup-confirm')?.checked) return this.setMessage('Confirm the private-repository and recovery-key notice first.', 'error');
    this.setMessage('Checking privacy, signing in and creating the first backup…');
    try {
      const result = await requestJson('/api/sync/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remoteUrl, passphrase }) });
      this.pendingRecoveryKey = result.recoveryKey;
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage(result.status?.state === 'synced'
        ? 'First backup complete. Save the emergency recovery key to finish.'
        : 'Private backup is enabled, but the GitHub copy is still pending. Save the emergency recovery key, then use Retry when the connection is available.', result.status?.state === 'synced' ? 'good' : 'error');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async copyRecoveryKey() {
    try {
      await navigator.clipboard.writeText(this.pendingRecoveryKey);
    } catch {
      const key = this.el('setup-recovery-key');
      const range = document.createRange(); range.selectNodeContents(key);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('copy'); selection.removeAllRanges();
    }
    this.setMessage('Recovery key copied.', 'good');
  },

  saveRecoveryKey() {
    const content = `Scout emergency recovery key\n\n${this.pendingRecoveryKey}\n\nKeep this file private. Either this key or your recovery passphrase can restore the encrypted Scout backup.\n`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'scout-recovery-key.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.setMessage('Recovery-key file prepared. Store it somewhere secure.', 'good');
  },

  async finishRecoveryKey() {
    if (!this.el('setup-confirm-recovery')?.checked) return this.setMessage('Confirm that you saved the recovery key first.', 'error');
    try {
      await requestJson('/api/sync/recovery-key/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      this.pendingRecoveryKey = null;
      this.render();
      this.setMessage(this.status?.sync?.state === 'synced'
        ? 'Private backup is enabled and up to date.'
        : 'Recovery key confirmed. Your GitHub backup is still pending; Scout will retry automatically.', this.status?.sync?.state === 'synced' ? 'good' : 'error');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async backupNow() {
    try {
      const result = await requestJson('/api/sync/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'manual backup' }) });
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage(result.state === 'synced' ? 'Backup completed.' : 'Saved locally. The GitHub backup is still pending.', result.state === 'synced' ? 'good' : 'error');
    }
    catch (error) { this.setMessage(error.message, 'error'); }
  },

  async retryBackup() {
    try {
      const result = await requestJson('/api/sync/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage(result.state === 'synced' ? 'Backup is synced.' : 'Scout still needs attention. Your work remains saved locally.', result.state === 'synced' ? 'good' : 'error');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async disableBackup() {
    if (!window.confirm('Turn off automatic backup on this computer? Local work and existing GitHub history will remain.')) return;
    try { await requestJson('/api/sync/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Automatic backup is off.', 'good'); }
    catch (error) { this.setMessage(error.message, 'error'); }
  },

  async generateProposal() {
    this.setBusy(true); this.setMessage('Scout is generating one bounded, evidence-led proposal…');
    try {
      await requestJson('/api/setup/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: this.status?.config?.ai?.provider }) });
      await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Proposal ready. Review every staged file before activation.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async activateProposal() {
    if (!this.proposal || !window.confirm('Activate exactly the reviewed staged files? Scout will create backups first.')) return;
    this.setBusy(true);
    try {
      await requestJson('/api/setup/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId: this.proposal.proposalId, confirmed: true }) });
      await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Proposal activated from trusted Scout controls. No extra AI turn was used.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async discardProposal() {
    this.setBusy(true);
    try {
      await requestJson('/api/setup/proposal', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
      await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Staged proposal discarded.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async saveSchedule() {
    this.setBusy(true);
    try {
      await requestJson('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', time: fieldValue('setup-schedule-time') || '07:30', provider: this.status?.config?.ai?.provider }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render(); this.setMessage('Daily scan time saved and verified.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async disableSchedule() {
    this.setBusy(true);
    try {
      await requestJson('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove' }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render(); this.setMessage('Daily scan disabled.', 'good');
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
    return document.querySelector('input[name="setup-provider"]:checked:not(:disabled)')?.value || '';
  },

  readPreferences() {
    return buildConfig(this.preferenceDraft || {}, this.status?.config);
  },

  async next() {
    if (this.busy) return;
    try {
      this.setBusy(true);
      if (this.incrementalSection) {
        await this.saveDeviceSetting();
        await requestJson('/api/setup/section', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.incrementalSection.id, action: 'complete' }) });
        this.incrementalSection = null;
        this.el('setup-overlay').classList.add('hidden');
        return;
      }
      if (this.step === 0 && this.status?.device) {
        const enabled = Boolean(this.el('setup-start-with-windows')?.checked);
        if (enabled !== Boolean(this.status.device.startWithWindows)) await this.saveDeviceSetting();
      }
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
        if (!this.status?.ready) throw new Error('Generate, review and activate a complete proposal before the first scan.');
        this.step += 1;
        this.render();
        if (shouldAutoRunFirstScan(this.status?.scanHealth, this.status?.ready)) setTimeout(() => this.runSupervisedScan(), 0);
        return;
      }
      if (this.step === STEPS.length - 1) {
        const result = await requestJson('/api/setup/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        this.status.setupComplete = Boolean(result.completedAt);
        localStorage.removeItem(SETUP_DEFERRED_KEY);
        this.el('setup-overlay').classList.add('hidden');
        return;
      }
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
    if (this.incrementalSection) {
      requestJson('/api/setup/section', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.incrementalSection.id, action: 'defer' }) })
        .then(() => { this.incrementalSection = null; this.el('setup-overlay').classList.add('hidden'); })
        .catch((error) => this.setMessage(error.message, 'error'));
      return;
    }
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
