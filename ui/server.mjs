import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/mainModule.mjs';
import { triage } from './lib/derive.mjs';
import { pipeline } from './lib/pipeline.mjs';
import { listCvFiles, safeCvPath } from './lib/cv.mjs';
import { cvDownloadDecision, overrideCvQuality, readCvQuality, runCvQuality } from './lib/cvQuality.mjs';
import { scanHealthFromText } from './lib/scanHealth.mjs';
import { scheduleStatus, scheduleSummary } from './lib/scheduler.mjs';
import { loadPortals, portalSummary } from './lib/ats.mjs';
import { JOB_CATEGORIES } from './lib/filters.mjs';
import { buildSourcePayload, sourceUrlOf, SourceCache } from './lib/source.mjs';
import { detectProviders } from './lib/providers.mjs';
import { doctor } from './lib/doctor.mjs';
import { extractCvText } from './lib/cvImport.mjs';
import { setupReadiness } from './lib/setupReadiness.mjs';
import { loadDeviceSettings, pendingDeviceSections, saveDeviceSettings, setWindowsStartup } from './lib/deviceSettings.mjs';
import { checkForUpdate } from './lib/updates.mjs';
import { hostControlConfig, hostUpdate, hostWindowCommand } from './lib/hostControl.mjs';
import { completedWorkspaceSections, pendingWorkspaceSections } from './lib/setupSections.mjs';
import { loadEnv, saveEnv } from './lib/env.mjs';
import {
  loadWorkspaceConfig, resolveWorkspaceRoot, seedWorkspace, syncManagedInstructions,
  workspacePaths, writeWorkspaceConfig,
} from './lib/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = APP_ROOT; // retained for API compatibility
export const WORKSPACE_ROOT = resolveWorkspaceRoot({ appRoot: APP_ROOT });
export const PORT = Number(process.env.PORT) || 8459;
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
const WORKSPACE = workspacePaths(WORKSPACE_ROOT);
const TRACKER = WORKSPACE.tracker;
const REPORTS_DIR = WORKSPACE.reports;
const SCAN_RUNS = WORKSPACE.scanRuns;

// The dashboard requests opportunities in parallel with setup status. Seed a
// fresh workspace before accepting requests so that first launch cannot crash
// when the tracker does not exist yet.
if (!fs.existsSync(TRACKER)) seedWorkspace(APP_ROOT, WORKSPACE_ROOT);
else if (path.resolve(APP_ROOT) !== path.resolve(WORKSPACE_ROOT)) syncManagedInstructions(APP_ROOT, WORKSPACE_ROOT);

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function readTracker() {
  return JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
}

function readCategories() {
  if (!fs.existsSync(WORKSPACE.categories)) return JOB_CATEGORIES;
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE.categories, 'utf8'));
    const categories = (parsed.categories || []).map((category) => ({
      id: String(category.id || '').trim().toLowerCase(),
      label: String(category.label || category.id || '').trim(),
      description: String(category.description || '').trim(),
    })).filter((category) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(category.id) && category.label);
    return categories.length ? categories : JOB_CATEGORIES;
  } catch {
    return JOB_CATEGORIES;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, type, text) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function serveStatic(res, file, type) {
  if (!fs.existsSync(file)) return sendText(res, 404, 'text/plain', 'not built yet');
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

function reportDates() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
    .reverse();
}

function readScanHealth() {
  const text = fs.existsSync(SCAN_RUNS) ? fs.readFileSync(SCAN_RUNS, 'utf8') : '';
  return scanHealthFromText(text, today());
}

function readScheduleSummary(config = loadWorkspaceConfig(WORKSPACE_ROOT), health = readScanHealth()) {
  return scheduleSummary(config, health, scheduleStatus());
}

// Task 5 assigns handlers into this table: routes['POST /api/status'] = (req,res,body)=>{...}
export const routes = {};

function loopbackHost(hostHeader) {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function guardLocalRequest(req, res, url) {
  const host = String(req.headers.host || '');
  if (!loopbackHost(host)) {
    sendJson(res, 403, { error: 'loopback host required' });
    return false;
  }

  const mutatingApi = url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method);
  if (!mutatingApi) return true;

  const origin = req.headers.origin;
  if (origin) {
    let parsedOrigin = null;
    try { parsedOrigin = new URL(origin); } catch { /* rejected below */ }
    if (!parsedOrigin
        || parsedOrigin.protocol !== 'http:'
        || parsedOrigin.host.toLowerCase() !== host.toLowerCase()) {
      sendJson(res, 403, { error: 'same-origin request required' });
      return false;
    }
  }

  if (url.pathname.startsWith('/api/chat/')) {
    const mediaType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      sendJson(res, 415, { error: 'application/json required' });
      return false;
    }
  }
  return true;
}

