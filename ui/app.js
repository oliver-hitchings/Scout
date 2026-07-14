// Kept self-contained so a browser connected to a pre-update Scout server can
// still boot. The matching modules contain the unit-tested canonical helpers.
const SCOUT_RUNTIME_STATES = {
  idle: ['/assets/scout-idle.png', 'Scout is ready'], listening: ['/assets/scout-idle.png', 'Scout is listening'],
  thinking: ['/assets/scout-thinking.png', 'Scout is thinking'], searching: ['/assets/scout-searching.png', 'Scout is searching'],
  writing: ['/assets/scout-explaining.png', 'Scout is updating your files'], explaining: ['/assets/scout-explaining.png', 'Scout is explaining'],
  found: ['/assets/scout-found.png', 'Scout found a strong match'], success: ['/assets/scout-found.png', 'Scout finished successfully'],
  warning: ['/assets/scout-warning.png', 'Scout needs your attention'],
};
function activityState(activity) {
  const value = String(activity || '').toLowerCase();
  if (/search|read|fetch|browse|source|advert/.test(value)) return 'searching';
  if (/write|edit|patch|file|cv|resume/.test(value)) return 'writing';
  if (/explain|answer|respond|delta/.test(value)) return 'explaining';
  return 'thinking';
}
function scoutMarkup(state = 'idle', className = '') {
  const def = SCOUT_RUNTIME_STATES[state] || SCOUT_RUNTIME_STATES.idle;
  return `<span class="scout-character ${className}" data-scout-state="${state}" role="img" aria-label="${def[1]}"><span class="scout-sprite" aria-hidden="true"></span></span>`;
}
function applyScoutState(element, state, { reducedMotion = false } = {}) {
  if (!element) return;
  const def = SCOUT_RUNTIME_STATES[state] || SCOUT_RUNTIME_STATES.idle;
  const sprite = element.querySelector('.scout-sprite');
  element.dataset.scoutState = state in SCOUT_RUNTIME_STATES ? state : 'idle';
  element.setAttribute('aria-label', def[1]);
  if (!sprite) return;
  sprite.style.setProperty('--scout-src', `url("${def[0]}")`);
  sprite.style.setProperty('--scout-columns', 4); sprite.style.setProperty('--scout-rows', 4);
  sprite.style.setProperty('--scout-frames', 16); sprite.style.setProperty('--scout-duration', '2s');
  sprite.style.setProperty('--scout-iterations', ['found','success','warning'].includes(state) ? '1' : 'infinite');
  sprite.style.setProperty('--scout-still-x', '0%'); sprite.style.setProperty('--scout-still-y', '0%');
  sprite.classList.toggle('reduced-motion', reducedMotion);
}
function strongUnseenMatches(entries, threshold, acknowledged = []) {
  const seen = new Set(acknowledged || []);
  return (entries || []).filter((entry) => entry.status === 'new' && Number.isFinite(entry.score) && entry.score >= threshold && !seen.has(entry.id));
}
function discoveryStorageKey(identity = 'default') {
  let hash = 2166136261;
  for (const char of String(identity)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `scout.discoveries.${(hash >>> 0).toString(36)}.v1`;
}
function mergeAcknowledged(current, entries) {
  return [...new Set([...(current || []), ...(entries || []).map((entry) => entry.id).filter(Boolean)])];
}

const Scout = {
  state: {
    data: null,
    sort: { key: 'score', dir: -1 },
    filter: '',
    tab: 'startup',
    commute: { mode: 'either', maxMinutes: '180', includeUnknown: true },
  },
  cvState: { path: null, slug: null, opportunityId: null, dirty: false },
  cvOptionsOpportunityId: null,
  cvPreviewZoom: 'page-width',
  chat: null,
  chatOpenSeq: 0,
  workspaceConfig: null,
  discoveries: [],
  discoveryTimer: null,
  scanRunning: false,

  async api(pathname, opts) {
    const r = await fetch(pathname, opts);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));
  },
  jsArg(s) { return this.esc(JSON.stringify(String(s ?? '')).replace(/</g, '\\u003c')); },
  cardById(id) {
    const visible = document.querySelector('main > section:not(.hidden)');
    return visible
      ? [...visible.querySelectorAll('.card[data-id]')].find((card) => card.dataset.id === String(id))
      : null;
  },
  stages(e) { return (e.application && Array.isArray(e.application.stages)) ? e.application.stages : []; },
  currentStage(e) {
    const next = this.stages(e).find((s) => !s.completed);
    return next ? next.name : '';
  },
  categories() {
    const configured = this.state.data?.categories;
    return Array.isArray(configured) && configured.length
      ? configured
      : [{ id: 'startup', label: 'Priority' }, { id: 'established', label: 'Explore' }];
  },
  categoryIds() { return this.categories().map((category) => category.id); },
  categoryLabel(id) { return this.categories().find((category) => category.id === id)?.label || id; },
  triagePolicy() { return { actionScore: 70, checkScore: 55, ...(this.workspaceConfig?.triage || {}) }; },
  categoryOf(e) {
    const raw = String(e.category || e.jobCategory || '').toLowerCase();
    const ids = this.categoryIds();
    if (ids.includes(raw)) return raw;
    if (['scaleup', 'hidden', 'speculative'].includes(raw)) return ids.includes('startup') ? 'startup' : ids[0];
    if (['corporate', 'mainstream', 'bigtech', 'big-tech', 'prime', 'standard'].includes(raw)) {
      return ids.includes('established') ? 'established' : (ids[1] || ids[0]);
    }
    return ids[0] || 'startup';
  },
  minuteValue(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  },
  commuteMinutes(e, mode) {
    const c = e.commute || {};
    if (mode === 'car') return this.minuteValue(c.carMinutes);
    return this.minuteValue(c.publicTransportMinutes ?? c.trainMinutes);
  },
  commuteLine(e) {
    const car = this.commuteMinutes(e, 'car');
    const pub = this.commuteMinutes(e, 'public');
    const bits = [];
    if (car !== null) bits.push(`car ${car}m`);
    if (pub !== null) bits.push(`public ${pub}m`);
    if (!bits.length) return '';
    const origin = (e.commute && e.commute.originPostcode) || this.workspaceConfig?.commute?.origin;
    return origin ? `${bits.join(' / ')} from ${origin}` : bits.join(' / ');
  },
  matchesCommute(e) {
    const { mode, maxMinutes, includeUnknown } = this.state.commute;
    if (mode === 'any' || maxMinutes === '' || maxMinutes === null || maxMinutes === undefined) return true;
    const max = Number(maxMinutes);
    const car = this.commuteMinutes(e, 'car');
    const pub = this.commuteMinutes(e, 'public');
    if (mode === 'car') return car === null ? includeUnknown : car <= max;
    if (mode === 'public') return pub === null ? includeUnknown : pub <= max;
    const known = [car, pub].filter((minutes) => minutes !== null);
    return known.length ? known.some((minutes) => minutes <= max) : includeUnknown;
  },
  filteredEntries(category = 'all') {
    const rows = [...(this.state.data?.opportunities || [])];
    return rows.filter((e) => (category === 'all' || this.categoryOf(e) === category) && this.matchesCommute(e));
  },
  fitClass(score) {
    if (typeof score !== 'number') return 'fit-weak';
    const policy = this.triagePolicy();
    if (score >= policy.actionScore) return 'fit-strong';
    if (score >= policy.checkScore) return 'fit-medium';
    return 'fit-weak';
  },
  safeHref(s) {
    try {
      const u = new URL(String(s ?? ''));
      return (u.protocol === 'http:' || u.protocol === 'https:') ? this.esc(u.href) : '';
    } catch {
      return '';
    }
  },
  primarySource(e) {
    return (e.sources && e.sources[0]) ? this.safeHref(e.sources[0]) : '';
  },

  async loadOpportunities() {
    [this.state.data, this.state.cvFiles] = await Promise.all([
      this.api('/api/opportunities'),
      this.api('/api/cv'),
    ]);
    this.applyWorkspaceConfig(this.state.data.workspaceConfig, { render: false });
    this.setupCategoryUi();
    const h = this.state.data.scanHealth;
    const health = h ? (h.healthy ? 'healthy' : (h.stale ? 'stale' : 'degraded')) : 'unknown';
    document.getElementById('scan-status').textContent = `last scan: ${this.state.data.updated} - ${health}`;
    this.categoryIds().forEach((category) => this.renderCategory(category));
    this.renderPipeline();
    this.renderAll();
    this.queueStrongMatches();
  },

  async scanNow() {
    if (this.scanRunning || this.chat?.streaming) return;
    const button = document.getElementById('scan-now');
    this.scanRunning = true;
    if (button) { button.disabled = true; button.textContent = 'Scanning…'; }
    document.getElementById('scan-status').textContent = 'Scout is searching now…';
    try {
      const response = await fetch('/api/scan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: this.workspaceConfig?.ai?.provider }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Scan failed (${response.status})`);
      await this.loadOpportunities();
    } catch (error) {
      document.getElementById('scan-status').textContent = error.message;
    } finally {
      this.scanRunning = false;
      if (button) { button.disabled = false; button.textContent = 'Scan now'; }
    }
  },

  discoveryKey() {
    const c = this.workspaceConfig || {};
    return discoveryStorageKey([c.profile?.displayName, c.locale, c.timezone].filter(Boolean).join('|'));
  },

  acknowledgedDiscoveries() {
    try { return JSON.parse(localStorage.getItem(this.discoveryKey()) || '[]'); } catch { return []; }
  },

  queueStrongMatches() {
    this.discoveries = strongUnseenMatches(
      this.state.data?.opportunities,
      this.triagePolicy().actionScore,
      this.acknowledgedDiscoveries(),
    );
    if (!this.discoveries.length) return;
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => this.showStrongMatchArrival(), 700);
  },

  interfaceBusy() {
    const setup = document.getElementById('setup-overlay');
    const activeInput = document.activeElement;
    return (setup && !setup.classList.contains('hidden'))
      || !!this.chat?.streaming
      || !!activeInput?.matches?.('input, textarea, select');
  },

  showStrongMatchArrival() {
    if (!this.discoveries.length) return;
    if (this.interfaceBusy()) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = setTimeout(() => this.showStrongMatchArrival(), 1500);
      return;
    }
    const first = this.discoveries[0];
    const count = this.discoveries.length;
    const el = document.getElementById('scout-arrival');
    el.innerHTML = `<div class="scout-arrival-copy scout-bubble tail-right" role="status" aria-live="polite">
        <b>${count === 1 ? 'I found a strong match' : `I found ${count} strong matches`}</b>
        <span>${this.esc(first.company)} — ${this.esc(first.role)} · ${this.esc(first.score)}</span>
        <div><button class="act primary" onclick="Scout.showDiscovery()">Show me</button><button class="act" onclick="Scout.dismissDiscoveries()">Later</button></div>
      </div>${scoutMarkup('found', 'scout-arrival-character')}`;
    el.classList.remove('hidden');
    applyScoutState(el.querySelector('.scout-character'), 'found', { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  },

  acknowledgeDiscoveries() {
    const merged = mergeAcknowledged(this.acknowledgedDiscoveries(), this.discoveries);
    localStorage.setItem(this.discoveryKey(), JSON.stringify(merged));
    localStorage.setItem(`${this.discoveryKey()}.last`, new Date().toISOString());
  },

  dismissDiscoveries() {
    this.acknowledgeDiscoveries();
    this.discoveries = [];
    document.getElementById('scout-arrival').classList.add('hidden');
  },

  showDiscovery() {
    const first = this.discoveries[0];
    this.acknowledgeDiscoveries();
    document.getElementById('scout-arrival').classList.add('hidden');
    if (!first) return;
    this.showTab(this.categoryOf(first));
    requestAnimationFrame(() => {
      const card = this.cardById(first.id);
      if (card) { this.expandCard(first.id, card); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    this.discoveries = [];
  },

  metaLine(e) {
    const bits = [e.location, e.salary, e.stage].filter((x) => x && x !== 'unknown');
    bits.push(this.categoryOf(e));
    const commute = this.commuteLine(e);
    if (commute) bits.push(commute);
    const current = this.currentStage(e);
    if (current) bits.push(`current: ${current}`);
    const checked = e.lastChecked ? ` - checked ${this.esc(e.lastChecked)}` : '';
    return this.esc(bits.join(' - ')) + checked;
  },

  cardHtml(e, cls = '') {
    const score = typeof e.score === 'number' ? e.score : '-';
    const idArg = this.jsArg(e.id);
    const src = this.primarySource(e);
    const srcBtn = src
      ? `<a class="source-btn" href="${src}" target="_blank" rel="noopener" onclick="event.stopPropagation()">view source &#8599;</a>`
      : '';
    return `<div class="card ${cls}" data-id="${this.esc(e.id)}" onclick="Scout.expandCard(${idArg},this)">
      <div class="top">
        <span class="score ${this.fitClass(e.score)}">${this.esc(score)}</span>
        <b>${this.esc(e.company)} - ${this.esc(e.role)}</b>
        <span class="chip">${this.esc(e.status)}</span>
      </div>
      <div class="meta">${this.metaLine(e)}</div>
      ${srcBtn}
      <div class="detail"></div>
    </div>`;
  },

  filterBar() {
    const c = this.state.commute;
    const origin = this.workspaceConfig?.commute?.origin;
    const option = (value, label) => `<option value="${value}" ${String(c.mode) === value ? 'selected' : ''}>${label}</option>`;
    const maxOption = (value, label) => `<option value="${value}" ${String(c.maxMinutes) === String(value) ? 'selected' : ''}>${label}</option>`;
    return `<div class="filterbar" onclick="event.stopPropagation()">
      <b>Commute${origin ? ` from ${this.esc(origin)}` : ''}</b>
      <label>mode <select onchange="Scout.setCommuteFilter('mode', this.value)">
        ${option('either', 'Either')}${option('car', 'Car')}${option('public', 'Public transport')}${option('any', 'Any')}
      </select></label>
      <label>maximum <select onchange="Scout.setCommuteFilter('maxMinutes', this.value)" ${c.mode === 'any' ? 'disabled' : ''}>
        ${maxOption('30', '30 min')}${maxOption('60', '1 hour')}${maxOption('90', '1.5 hours')}${maxOption('120', '2 hours')}${maxOption('180', '3 hours')}
      </select></label>
      <label><input type="checkbox" ${c.includeUnknown ? 'checked' : ''} onchange="Scout.setCommuteFilter('includeUnknown', this.checked)"> include unknown</label>
    </div>`;
  },

  setCommuteFilter(key, value) {
    this.state.commute[key] = value;
    this.categoryIds().forEach((category) => this.renderCategory(category));
    this.renderAll();
  },

  applyWorkspaceConfig(config, { render = true } = {}) {
    this.workspaceConfig = config || null;
    const commute = config?.commute;
    if (commute) {
      if (['either', 'car', 'public', 'any'].includes(commute.mode)) this.state.commute.mode = commute.mode;
      if (Number.isFinite(Number(commute.maxMinutes))) this.state.commute.maxMinutes = String(commute.maxMinutes);
      if (typeof commute.includeUnknown === 'boolean') this.state.commute.includeUnknown = commute.includeUnknown;
    }
    if (!this.state.data || !render) return;
    this.categoryIds().forEach((category) => this.renderCategory(category));
    this.renderAll();
  },

  setupCategoryUi() {
    const nav = document.querySelector('header nav');
    const main = document.querySelector('main');
    const pipelineButton = nav?.querySelector('button[data-tab="pipeline"]');
    const pipelineSection = document.getElementById('tab-pipeline');
    if (!nav || !main || !pipelineButton || !pipelineSection) return;
    nav.querySelectorAll('button[data-category="true"]').forEach((element) => element.remove());
    main.querySelectorAll('section[data-category="true"]').forEach((element) => element.remove());
    for (const category of this.categories()) {
      const button = document.createElement('button');
      button.dataset.tab = category.id;
      button.dataset.category = 'true';
      button.textContent = category.label;
      button.addEventListener('click', () => this.showTab(category.id));
      nav.insertBefore(button, pipelineButton);
      const section = document.createElement('section');
      section.id = `tab-${category.id}`;
      section.dataset.category = 'true';
      section.classList.add('hidden');
      main.insertBefore(section, pipelineSection);
    }
    if (!this.categoryIds().includes(this.state.tab)) this.state.tab = this.categoryIds()[0] || 'pipeline';
    this.showTab(this.state.tab);
  },

  renderCategory(category) {
    if (!this.state.data) return;
    const target = document.getElementById(`tab-${category}`);
    if (!target) return;
    const policy = this.triagePolicy();
    const entries = this.filteredEntries(category);
    const ids = new Set(entries.map((e) => e.id));
    const action = entries.filter((e) => e.status === 'new' && typeof e.score === 'number' && e.score >= policy.actionScore)
      .sort((a, b) => b.score - a.score);
    const unlock = entries.filter((e) => e.status === 'new' && typeof e.score === 'number' && e.score >= policy.checkScore && e.score < policy.actionScore
      && (e.tags || []).some((tag) => tag.includes('Check')))
      .sort((a, b) => b.score - a.score);
    const claimed = new Set([...action.map((e) => e.id), ...unlock.map((e) => e.id)]);
    const followups = (this.state.data.triage.followups || [])
      .filter((f) => ids.has(f.entry.id) && !claimed.has(f.entry.id));
    followups.forEach((f) => claimed.add(f.entry.id));
    const remaining = entries.filter((e) => !claimed.has(e.id));
    const remainingNew = remaining.filter((e) => e.status === 'new');
    const watch = remaining.filter((e) => e.status === 'watch');
    const active = remaining.filter((e) => ['outreach', 'applied', 'interviewing'].includes(e.status));
    const closed = remaining.filter((e) => ['accepted', 'rejected', 'ignore'].includes(e.status));
    const sec = (title, items, cls = '') => items.length
      ? `<div class="label">${title}</div>` + items.map((e) => this.cardHtml(e, cls)).join('')
      : '';
    const fu = followups.length
      ? '<div class="label">Follow-ups due</div>' + followups.map((f) =>
          `<div class="card" data-id="${this.esc(f.entry.id)}" onclick="Scout.expandCard(${this.jsArg(f.entry.id)},this)">
             <div class="top"><b>${this.esc(f.entry.company)}</b>
             <span class="chip">${f.due[0].kind === 'nudge' ? 'nudge due' : 'close-out due'}</span></div>
             <div class="meta">since ${this.esc(f.due[0].since)}</div>
             <div class="detail"></div></div>`).join('')
      : '';
    const label = this.categoryLabel(category);
    target.innerHTML =
      this.filterBar()
      + `<div class="label">${this.esc(label)} lane (${entries.length})</div>`
      + (sec('Action today', action, 'action') || '<p>Nothing new over the bar in this lane.</p>')
      + sec('One check from unlocking', unlock)
      + fu
      + sec('Remaining new', remainingNew)
      + sec('Watch', watch)
      + sec('Active', active)
      + sec('Closed', closed);
  },

  renderPipeline() {
    if (!this.state.data) return;
    const p = this.state.data.pipeline;
    const h = this.state.data.scanHealth;
    const el = document.getElementById('tab-pipeline');
    if (!p || !el) return;
    const metric = (label, value) => `<div class="metric"><b>${this.esc(value)}</b>${this.esc(label)}</div>`;
    const healthText = h
      ? `${h.healthy ? 'healthy' : (h.stale ? 'stale' : 'degraded')}${h.reason ? ' - ' + h.reason : ''}`
      : 'unknown';
    const sourceHealth = (h?.sourceHealth || []).length
      ? `<div class="source-health">${h.sourceHealth.map((source) => `<span class="chip source-${this.esc(source.status)}" title="${this.esc(source.reason || '')}">${this.esc(source.name)}: ${this.esc(source.status)}${source.count === null ? '' : ` (${this.esc(source.count)})`}</span>`).join('')}</div>`
      : '<div class="meta">No per-source health was recorded for this run.</div>';
    const flags = p.flags.length
      ? '<div class="label">Flags</div>' + p.flags.map((f) =>
          `<div class="card flag" data-id="${this.esc(f.id)}" onclick="Scout.expandCard(${this.jsArg(f.id)},this)">
            <div class="top"><b>${this.esc(f.company)}</b><span class="chip">${this.esc(f.kind)}</span></div>
            <div class="meta">${this.esc(f.role)} - ${this.esc(f.detail)}</div>
            <div class="detail"></div>
          </div>`).join('')
      : '<p>No pipeline flags.</p>';
    const list = (title, items) => `<div>
      <div class="label">${title}</div>
      ${items.length ? items.map((i) => this.pipelineCard(i)).join('') : '<p>Nothing here.</p>'}
    </div>`;
    el.innerHTML = `
      <div class="metrics">
        ${metric('new', p.summary.new ?? (p.new || []).length)}
        ${metric('watch', p.summary.watch ?? (p.watch || []).length)}
        ${metric('active', p.summary.active)}
        ${metric('closed / ignored', p.summary.recentlyClosed)}
        ${metric('flags', p.summary.flags)}
      </div>
      <div class="card">
        <div class="top"><b>Scan health</b><span class="chip">${this.esc(healthText)}</span></div>
        <div class="meta">last run: ${this.esc(h && h.lastRunAt ? h.lastRunAt : 'never')} - keepers: ${this.esc(h && h.keepersAdded !== null ? h.keepersAdded : 'n/a')} - candidates: ${this.esc(h && h.candidatesFound !== null ? h.candidatesFound : 'n/a')}</div>
        ${sourceHealth}
      </div>
      ${flags}
      <div class="split">
        ${list('New', p.new || [])}
        ${list('Watch', p.watch || [])}
        ${list('Active', p.active)}
        ${list('Closed / ignored', p.recentlyClosed)}
      </div>`;
  },

  pipelineCard(item) {
    const entry = this.state.data.opportunities.find((o) => o.id === item.id) || item;
    const bits = [
      item.currentStage ? `stage: ${item.currentStage}` : null,
      item.appliedDate ? `applied ${item.appliedDate}` : null,
      item.daysSinceLastMovement !== null ? `${item.daysSinceLastMovement}d since movement` : null,
    ].filter(Boolean).join(' - ');
    return `<div class="card" data-id="${this.esc(item.id)}" onclick="Scout.expandCard(${this.jsArg(item.id)},this)">
      <div class="top"><span class="score ${this.fitClass(item.score)}">${this.esc(item.score ?? '-')}</span><b>${this.esc(item.company)} - ${this.esc(item.role)}</b><span class="chip">${this.esc(item.status)}</span></div>
      <div class="meta">${this.esc(bits) || this.metaLine(entry)}</div>
      <div class="detail"></div>
    </div>`;
  },

  renderAll() {
    if (!this.state.data) return;
    const { key, dir } = this.state.sort;
    const q = this.state.filter.toLowerCase();
    let rows = this.filteredEntries('all');
    if (q) rows = rows.filter((e) => `${e.company} ${e.role} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q));
    rows.sort((a, b) => {
      const av = a[key] ?? (key === 'score' ? -1 : '');
      const bv = b[key] ?? (key === 'score' ? -1 : '');
      return av < bv ? dir : av > bv ? -dir : 0;
    });
    document.getElementById('tab-all').innerHTML =
      `${this.filterBar()}
       <div class="controls"><input id="filter" placeholder="search company / role / tag..." value="${this.esc(this.state.filter)}"></div>
       <table><thead><tr>
         <th onclick="Scout.setSort('score')">score</th>
         <th onclick="Scout.setSort('company')">company</th>
         <th>role</th>
         <th>category</th>
         <th>car</th>
         <th>public</th>
         <th>stage</th>
         <th onclick="Scout.setSort('status')">status</th>
         <th onclick="Scout.setSort('lastChecked')">last checked</th>
       </tr></thead><tbody>` +
      rows.map((e) => `<tr onclick="Scout.openEntry('${this.categoryOf(e)}',${this.jsArg(e.id)})" style="cursor:pointer">
        <td><b>${typeof e.score === 'number' ? e.score : '-'}</b></td>
        <td>${this.esc(e.company)}</td><td>${this.esc(e.role)}</td>
        <td>${this.esc(this.categoryOf(e))}</td>
        <td>${this.esc(this.commuteMinutes(e, 'car') ?? '-')}</td>
        <td>${this.esc(this.commuteMinutes(e, 'public') ?? '-')}</td>
        <td>${this.esc(this.currentStage(e) || '-')}</td>
        <td>${this.esc(e.status)}</td><td>${this.esc(e.lastChecked || 'never')}</td></tr>`).join('') +
      '</tbody></table>';
    const f = document.getElementById('filter');
    if (f) f.oninput = (ev) => { this.state.filter = ev.target.value; this.renderAll(); f.focus(); };
  },

  setSort(key) {
    const s = this.state.sort;
    s.dir = s.key === key ? -s.dir : (key === 'company' || key === 'status' ? 1 : -1);
    s.key = key;
    this.renderAll();
  },

  async renderReports() {
    const { reports } = await this.api('/api/reports');
    const el = document.getElementById('tab-reports');
    if (!reports.length) { el.innerHTML = '<p>No reports yet.</p>'; return; }
    el.innerHTML = `<div class="report-list">
      <div class="dates">${reports.map((d) => `<button class="act" data-date="${this.esc(d)}" onclick="Scout.openReport(${this.jsArg(d)})">${d}</button>`).join('')}</div>
      <div id="report-body" class="report-body" style="flex:1"></div></div>`;
    this.openReport(reports[0]);
  },

  async openReport(date) {
    const md = await this.api(`/api/reports/${date}`);
    document.getElementById('report-body').textContent = md;
    document.querySelectorAll('.report-list .dates button').forEach((b) =>
      b.classList.toggle('active', b.dataset.date === date));
  },

  openEntry(tab, id) {
    this.showTab(tab);
    const card = this.cardById(id);
    if (!card) return;
    this.expandCard(id, card, true);
    card.scrollIntoView({ block: 'nearest' });
  },

  expandCard(id, clickedCard = null, forceOpen = false) {
    const card = clickedCard || this.cardById(id);
    if (!card) return;
    if (forceOpen) card.classList.add('open');
    else card.classList.toggle('open');
    const e = this.state.data.opportunities.find((o) => o.id === id);
    const box = card.querySelector('.detail');
    if (e && box && !box.dataset.filled) {
      box.innerHTML = this.detailHtml(e);
      box.dataset.filled = '1';
    }
  },

  async toggleSourcePanel(id, btn) {
    const body = btn.closest('.source-panel').querySelector('.source-body');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    btn.textContent = open ? 'show what the source says' : 'hide source text';
    if (open || body.dataset.loaded) return;
    body.innerHTML = '<div class="meta">fetching source…</div>';
    let r;
    try { r = await this.api(`/api/source?id=${encodeURIComponent(id)}`); }
    catch { r = { ok: false, error: 'request failed' }; }
    body.dataset.loaded = '1';
    body.innerHTML = this.sourceBodyHtml(r);
  },

  sourceBodyHtml(r) {
    const fallback = `<div class="meta">couldn't read this page - open the source instead`;
    if (!r || typeof r !== 'object' || r.ok !== true) {
      const reason = r && r.error ? ` (${this.esc(r.error)})` : '';
      return `${fallback}${reason}</div>`;
    }
    let host = '';
    try { host = new URL(r.url).hostname; } catch { /* leave blank */ }
    const stamp = `<div class="meta">fetched ${this.esc(new Date(r.fetchedAt).toLocaleTimeString())}${host ? ` from ${this.esc(host)}` : ''}</div>`;
    const factLabels = {
      title: 'title', salary: 'salary', location: 'location',
      employmentType: 'type', workMode: 'work mode',
      datePosted: 'posted', validThrough: 'closes',
    };
    const facts = Object.entries(factLabels)
      .filter(([key]) => r.facts && r.facts[key])
      .map(([key, label]) => `<div class="meta"><b>${label}</b> ${this.esc(r.facts[key])}</div>`)
      .join('');
    const thin = r.thin ? `${fallback} - the page returned very little text</div>` : '';
    const text = r.text ? `<div class="source-text">${this.esc(r.text)}</div>` : '';
    return stamp
      + (facts || '<div class="meta">no key facts found on the page</div>')
      + thin + text;
  },

  detailHtml(e) {
    const bd = e.scoreBreakdown || {};
    const bars = ['technical', 'sector', 'upside', 'comp', 'location', 'acceleration', 'credibility']
      .filter((k) => k in bd)
      .map((k) => `<div class="meta">${k} <span style="width:${(bd[k] || 0) * 6}px"></span> ${bd[k]}</div>`)
      .join('');
    const tags = (e.tags || []).length
      ? `<div class="chip-list">${(e.tags || []).map((t) => `<span class="chip">${this.esc(t)}</span>`).join('')}</div>`
      : '';
    const contacts = (e.contacts || []).length
      ? e.contacts.map((c) => {
          const linkedin = this.safeHref(c.linkedin);
          return `<div class="meta">${this.esc(c.name)}${c.role ? ' - ' + this.esc(c.role) : ''}${linkedin ? ` - <a href="${linkedin}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</div>`;
        }).join('')
      : '<div class="meta">no contacts yet</div>';
    const log = (e.log || []).length
      ? e.log.map((l) => `<div class="meta">${this.esc(l.date)} - ${this.esc(l.event)}${l.note ? ': ' + this.esc(l.note) : ''}</div>`).join('')
      : '<div class="meta">no events yet</div>';
    const stages = this.stages(e);
    const commute = e.commute || {};
    const commuteHtml = this.commuteLine(e)
      ? `<div class="meta">${this.esc(this.commuteLine(e))}${commute.destination ? ' - ' + this.esc(commute.destination) : ''}${commute.checked ? ' - checked ' + this.esc(commute.checked) : ''}${commute.notes ? '<br>' + this.esc(commute.notes) : ''}</div>`
      : '<div class="meta">no commute time recorded yet</div>';
    const stageHtml = stages.length
      ? `<ol class="stage-list">${stages.map((s, i) =>
          `<li>${this.esc(s.completed ? '[x]' : '[ ]')} ${this.esc(s.name)}${s.date ? ' - ' + this.esc(s.date) : ''}${!s.completed ? ` <button class="act" onclick="event.stopPropagation();Scout.completeStage(${this.jsArg(e.id)},${i})">complete</button>` : ''}</li>`).join('')}</ol>`
      : '<div class="meta">no application stages yet</div>';
    const idArg = this.jsArg(e.id);
    const slug = this.slugOf(e.company);
    const slugArg = this.jsArg(slug);
    const cvFiles = this.state.cvFiles || { applications: [], outreach: [] };
    const hasCv = (cvFiles.applications || []).includes(slug);
    const hasOutreach = (cvFiles.outreach || []).includes(slug);
    const applied = ['applied', 'interviewing', 'accepted'].includes(e.status);
    const extraSources = (e.sources || []).slice(1)
      .map((s) => this.safeHref(s)).filter(Boolean)
      .map((href, i) => `<a href="${href}" target="_blank" rel="noopener">source ${i + 2}</a>`)
      .join(' - ');
    const sourcePanel = this.primarySource(e)
      ? `<div class="label">source</div>
         <div class="source-panel" onclick="event.stopPropagation()">
           <button class="act" onclick="Scout.toggleSourcePanel(${idArg},this)">show what the source says</button>
           ${extraSources ? `<span class="meta"> ${extraSources}</span>` : ''}
           <div class="source-body" style="display:none"></div>
         </div>`
      : '';
    return `
      ${sourcePanel}
      <div class="label">score breakdown (read-only)</div>${bars || '<div class="meta">not scored yet</div>'}
      <div class="label">tags</div>${tags || '<div class="meta">-</div>'}
      <div class="label">category</div><div class="meta">${this.esc(this.categoryOf(e))}</div>
      <div class="label">commute</div>${commuteHtml}
      <div class="label">contacts</div>${contacts}
      <div class="label">application stages</div>${stageHtml}
      <div class="label">event log</div>${log}
      <div class="label">notes</div><div class="meta" style="white-space:pre-wrap">${this.esc(e.notes || '-')}</div>
      <div class="controls" style="margin-top:10px;flex-wrap:wrap" onclick="event.stopPropagation()">
        ${applied ? '' : `<button class="act" onclick="Scout.markApplied(${idArg})">mark applied</button>`}
        <button class="act" onclick="Scout.markAccepted(${idArg})">mark accepted</button>
        <button class="act" onclick="Scout.rejectOpportunity(${idArg})">mark rejected</button>
        ${hasCv
          ? `<button class="act" onclick="Scout.seeCv(${slugArg},${idArg})">see custom CV</button>`
          : `<button class="act bridge" onclick="Scout.chooseCvOptions(${idArg})">create custom CV</button>`}
        ${hasOutreach
          ? `<button class="act" onclick="Scout.seeCoverLetter(${slugArg})">see cover letter</button>`
          : `<button class="act bridge" onclick="Scout.openChat(${idArg},'coverLetter')">create custom cover letter</button>`}
        <button class="act bridge" onclick="Scout.openChat(${idArg},'fit')">fit and evidence gaps</button>
        <button class="act bridge" onclick="Scout.openChat(${idArg},'ask')">ask about this job</button>
      </div>`;
  },

  async post(pathname, payload) {
    const r = await this.api(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r && r.ok) {
      if (r.committed === false) alert('Saved, but not committed to git - mention it to Claude.');
      const activeTab = this.state.tab;
      await this.loadOpportunities();
      this.showTab(activeTab);
      if (payload.id && this.cardById(payload.id)) this.expandCard(payload.id, this.cardById(payload.id), true);
    } else {
      alert(`Failed: ${(r && r.error) || 'unknown error'}`);
    }
    return r;
  },

  markApplied(id) { this.post('/api/applied', { id, note: '' }); },
  markAccepted(id) {
    if (confirm('Mark this opportunity as accepted?')) this.post('/api/status', { id, status: 'accepted' });
  },
  rejectOpportunity(id) {
    if (confirm('Mark this opportunity as rejected?')) this.post('/api/rejected', { id, note: 'Rejected / closed out.' });
  },
  completeStage(id, index) { this.post('/api/stage/complete', { id, index }); },

  company(id) {
    if (id === 'setup-onboarding') return 'Scout setup';
    const e = this.state.data.opportunities.find((o) => o.id === id);
    return e ? e.company : id;
  },

  slugOf(company) {
    return String(company || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  waitFor(selector) {
    return new Promise((resolve) => {
      const tick = () => (document.querySelector(selector) ? resolve() : setTimeout(tick, 50));
      tick();
    });
  },

  async seeCv(slug, opportunityId = null) {
    this.showTab('cv');
    await this.waitFor('#cv-text');
    this.openCv(`applications/${slug}/cv.typ`, slug, opportunityId);
  },

  async seeCoverLetter(slug) {
    this.showTab('cv');
    await this.waitFor('#cv-text');
    this.openCv(`applications/${slug}/outreach.md`, null);
  },

  chooseCvOptions(id) {
    this.cvOptionsOpportunityId = id;
    document.getElementById('cv-option-xyz').checked = true;
    document.getElementById('cv-option-humanize').checked = true;
    document.getElementById('cv-options-overlay').classList.remove('hidden');
  },

  closeCvOptions() {
    this.cvOptionsOpportunityId = null;
    document.getElementById('cv-options-overlay').classList.add('hidden');
  },

  startCvFromOptions() {
    const id = this.cvOptionsOpportunityId;
    if (!id) return this.closeCvOptions();
    const cvOptions = {
      xyz: document.getElementById('cv-option-xyz').checked,
      humanize: document.getElementById('cv-option-humanize').checked,
    };
    this.closeCvOptions();
    this.openChat(id, 'cv', cvOptions);
  },

  async renderCv() {
    const list = await this.api('/api/cv');
    const el = document.getElementById('tab-cv');
    const appBtns = list.applications.map((s) => {
      const cvPath = `applications/${s}/cv.typ`;
      const opportunityId = this.opportunityIdForSlug(s);
      return `<button class="act" data-cv-path="${this.esc(cvPath)}" onclick="Scout.openCv(${this.jsArg(cvPath)},${this.jsArg(s)},${opportunityId ? this.jsArg(opportunityId) : 'null'})">${this.esc(s)}</button>`;
    }).join('') || '<div class="meta">no tailored CVs yet - run /tailor</div>';
    el.innerHTML = `
      <div class="cv-layout">
        <aside class="cv-sidebar">
          <div class="label">master</div>
          <button class="act" data-cv-path="${this.esc('cv/master-cv.md')}" onclick="Scout.openCv(${this.jsArg('cv/master-cv.md')},null,null)">master-cv.md</button>
          <div class="label">applications</div>${appBtns}
        </aside>
        <section class="cv-editor-panel">
          <div class="label"><span id="cv-editing">select a file</span> <span id="cv-dirty" style="color:var(--warn)"></span></div>
          <textarea id="cv-text" class="cv-source" oninput="Scout.cvState.dirty=true;document.getElementById('cv-dirty').textContent='unsaved'"></textarea>
           <div class="controls" style="flex-wrap:wrap;margin-top:6px">
             <button class="act" onclick="Scout.saveCv()">save + render</button>
             <button class="act" onclick="Scout.downloadCv()">download PDF</button>
           </div>
           <div id="cv-quality" class="cv-quality"><div class="meta">Select a tailored CV to see its quality review.</div></div>
          <div class="cv-chat-request">
            <div class="label">request changes through the job chat</div>
            <div class="meta">This opens the same job-specific Codex or Claude conversation used to create the CV. Your request is placed in the message box for review; nothing is sent until you press Send in the chat drawer.</div>
            <div class="cv-chat-request-row">
              <input id="cv-instruction" class="act" placeholder="e.g. lead with the drone/UAV angle and mention the composites oven rig">
              <button class="act bridge" onclick="Scout.openChatForCv()">open job chat with request</button>
            </div>
          </div>
        </section>
        <section class="cv-preview-panel">
          <div class="cv-preview-toolbar">
            <div class="label" style="margin:0">PDF preview</div>
            <label class="meta">scale
              <select id="cv-preview-zoom" class="act" onchange="Scout.setCvZoom(this.value)">
                <option value="page-width" selected>fit width</option>
                <option value="page-fit">fit page</option>
                <option value="100">100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
              </select>
            </label>
            <button class="act" onclick="Scout.fullscreenCv()">full screen</button>
            <button class="act" onclick="Scout.openCvPdf()">open PDF</button>
          </div>
          <div id="cv-preview-shell">
            <div id="cv-preview">Select a tailored CV to render its PDF.</div>
          </div>
        </section>
      </div>`;
  },

  opportunityIdForSlug(slug) {
    const matches = (this.state.data?.opportunities || [])
      .filter((entry) => this.slugOf(entry.company) === slug);
    return matches.length === 1 ? matches[0].id : null;
  },

  async openCv(pathRel, slug, opportunityId = null) {
    if (this.cvState.dirty && !confirm('Discard unsaved changes?')) return;
    this.cvState = { path: pathRel, slug, opportunityId, dirty: false };
    const text = await this.api(`/api/cv/file?path=${encodeURIComponent(pathRel)}`);
    document.getElementById('cv-text').value = typeof text === 'string' ? text : (text.error || '');
    document.getElementById('cv-editing').textContent = `editing: ${pathRel}`;
    document.getElementById('cv-dirty').textContent = '';
    document.querySelectorAll('[data-cv-path]').forEach((b) =>
      b.classList.toggle('active', b.dataset.cvPath === pathRel));
    if (slug) await this.renderCvPreview(slug);
    else document.getElementById('cv-preview').textContent = 'No PDF preview for this file.';
  },

  async saveCv() {
    if (!this.cvState.path) return alert('Open a file first.');
    const content = document.getElementById('cv-text').value;
    const save = await this.post('/api/cv/save', { path: this.cvState.path, content });
    if (!(save && save.ok)) return;
    this.cvState.dirty = false;
    document.getElementById('cv-dirty').textContent = '';
    if (!this.cvState.slug) return;
    await this.renderCvPreview(this.cvState.slug);
  },

  async renderCvPreview(slug) {
    const preview = document.getElementById('cv-preview');
    if (!preview) return;
    preview.innerHTML = '<div class="cv-preview-status">rendering PDF...</div>';
    try {
      const rendered = await this.api('/api/cv/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      if (rendered.ok) this.showPdf(slug);
      else preview.innerHTML = `<div class="cv-preview-error">Render failed:\n${this.esc(rendered.stderr || rendered.stdout || 'unknown error')}</div>`;
    } catch (e) {
      preview.innerHTML = `<div class="cv-preview-error">Preview could not load: ${this.esc(e.message)}</div>`;
    }
    await this.refreshCvQuality(slug);
  },

  async refreshCvQuality(slug) {
    const panel = document.getElementById('cv-quality');
    if (!panel || !slug) return;
    let quality;
    try { quality = await this.api(`/api/cv/quality?slug=${encodeURIComponent(slug)}`); }
    catch (e) { quality = { status: 'invalid', error: e.message }; }
    if (quality.error) {
      panel.className = 'cv-quality invalid';
      panel.innerHTML = `<b>Quality review unavailable</b><div class="meta">${this.esc(quality.error)}</div>`;
      return;
    }
    const status = quality.status || (quality.pass ? 'ready' : 'draft');
    const issues = [...(quality.blocking || []), ...(quality.warnings || [])];
    const optionText = quality.options
      ? `XYZ ${quality.options.xyz ? 'on' : 'off'} · natural voice ${quality.options.humanize ? 'on' : 'off'}`
      : 'Legacy CV · review options were not recorded';
    panel.className = `cv-quality ${this.esc(status)}`;
    panel.innerHTML = `<div class="label">CV quality</div><b>${this.esc(status === 'ready' ? 'Ready' : status === 'overridden' ? 'Draft accepted' : 'Draft')}</b>
      <div class="meta">${this.esc(optionText)}</div>
      ${issues.length ? `<ul>${issues.map((entry) => `<li>${this.esc(entry.message)}</li>`).join('')}</ul>` : '<div class="meta">All enabled checks passed.</div>'}
      <div class="controls" style="flex-wrap:wrap;margin-top:8px">
        <button class="act" onclick="Scout.runCvQualityReview()">run quality review</button>
        ${this.cvState.opportunityId ? '<button class="act bridge" onclick="Scout.reviewEvidenceForMaster()">review answers for master CV</button>' : ''}
      </div>`;
    this.cvState.quality = quality;
  },

  async runCvQualityReview() {
    if (!this.cvState.slug) return alert('Open a tailored CV first.');
    const result = await this.api('/api/cv/quality', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: this.cvState.slug }),
    });
    if (result.error) alert(`Quality review failed: ${result.error}`);
    await this.refreshCvQuality(this.cvState.slug);
  },

  reviewEvidenceForMaster() {
    if (!this.cvState.opportunityId) return alert('Open this CV from its opportunity card first.');
    this.openChat(this.cvState.opportunityId, 'reuseEvidence');
  },

  showPdf(slug) {
    const url = `/api/cv/pdf?slug=${encodeURIComponent(slug)}&t=${Date.now()}#zoom=${encodeURIComponent(this.cvPreviewZoom)}`;
    document.getElementById('cv-preview').innerHTML =
      `<iframe class="cv-preview-frame" title="CV PDF preview" src="${url}"></iframe>`;
  },

  setCvZoom(zoom) {
    this.cvPreviewZoom = zoom;
    if (this.cvState.slug) this.showPdf(this.cvState.slug);
  },

  async fullscreenCv() {
    const shell = document.getElementById('cv-preview-shell');
    if (!shell) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch (e) {
      alert(`Full screen is unavailable: ${e.message}`);
    }
  },

  openCvPdf() {
    if (!this.cvState.slug) return alert('Open a tailored CV first.');
    const url = `/api/cv/pdf?slug=${encodeURIComponent(this.cvState.slug)}&t=${Date.now()}#zoom=${encodeURIComponent(this.cvPreviewZoom)}`;
    window.open(url, '_blank', 'noopener');
  },

  async downloadCv() {
    if (!this.cvState.slug) return alert('Open a tailored (application) CV, then save + render first.');
    let quality = await this.api(`/api/cv/quality?slug=${encodeURIComponent(this.cvState.slug)}`);
    if (quality.error) return alert(`Could not check CV quality: ${quality.error}`);
    if (!['ready', 'overridden'].includes(quality.status)) {
      if ((quality.blocking || []).length) return alert(`This CV cannot be downloaded yet:\n\n${quality.blocking.map((entry) => entry.message).join('\n')}`);
      if (!confirm('This CV is still labelled Draft. Use this draft anyway?')) return;
      const cvSha256 = quality.currentCvSha256 || quality.cvSha256;
      quality = await this.api('/api/cv/quality/override', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: this.cvState.slug, cvSha256 }),
      });
      if (quality.error) return alert(`Could not accept this draft: ${quality.error}`);
      await this.refreshCvQuality(this.cvState.slug);
    }
    const a = document.createElement('a');
    a.href = `/api/cv/pdf?slug=${encodeURIComponent(this.cvState.slug)}&download=1&t=${Date.now()}`;
    a.download = `${this.cvState.slug}-cv.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  // --- Embedded chat drawer ---

  async openChat(id, prefillKey = 'ask', cvOptions = null) {
    const previous = this.chat;
    if (previous && previous.streaming) {
      if (previous.id === id) {
        document.getElementById('chat-drawer').classList.remove('hidden');
        return;
      }
      if (!confirm('Another job has a turn running - stop it and switch chats?')) return;
      if (!await this.stopChat(previous)) return;
    }
    if (previous?.pollTimer) clearTimeout(previous.pollTimer);
    const openSeq = ++this.chatOpenSeq;
    let r;
    const optionQuery = cvOptions
      ? `&xyz=${cvOptions.xyz ? '1' : '0'}&humanize=${cvOptions.humanize ? '1' : '0'}`
      : '';
    try { r = await this.api(`/api/chat?id=${encodeURIComponent(id)}${optionQuery}`); }
    catch (e) {
      if (openSeq === this.chatOpenSeq) alert(`Could not open chat: ${e.message}`);
      return;
    }
    if (openSeq !== this.chatOpenSeq) return;
    if (r && r.error) return alert(r.error);
    const c = {
      id,
      data: r.chat || { engine: null, cliSessionId: null, messages: [], filesTouched: [] },
      engine: r.chat ? r.chat.engine : null,
      prefills: r.prefills || {},
      streaming: !!r.busy,
      recovering: !!r.busy,
      pollTimer: null,
      mode: prefillKey === 'fit' ? 'fit-assessment' : null,
    };
    this.chat = c;
    this.renderChatDrawer();
    let prefill = c.prefills[prefillKey] || '';
    if (prefillKey === 'tweak') {
      const instr = (document.getElementById('cv-instruction')?.value || '').trim();
      if (instr) prefill = prefill.replace('<your change>', instr);
    }
    document.getElementById('chat-input').value = prefill;
    this.refreshUsage(c);
    if (c.recovering) this.scheduleChatRecovery(c);
  },

  scheduleChatRecovery(c) {
    if (this.chat !== c || !c.recovering) return;
    if (c.pollTimer) clearTimeout(c.pollTimer);
    c.pollTimer = setTimeout(() => this.pollBusyChat(c), 1000);
  },

  async pollBusyChat(c) {
    if (this.chat !== c || !c.recovering) return;
    c.pollTimer = null;
    let r;
    try { r = await this.api(`/api/chat?id=${encodeURIComponent(c.id)}`); }
    catch {
      this.scheduleChatRecovery(c);
      return;
    }
    if (this.chat !== c || !c.recovering) return;
    if (!r || r.error || r.busy) {
      this.scheduleChatRecovery(c);
      return;
    }
    const draft = document.getElementById('chat-input')?.value || '';
    const following = this.chatNearBottom(document.getElementById('chat-body'));
    const previousScrollTop = document.getElementById('chat-body')?.scrollTop || 0;
    c.data = r.chat || c.data;
    c.engine = r.chat ? r.chat.engine : c.engine;
    c.prefills = r.prefills || c.prefills;
    c.streaming = false;
    c.recovering = false;
    this.renderChatDrawer();
    const input = document.getElementById('chat-input');
    if (input) input.value = draft;
    if (!following) document.getElementById('chat-body').scrollTop = previousScrollTop;
    this.refreshUsage(c);
  },

  renderChatDrawer() {
    const d = document.getElementById('chat-drawer');
    const c = this.chat;
    if (!c) return d.classList.add('hidden');
    d.classList.remove('hidden');
    const picker = this.chatPickerHtml();
    d.innerHTML = `
      <div class="chat-head">
        <b>${this.esc(this.company(c.id))}</b>
        ${c.engine ? `<span class="chip" style="margin-left:0">${this.esc(c.engine)}</span>` : ''}
        <span id="usage-meters" class="meta"></span>
        ${c.engine && c.data.cliSessionId
          ? '<button class="act" onclick="Scout.handoffChat()">summarise &amp; switch</button>'
          : ''}
        <button class="act" style="margin-left:auto" onclick="Scout.closeChat()">close</button>
      </div>
      <div class="chat-companion">${scoutMarkup(c.streaming ? 'thinking' : 'listening')}<div class="scout-bubble tail-left"><span id="scout-chat-status">${c.streaming ? 'I’m thinking…' : 'Ask me anything about this opportunity.'}</span></div></div>
      <div id="chat-body" class="chat-body">${c.engine ? '' : picker}</div>
      <div class="chat-foot" ${c.engine ? '' : 'style="display:none"'}>
        <textarea id="chat-input" placeholder="message ${this.esc(c.engine || '')} - Enter sends, Shift+Enter for a new line" onkeydown="Scout.chatKey(event)"></textarea>
        <button class="act" id="chat-send" onclick="Scout.sendChat()">send</button>
        <button class="act" id="chat-stop" style="display:none" onclick="Scout.stopChat()">stop</button>
      </div>`;
    this.renderChatMessages();
    this.setChatBusy(c.streaming);
    applyScoutState(d.querySelector('.scout-character'), c.streaming ? 'thinking' : 'listening', { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    this.initScoutSprites(d);
  },

  initScoutSprites(container = document) {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.querySelectorAll('.scout-character').forEach((element) => {
      applyScoutState(element, element.dataset.scoutState || 'idle', { reducedMotion });
    });
  },

  chatPickerHtml() {
    const onboarding = this.chat?.id === 'setup-onboarding';
    return `<div class="chat-picker">
      <div class="label">choose an engine for ${onboarding ? 'setup' : 'this job'}</div>
      <button class="act" onclick="Scout.pickEngine('claude')">Claude</button>
      <button class="act" onclick="Scout.pickEngine('codex')">Codex</button>
    </div>`;
  },

  chatBubble(role, text) {
    const avatar = role === 'assistant' ? scoutMarkup('explaining', 'scout-chat-avatar') : '';
    return `<div class="chat-row ${this.esc(role)}">${avatar}<div class="chat-msg ${this.esc(role)}">${this.esc(text)}</div></div>`;
  },

  setChatScoutState(state, message) {
    const el = document.querySelector('#chat-drawer .scout-character');
    if (el) applyScoutState(el, state, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    const status = document.getElementById('scout-chat-status');
    if (status && message) status.textContent = message;
  },

  renderChatMessages() {
    const body = document.getElementById('chat-body');
    if (!body || !this.chat) return;
    body.innerHTML = this.chat.data.messages.map((m) => this.chatBubble(m.role, m.text)).join('')
      + this.cvLinkHtml()
      + (this.chat.engine ? '' : this.chatPickerHtml());
    body.scrollTop = body.scrollHeight;
  },

  chatNearBottom(body, threshold = 80) {
    return !body || body.scrollHeight - body.scrollTop - body.clientHeight <= threshold;
  },

  scrollChatIfFollowing(body, following) {
    if (body && following) body.scrollTop = body.scrollHeight;
  },

  cvLinkHtml() {
    if (this.chat?.id === 'setup-onboarding') return '';
    const slug = this.slugOf(this.company(this.chat.id));
    return (this.chat.data.filesTouched || []).includes(`applications/${slug}/cv.typ`)
      ? `<div class="chat-msg system"><a href="#" onclick="event.preventDefault();Scout.seeCv(${this.jsArg(slug)},${this.jsArg(this.chat.id)})">view rendered CV</a></div>`
      : '';
  },

  pickEngine(engine) {
    const val = document.getElementById('chat-input').value;
    this.chat.engine = engine;
    this.renderChatDrawer();
    document.getElementById('chat-input').value = val;
  },

  chatKey(ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.sendChat();
    }
  },

  setChatBusy(busy) {
    const send = document.getElementById('chat-send');
    const stop = document.getElementById('chat-stop');
    if (send) send.style.display = busy ? 'none' : '';
    if (stop) stop.style.display = busy ? '' : 'none';
  },

  async readSse(response, onEvent) {
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  },

  async sendChat() {
    const c = this.chat;
    if (!c || c.streaming) return;
    if (!c.engine) return alert('Pick an engine first.');
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    c.streaming = true;
    this.setChatScoutState('thinking', 'I’m thinking…');
    input.value = '';
    this.setChatBusy(true);
    const body = document.getElementById('chat-body');
    body.insertAdjacentHTML('beforeend', this.chatBubble('user', text));
    body.insertAdjacentHTML('beforeend', `<div class="chat-row assistant">${scoutMarkup('explaining', 'scout-chat-avatar')}<div class="chat-msg assistant" id="chat-live">&hellip;</div></div>`);
    this.initScoutSprites(body);
    body.scrollTop = body.scrollHeight;
    let live = '';
    const startedWithoutSession = !c.data.cliSessionId;
    let terminalError = null;
    try {
      const resp = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: c.id, engine: c.engine, text, mode: c.mode }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (!resp.ok || !ct.includes('event-stream')) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `request failed (${resp.status})`);
      }
      await this.readSse(resp, (event, data) => {
        const active = this.chat === c && document.getElementById('chat-body') === body;
        const following = active && this.chatNearBottom(body);
        const liveEl = active ? body.querySelector('#chat-live') : null;
        if (event === 'delta' && liveEl) {
          this.setChatScoutState('explaining', 'I’m putting the answer together…');
          live += (live ? '\n\n' : '') + data.text;
          liveEl.textContent = live;
        }
        if (event === 'tool' && liveEl) {
          const state = activityState(data.activity || data.label);
          this.setChatScoutState(state, state === 'searching' ? 'I’m checking the advert…' : state === 'writing' ? 'I’m updating your files…' : 'I’m working on it…');
          liveEl.insertAdjacentHTML('beforebegin', `<div class="chat-msg tool">${this.esc(data.label)}</div>`);
        }
        if (event === 'done') {
          this.setChatScoutState('success', 'Done. Have a look.');
          c.data.messages.push({ role: 'user', text }, { role: 'assistant', text: data.text });
          c.data.cliSessionId = data.sessionId;
          if (data.filesTouched) c.data.filesTouched = data.filesTouched;
        }
        if (event === 'error') {
          this.setChatScoutState('warning', 'I hit a problem, but your completed work is safe.');
          terminalError = data.message;
          c.data.messages.push({ role: 'user', text }, { role: 'system', text: data.message });
          if (data.sessionId) c.data.cliSessionId = data.sessionId;
          if (data.filesTouched) c.data.filesTouched = data.filesTouched;
        }
        this.scrollChatIfFollowing(body, following);
      });
    } catch (e) {
      this.setChatScoutState('warning', 'I couldn’t complete that turn.');
      terminalError = e.message;
      c.data.messages.push({ role: 'user', text }, { role: 'system', text: e.message });
    }
    c.streaming = false;
    c.mode = null;
    if (this.chat !== c) return;
    if (terminalError && startedWithoutSession) {
      const message = terminalError;
      await this.openChat(c.id, 'ask');
      if (this.chat?.id === c.id
          && !this.chat.data.messages.some((m) => m.role === 'system' && m.text === message)) {
        this.chat.data.messages.push({ role: 'system', text: message });
        this.renderChatDrawer();
      }
      return;
    }
    const draft = document.getElementById('chat-input')?.value || '';
    const following = this.chatNearBottom(body);
    const previousScrollTop = body.scrollTop;
    this.renderChatDrawer();
    document.getElementById('chat-input').value = draft;
    if (!following) document.getElementById('chat-body').scrollTop = previousScrollTop;
    this.refreshUsage(c);
  },

  async stopChat(target = this.chat) {
    if (!target) return false;
    try {
      const response = await fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      return true;
    } catch (e) {
      if (this.chat === target) {
        const body = document.getElementById('chat-body');
        if (body) body.insertAdjacentHTML('beforeend', this.chatBubble('system', `Could not stop: ${e.message}`));
      }
      return false;
    }
  },

  async closeChat() {
    if (this.chat && this.chat.streaming) {
      if (!confirm('A turn is still running - close and stop it?')) return;
      if (!await this.stopChat(this.chat)) return;
    }
    if (this.chat?.pollTimer) clearTimeout(this.chat.pollTimer);
    this.chatOpenSeq += 1;
    this.chat = null;
    document.getElementById('chat-drawer').classList.add('hidden');
  },

  async refreshUsage(target = this.chat) {
    if (!target) return;
    let u;
    try { u = await this.api('/api/usage'); } catch { return; }
    if (this.chat !== target) return;
    const el = document.getElementById('usage-meters');
    if (!el) return;
    const bits = [];
    if (u.claude && !u.claude.unknown) {
      bits.push(`claude ~${Math.round(u.claude.fiveHourTokens / 1000)}k/5h ~${Math.round(u.claude.weekTokens / 1000)}k/wk`);
    } else bits.push('claude ?');
    if (u.codex && !u.codex.unknown && u.codex.primary) {
      const wk = u.codex.secondary ? ` ${Math.round(u.codex.secondary.usedPercent)}%/wk` : '';
      bits.push(`codex ${Math.round(u.codex.primary.usedPercent)}%/5h${wk}`);
    } else bits.push('codex ?');
    el.textContent = bits.join(' · ');
    const resetBits = [];
    const resetAt = (window) => {
      if (!window || !Number.isFinite(window.resetsInSeconds)) return null;
      return new Date(Date.now() + window.resetsInSeconds * 1000).toLocaleTimeString();
    };
    const primaryReset = resetAt(u.codex?.primary);
    const secondaryReset = resetAt(u.codex?.secondary);
    if (primaryReset) resetBits.push(`codex 5h resets ${primaryReset}`);
    if (secondaryReset) resetBits.push(`codex weekly resets ${secondaryReset}`);
    const checked = u.checkedAt ? new Date(u.checkedAt).toLocaleTimeString() : 'unknown';
    el.title = ['approximate', ...resetBits, `checked ${checked}`].join(' - ');
  },

  openChatForCv() {
    if (!this.cvState.slug) return alert('Open a tailored (application) CV first.');
    if (!this.cvState.opportunityId) {
      return alert('Open this CV from its opportunity card so Scout knows which job chat it belongs to.');
    }
    this.openChat(this.cvState.opportunityId, 'tweak');
  },

  async handoffChat() {
    const c = this.chat;
    if (!c || c.streaming) return;
    const to = c.engine === 'claude' ? 'codex' : 'claude';
    if (!confirm(`Summarise this conversation and hand off to ${to}?`)) return;
    c.streaming = true;
    this.setChatBusy(true);
    const body = document.getElementById('chat-body');
    let completed = false;
    let handoffError = null;
    let handoffStateChanged = false;
    try {
      const resp = await fetch('/api/chat/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: c.id }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (!resp.ok || !ct.includes('event-stream')) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `request failed (${resp.status})`);
      }
      await this.readSse(resp, (event, data) => {
        const active = this.chat === c && document.getElementById('chat-body') === body;
        const following = active && this.chatNearBottom(body);
        if (active && (event === 'status' || event === 'error')) {
          body.insertAdjacentHTML('beforeend', this.chatBubble('system', data.message));
        }
        if (event === 'done') completed = true;
        if (event === 'error') handoffError = data.message;
        if (event === 'error' && data.engine) {
          handoffStateChanged = true;
          c.engine = data.engine;
          c.data.engine = data.engine;
          c.data.cliSessionId = data.sessionId || null;
          if (data.filesTouched) c.data.filesTouched = data.filesTouched;
          const chip = document.querySelector('#chat-drawer .chat-head .chip');
          if (active && chip) chip.textContent = data.engine;
        }
        this.scrollChatIfFollowing(body, following);
      });
    } catch (e) {
      handoffError = e.message;
      if (this.chat === c) body.insertAdjacentHTML('beforeend', this.chatBubble('system', e.message));
    }
    c.streaming = false;
    if (this.chat !== c) return;
    if (!completed) {
      if (handoffStateChanged) {
        const message = handoffError;
        await this.openChat(c.id, 'ask');
        if (message && this.chat?.id === c.id
            && !this.chat.data.messages.some((m) => m.role === 'system' && m.text === message)) {
          this.chat.data.messages.push({ role: 'system', text: message });
          this.renderChatDrawer();
        }
        return;
      }
      this.setChatBusy(false);
      return;
    }
    const following = this.chatNearBottom(body);
    const previousScrollTop = body.scrollTop;
    await this.openChat(c.id, 'ask'); // reload transcript, new engine badge, fresh composer
    if (!following && this.chat?.id === c.id) {
      document.getElementById('chat-body').scrollTop = previousScrollTop;
    }
  },

  showTab(tab) {
    this.state.tab = tab;
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    [...this.categoryIds(), 'pipeline', 'all', 'reports', 'cv'].forEach((t) =>
      document.getElementById(`tab-${t}`)?.classList.toggle('hidden', t !== tab));
    if (this.categoryIds().includes(tab)) this.renderCategory(tab);
    if (tab === 'pipeline') this.renderPipeline();
    if (tab === 'reports') this.renderReports();
    if (tab === 'cv') this.renderCv();
  },

  init() {
    document.querySelectorAll('nav button').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.id === 'scout-settings') window.ScoutSetup?.openSettings?.();
        else if (b.dataset.tab) this.showTab(b.dataset.tab);
      }));
    document.getElementById?.('scan-now')?.addEventListener('click', () => this.scanNow());
    this.loadOpportunities();
  },
};
window.Scout = Scout;
Scout.init();