function handleRead(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    return serveStatic(res, path.join(__dirname, 'app.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/setup.js') {
    return serveStatic(res, path.join(__dirname, 'setup.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/lib/')) {
    const name = url.pathname.slice('/lib/'.length);
    if (!/^[a-zA-Z0-9.-]+\.mjs$/.test(name)) return sendJson(res, 400, { error: 'bad module path' });
    return serveStatic(res, path.join(__dirname, 'lib', name), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    return serveStatic(res, path.join(__dirname, 'assets', 'scout-icon.ico'), 'image/x-icon');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const name = url.pathname.slice('/assets/'.length);
    if (!/^[a-zA-Z0-9.-]+\.(?:png|webp|ico)$/.test(name)) return sendJson(res, 400, { error: 'bad asset path' });
    const type = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.ico') ? 'image/x-icon' : 'image/png';
    const requested = path.join(__dirname, 'assets', name);
    const fallback = path.join(__dirname, 'assets', 'scout-icon.png');
    return serveStatic(res, fs.existsSync(requested) ? requested : fallback, type);
  }
  if (req.method === 'GET' && url.pathname === '/api/setup/status') {
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    const providers = detectProviders();
    const env = loadEnv(WORKSPACE_ROOT);
    const readiness = setupReadiness(WORKSPACE_ROOT, config, providers, readTracker());
    return sendJson(res, 200, {
      workspaceRoot: WORKSPACE_ROOT,
      appRoot: APP_ROOT,
      appVersion: APP_VERSION,
      config,
      providers,
      adzunaConfigured: !!(env.ADZUNA_APP_ID && env.ADZUNA_API_KEY),
      trackerExists: fs.existsSync(TRACKER),
      established: readiness.established,
      ready: readiness.ready,
      setupComplete: Boolean(config.setup?.completedAt),
      readiness: readiness.checks,
      scanHealth: readScanHealth(),
      schedule: readScheduleSummary(config),
      doctor: doctor(WORKSPACE_ROOT),
      device: process.platform === 'win32' ? loadDeviceSettings() : null,
      pendingSetupSections: [...pendingWorkspaceSections(readiness.established ? { ...config.setup, completedAt: config.setup?.completedAt || 'legacy' } : config.setup), ...pendingDeviceSections(loadDeviceSettings())],
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/app-info') {
    return sendJson(res, 200, {
      name: 'Scout', version: APP_VERSION, appRoot: APP_ROOT, workspaceRoot: WORKSPACE_ROOT,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/opportunities') {
    const data = readTracker();
    const todayValue = today();
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    return sendJson(res, 200, {
      ...data,
      triage: triage(data, todayValue, config.triage),
      pipeline: pipeline(data, todayValue, config.triage),
      scanHealth: readScanHealth(),
      schedule: readScheduleSummary(config),
      categories: readCategories(),
      workspaceConfig: config,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/pipeline') {
    const data = readTracker();
    return sendJson(res, 200, pipeline(data, today(), loadWorkspaceConfig(WORKSPACE_ROOT).triage));
  }
  if (req.method === 'GET' && url.pathname === '/api/scan-health') {
    return sendJson(res, 200, readScanHealth());
  }
  if (req.method === 'GET' && url.pathname === '/api/ats-portals') {
    return sendJson(res, 200, { portals: portalSummary(loadPortals(WORKSPACE_ROOT)) });
  }
  if (req.method === 'GET' && url.pathname === '/api/reports') {
    return sendJson(res, 200, { reports: reportDates() });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
    const date = url.pathname.slice('/api/reports/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'bad date' });
    const file = path.join(REPORTS_DIR, `${date}.md`);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no report' });
    return sendText(res, 200, 'text/markdown; charset=utf-8', fs.readFileSync(file, 'utf8'));
  }
  if (req.method === 'GET' && url.pathname === '/api/cv') {
    return sendJson(res, 200, listCvFiles(WORKSPACE_ROOT));
  }
  if (req.method === 'GET' && url.pathname === '/api/cv/file') {
    try {
      const abs = safeCvPath(WORKSPACE_ROOT, url.searchParams.get('path'));
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: 'no such file' });
      return sendText(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(abs, 'utf8'));
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/cv/quality') {
    try { return sendJson(res, 200, readCvQuality(WORKSPACE_ROOT, url.searchParams.get('slug') || '')); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/cv/pdf') {
    const slug = url.searchParams.get('slug') || '';
    if (!/^[a-z0-9-]+$/.test(slug)) return sendJson(res, 400, { error: 'bad slug' });
    const pdf = path.join(WORKSPACE_ROOT, 'applications', slug, 'cv.pdf');
    if (!fs.existsSync(pdf)) return sendJson(res, 404, { error: 'no pdf - render first' });
    if (url.searchParams.get('download') === '1') {
      let decision;
      try { decision = cvDownloadDecision(WORKSPACE_ROOT, slug); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (!decision.allowed) return sendJson(res, 409, decision);
    }
    const buf = fs.readFileSync(pdf);
    const headers = { 'Content-Type': 'application/pdf', 'Content-Length': buf.length };
    if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${slug}-cv.pdf"`;
    res.writeHead(200, headers);
    return res.end(buf);
  }
  if (req.method === 'GET' && url.pathname === '/api/source') {
    handleSource(res, url.searchParams.get('id') || '');
    return true; // async handler owns the response
  }
  return null; // not a read route
}

const sourceCache = new SourceCache();

async function handleSource(res, id) {
  let entry;
  try {
    entry = (readTracker().opportunities || []).find((o) => o.id === id);
  } catch (e) {
    return sendJson(res, 500, { error: `tracker unreadable: ${e.message}` });
  }
  if (!entry) return sendJson(res, 404, { error: 'no such opportunity' });
  const target = sourceUrlOf(entry);
  if (!target) return sendJson(res, 404, { error: 'no usable source url' });
  const cached = sourceCache.get(id);
  if (cached) return sendJson(res, 200, cached);
  let html;
  try {
    const r = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!r.ok) return sendJson(res, 502, { ok: false, error: `source returned ${r.status}` });
    html = await r.text();
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'source timed out' : `fetch failed: ${e.message}`;
    return sendJson(res, 502, { ok: false, error: msg });
  }
  const payload = buildSourcePayload(html, target, new Date().toISOString());
  sourceCache.set(id, payload);
  return sendJson(res, 200, payload);
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (!guardLocalRequest(req, res, url)) return;
    const routeKey = `${req.method} ${url.pathname}`;
    if (routes[routeKey]) {
      let body = '';
      let tooLarge = false;
      const limit = url.pathname === '/api/setup/import-cv' ? 14 * 1024 * 1024 : 1e6;
      req.on('data', (c) => {
        if (tooLarge) return;
        body += c;
        if (body.length > limit) {
          tooLarge = true;
          replyJson(res, 413, { error: 'request body too large' });
        }
      });
      req.on('end', () => { if (!tooLarge) routes[routeKey](req, res, body, url); });
      return;
    }
    const handled = handleRead(req, res, url);
    if (handled === null) sendJson(res, 404, { error: 'not found' });
  });
}

// --- Mutation wiring (Task 5) ---
import {
  setStatus, addNote, logEvent, addContact, editContact, serializeTracker, findEntry,
  markApplied, markRejected, addApplicationStage, completeApplicationStage,
  setCategory, setCommute,
} from './lib/tracker.mjs';
import { gitCommit } from './lib/git.mjs';
import { renderCv } from './lib/cv.mjs';

const TRACKER_FILE = TRACKER;

function replyJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function parseBody(body) {
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

function applyTrackerMutation(res, mutate, commitMessage) {
  let data;
  try { data = readTracker(); } catch (e) { return replyJson(res, 500, { error: `tracker unreadable: ${e.message}` }); }
  let next;
  try { next = mutate(data); } catch (e) { return replyJson(res, 400, { error: e.message }); }
  try { fs.writeFileSync(TRACKER_FILE, serializeTracker(next)); }
  catch (e) { return replyJson(res, 500, { error: `write failed: ${e.message}` }); }
  const commit = gitCommit(WORKSPACE_ROOT, [TRACKER_FILE], commitMessage);
  return replyJson(res, 200, { ok: true, committed: commit.ok, error: commit.ok ? undefined : commit.error });
}

function company(data, id) { try { return findEntry(data, id).company; } catch { return id; } }

routes['POST /api/status'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => setStatus(d, b.id, b.status),
    `ui: status ${b.status} - ${company(readTracker(), b.id)}`);
};

routes['POST /api/note'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!b.text || !b.text.trim()) return replyJson(res, 400, { error: 'note text required' });
  applyTrackerMutation(res, (d) => addNote(d, b.id, b.text.trim(), today()),
    `ui: note - ${company(readTracker(), b.id)}`);
};

routes['POST /api/log'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => logEvent(d, b.id, b.event, b.note || '', today()),
    `ui: log ${b.event} - ${company(readTracker(), b.id)}`);
};

routes['POST /api/contact'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const mutate = typeof b.index === 'number'
    ? (d) => editContact(d, b.id, b.index, b.contact || {})
    : (d) => addContact(d, b.id, b.contact || {});
  applyTrackerMutation(res, mutate, `ui: contact - ${company(readTracker(), b.id)}`);
};

routes['POST /api/category'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => setCategory(d, b.id, b.category),
    `ui: category ${b.category} - ${company(readTracker(), b.id)}`);
};

routes['POST /api/commute'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => setCommute(d, b.id, b.commute || {}, today()),
    `ui: commute - ${company(readTracker(), b.id)}`);
};

routes['POST /api/applied'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => markApplied(d, b.id, today(), b.note || ''),
    `ui: applied - ${company(readTracker(), b.id)}`);
};

routes['POST /api/rejected'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => markRejected(d, b.id, today(), b.note || ''),
    `ui: rejected - ${company(readTracker(), b.id)}`);
};

routes['POST /api/stage'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => addApplicationStage(d, b.id, b.stage || {}, today()),
    `ui: stage - ${company(readTracker(), b.id)}`);
};

routes['POST /api/stage/complete'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  applyTrackerMutation(res, (d) => completeApplicationStage(d, b.id, b.index, today()),
    `ui: complete stage - ${company(readTracker(), b.id)}`);
};

routes['POST /api/cv/save'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  let abs;
  try { abs = safeCvPath(WORKSPACE_ROOT, b.path); } catch (e) { return replyJson(res, 400, { error: e.message }); }
  if (typeof b.content !== 'string') return replyJson(res, 400, { error: 'content required' });
  try { fs.writeFileSync(abs, b.content); } catch (e) { return replyJson(res, 500, { error: e.message }); }
  const commit = gitCommit(WORKSPACE_ROOT, [abs], `ui: edit cv - ${b.path}`);
  replyJson(res, 200, { ok: true, committed: commit.ok, error: commit.ok ? undefined : commit.error });
};

routes['POST /api/cv/render'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const r = renderCv(WORKSPACE_ROOT, b.slug || '');
  replyJson(res, 200, r);
};

routes['POST /api/cv/quality'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    return replyJson(res, 200, runCvQuality(WORKSPACE_ROOT, b.slug || '', { locale: config.locale }));
  } catch (e) { return replyJson(res, 400, { error: e.message }); }
};

routes['POST /api/cv/quality/override'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try { return replyJson(res, 200, overrideCvQuality(WORKSPACE_ROOT, b.slug || '', b.cvSha256 || '')); }
  catch (e) { return replyJson(res, 409, { error: e.message }); }
};

import { registerChatRoutes } from './lib/chatService.mjs';
routes['POST /api/setup/config'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    if (!fs.existsSync(TRACKER)) seedWorkspace(APP_ROOT, WORKSPACE_ROOT);
    const current = loadWorkspaceConfig(WORKSPACE_ROOT);
    const next = {
      ...current,
      ...b,
      profile: { ...current.profile, ...(b.profile || {}) },
      search: { ...current.search, ...(b.search || {}) },
      triage: { ...current.triage, ...(b.triage || {}) },
      sources: {
        ...current.sources,
        ...(b.sources || {}),
        adzuna: { ...current.sources?.adzuna, ...(b.sources?.adzuna || {}) },
        hiringCafe: { ...current.sources?.hiringCafe, ...(b.sources?.hiringCafe || {}) },
      },
      commute: { ...current.commute, ...(b.commute || {}) },
      ai: { ...current.ai, ...(b.ai || {}) },
      schedule: { ...current.schedule, ...(b.schedule || {}) },
      setup: { ...current.setup, ...(b.setup || {}) },
    };
    writeWorkspaceConfig(WORKSPACE_ROOT, next);
    return replyJson(res, 200, { ok: true, config: next });
  } catch (e) { return replyJson(res, 400, { error: e.message }); }
};

routes['POST /api/setup/complete'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    config.setup = { ...config.setup, completedAt: new Date().toISOString(), completedSections: completedWorkspaceSections({ completedAt: new Date().toISOString() }) };
    writeWorkspaceConfig(WORKSPACE_ROOT, config);
    if (process.platform === 'win32') {
      const device = loadDeviceSettings();
      device.completedSections['windows-startup'] = 1;
      saveDeviceSettings(device);
    }
    return replyJson(res, 200, { ok: true, completedAt: config.setup.completedAt });
  } catch (e) { return replyJson(res, 400, { error: e.message }); }
};

routes['POST /api/device/settings'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const settings = loadDeviceSettings();
    if (Object.hasOwn(b, 'startWithWindows')) {
      const enabled = Boolean(b.startWithWindows);
      const host = path.resolve(APP_ROOT, '..', 'Scout.exe');
      if (!fs.existsSync(host)) return replyJson(res, 400, { error: 'Windows startup is available in the installed Scout app' });
      const result = setWindowsStartup(enabled, host);
      if (!result.ok) return replyJson(res, 400, result);
      settings.startWithWindows = enabled;
    }
    saveDeviceSettings(settings);
    return replyJson(res, 200, { ok: true, settings, pendingSetupSections: pendingDeviceSections(settings) });
  } catch (e) { return replyJson(res, 400, { error: e.message }); }
};

routes['POST /api/setup/section'] = (req, res, body) => {
  const b = parseBody(body); if (!b || b.id !== 'windows-startup') return replyJson(res, 400, { error: 'unknown setup section' });
  const settings = loadDeviceSettings();
  if (b.action === 'complete') {
    settings.completedSections[b.id] = 1;
    delete settings.deferredSections[b.id];
  } else if (b.action === 'defer') {
    settings.deferredSections[b.id] = new Date(Date.now() + 7 * 86400000).toISOString();
  } else return replyJson(res, 400, { error: 'action must be complete or defer' });
  saveDeviceSettings(settings);
  return replyJson(res, 200, { ok: true, pendingSetupSections: pendingDeviceSections(settings) });
};

let updateCheckRunning = null;
async function updateStatus(force = false) {
  // Installed Wails builds delegate update policy, verification and installation
  // to Go. Browser clients only ever see this sanitised result.
  if (hostControlConfig()) return hostUpdate('/check', { force });
  const settings = loadDeviceSettings();
  const last = new Date(settings.updates?.lastCheckedAt || 0).getTime();
  if (!force && Date.now() - last < 86400000 && settings.updates?.lastResult) return { ...settings.updates.lastResult, notify: false };
  if (!updateCheckRunning) updateCheckRunning = checkForUpdate(APP_VERSION).then((result) => {
    const notify = Boolean(result.available && (force || settings.updates?.lastNotifiedVersion !== result.latestVersion));
    settings.updates = { ...settings.updates, lastCheckedAt: new Date().toISOString(), lastResult: result, lastNotifiedVersion: notify ? result.latestVersion : settings.updates?.lastNotifiedVersion };
    saveDeviceSettings(settings); return { ...result, notify };
  }).finally(() => { updateCheckRunning = null; });
  return updateCheckRunning;
}

routes['POST /api/update/check'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try { return replyJson(res, 200, await updateStatus(Boolean(b.force))); }
  catch (e) { return replyJson(res, 503, { error: e.message, available: false, currentVersion: APP_VERSION }); }
};

// Plural routes are the stable desktop-host contract. Keep the beta.7 singular
// endpoint above for old launchers and bookmarked Settings pages.
routes['POST /api/updates/check'] = routes['POST /api/update/check'];
routes['POST /api/updates/install'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try { return replyJson(res, 200, await hostUpdate('/install', b)); }
  catch (e) { return replyJson(res, 503, { error: e.message }); }
};

// This route is only injected by the Wails host's in-dashboard quit sheet.
// Node forwards it with the private startup token; the browser never sees it.
routes['POST /api/host/quit'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    if (b.disableSchedule) {
      const result = removeSchedule();
      if (!result.ok) return replyJson(res, 500, result);
      const config = loadWorkspaceConfig(WORKSPACE_ROOT);
      config.schedule = { ...config.schedule, enabled: false };
      writeWorkspaceConfig(WORKSPACE_ROOT, config);
    }
    return replyJson(res, 202, await hostWindowCommand('/quit'));
  }
  catch (e) { return replyJson(res, 503, { error: e.message }); }
};

routes['POST /api/setup/credentials'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    saveEnv(WORKSPACE_ROOT, {
      ADZUNA_APP_ID: typeof b.appId === 'string' ? b.appId.trim() : '',
      ADZUNA_API_KEY: typeof b.apiKey === 'string' ? b.apiKey.trim() : '',
    });
    return replyJson(res, 200, { ok: true, configured: !!(b.appId && b.apiKey) });
  } catch (e) { return replyJson(res, 400, { error: e.message }); }
};

routes['POST /api/setup/import-cv'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const name = path.basename(String(b.name || ''));
  if (!name || typeof b.base64 !== 'string') return replyJson(res, 400, { error: 'name and base64 are required' });
  const encoded = b.base64.trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return replyJson(res, 400, { error: 'invalid base64' });
  }
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { return replyJson(res, 400, { error: 'invalid base64' }); }
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return replyJson(res, 400, { error: 'CV must be between 1 byte and 10 MB' });
  fs.mkdirSync(WORKSPACE.imports, { recursive: true });
  const imported = path.join(WORKSPACE.imports, name);
  fs.writeFileSync(imported, bytes);
  extractCvText(imported).then((text) => {
    const extracted = path.join(WORKSPACE.imports, `${name}.txt`);
    fs.writeFileSync(extracted, `${text}\n`, 'utf8');
    replyJson(res, 200, { ok: true, source: `imports/${name}`, extracted: `imports/${path.basename(extracted)}`, text });
  }).catch((e) => {
    fs.rmSync(imported, { force: true });
    replyJson(res, 400, { error: e.message });
  });
};

import { installSchedule, runScan } from '../tools/scout.mjs';
import { removeSchedule, runScheduledNow } from './lib/scheduler.mjs';

let supervisedScanRunning = false;
routes['POST /api/scan'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (supervisedScanRunning) return replyJson(res, 409, { error: 'a supervised scan is already running' });
  const config = loadWorkspaceConfig(WORKSPACE_ROOT);
  const provider = b.provider || config.ai?.provider;
  if (!['codex', 'claude'].includes(provider)) return replyJson(res, 400, { error: 'choose an authenticated AI provider first' });
  supervisedScanRunning = true;
  try {
    const result = await runScan(WORKSPACE_ROOT, provider, 'primary');
    return replyJson(res, result.ok ? 200 : 500, { ...result, scanHealth: readScanHealth() });
  } catch (e) { return replyJson(res, 500, { error: e.message }); }
  finally { supervisedScanRunning = false; }
};

routes['POST /api/schedule'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const config = loadWorkspaceConfig(WORKSPACE_ROOT);
  try {
    let result;
    if (b.action === 'install') {
      const health = readScanHealth();
      if (!health.lastRunAt || !health.healthy) return replyJson(res, 409, { error: 'complete a healthy supervised scan before enabling daily scans' });
      result = installSchedule(WORKSPACE_ROOT, b.time || config.schedule?.time || '07:30', b.provider || config.ai?.provider);
    } else if (b.action === 'remove') {
      result = removeSchedule();
      if (result.ok) { config.schedule = { ...config.schedule, enabled: false }; writeWorkspaceConfig(WORKSPACE_ROOT, config); }
    } else if (b.action === 'run-now') result = runScheduledNow();
    else return replyJson(res, 400, { error: 'action must be install, remove, or run-now' });
    return replyJson(res, result.ok ? 200 : 500, result);
  } catch (e) { return replyJson(res, 400, { error: e.message }); }
};

// Restart: reply first, then hand the port to a fresh detached copy of this
// server. The new process retries binding until the old one has exited.
// Injectable so tests can hit the route without killing the test runner.
export const restartControl = {
  respawn() {
    spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: APP_ROOT, detached: true, stdio: 'ignore', env: process.env,
    }).unref();
    setTimeout(() => process.exit(0), 300);
  },
};

routes['POST /api/restart'] = (req, res) => {
  replyJson(res, 200, { ok: true, restarting: true });
  setTimeout(() => restartControl.respawn(), 200);
};

registerChatRoutes({ routes, repoRoot: WORKSPACE_ROOT, readTracker });

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const server = createServer();
  let bindRetries = 0;
  server.on('error', (err) => {
    // After /api/restart the previous process may hold the port briefly.
    if (err.code === 'EADDRINUSE' && bindRetries++ < 40) {
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
    } else {
      throw err;
    }
  });
  server.on('listening', () => {
    console.log(`Scout UI on http://127.0.0.1:${PORT}`);
  });
  server.listen(PORT, '127.0.0.1');
}
