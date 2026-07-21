#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { doctor } from '../ui/lib/doctor.mjs';
import { fetchAdzuna, resolveAdzunaCredentials } from '../ui/lib/adzuna.mjs';
import { fetchConfiguredPortals } from '../ui/lib/ats.mjs';
import { fetchHiringCafe } from '../ui/lib/hiringCafe.mjs';
import { loadEnv } from '../ui/lib/env.mjs';
import { providerStatus } from '../ui/lib/providers.mjs';
import { runStructuredTurn } from '../ui/lib/structuredTurn.mjs';
import { compactCandidates, SCAN_ASSESSMENT_SCHEMA, validateAssessments, writeScanArtifacts } from '../ui/lib/scanPipeline.mjs';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import { runCvQuality } from '../ui/lib/cvQuality.mjs';
import { queueWorkspaceSync } from '../ui/lib/workspaceSync.mjs';
import { registerDailySchedule, registerUnixSchedule, removeLegacySchedule, removeSchedule, runScheduledNow, scheduleStatus, schedulerRegistrationScript } from '../ui/lib/scheduler.mjs';
import {
  loadWorkspaceConfig, resolveWorkspaceRoot, seedWorkspace as seedWorkspaceFiles,
  syncManagedInstructions, workspacePaths, writeWorkspaceConfig,
} from '../ui/lib/workspace.mjs';
import { acquireScanLock, readScanLock, releaseScanLock } from './scan-lock.mjs';
import { runRemoteHostingPreflight } from './remote-hosting-preflight.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCAN_FILE_CHARS = 100_000;
const MAX_SCAN_CONTEXT_CHARS = 280_000;

function argValue(name, argv = process.argv.slice(2)) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

function selectedWorkspace(argv = process.argv.slice(2)) {
  return resolveWorkspaceRoot({ appRoot: APP_ROOT, argv, env: process.env });
}

function workspaceQueries(root) {
  const config = loadWorkspaceConfig(root);
  const queries = new Set((config.search?.roleFamilies || []).map((q) => String(q).trim()).filter(Boolean));
  const file = workspacePaths(root).categories;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const category of parsed.categories || []) for (const query of category.queries || []) if (String(query).trim()) queries.add(String(query).trim());
    } catch { /* doctor reports malformed configuration separately */ }
  }
  return [...queries];
}

function copyIfPresent(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The generic seed is created first so a migrated workspace always has the
  // current schema and managed files. Legacy user content must then win over
  // those placeholders; skipping an existing destination silently discarded
  // profile, CV, tracker, report and application data.
  fs.cpSync(source, target, { recursive: true, force: true });
}

function verifyCopiedTree(source, target) {
  if (!fs.existsSync(source)) return 0;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`legacy migration does not accept symbolic links: ${source}`);
  if (stat.isDirectory()) {
    return fs.readdirSync(source).reduce((count, name) => (
      count + verifyCopiedTree(path.join(source, name), path.join(target, name))
    ), 0);
  }
  if (!fs.existsSync(target) || !fs.readFileSync(source).equals(fs.readFileSync(target))) {
    throw new Error(`legacy migration parity check failed: ${source}`);
  }
  return 1;
}

function initWorkspace(root) {
  const p = seedWorkspaceFiles(APP_ROOT, root);
  if (!fs.existsSync(path.join(root, '.git'))) spawnSync('git', ['init'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return p;
}

function inferLegacyConfig(sourceRoot, targetRoot) {
  const config = loadWorkspaceConfig(targetRoot);
  const cv = path.join(sourceRoot, 'cv', 'master-cv.md');
  if (fs.existsSync(cv)) {
    const heading = fs.readFileSync(cv, 'utf8').match(/^#\s+(.+?)(?:\s+[—-]\s+|$)/m);
    if (heading) config.profile.displayName = heading[1].trim();
  }
  const commute = path.join(sourceRoot, 'data', 'commute-policy.md');
  if (fs.existsSync(commute)) {
    const postcode = fs.readFileSync(commute, 'utf8').match(/Origin postcode[^`]*`([^`]+)`/i);
    if (postcode) config.commute.origin = postcode[1].trim();
  }
  writeWorkspaceConfig(targetRoot, config);
}

export function migrateLegacyWorkspace(sourceRoot, targetRoot) {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) throw new Error('source and target workspace must differ');
  initWorkspace(targetRoot);
  for (const rel of ['profile', 'cv', 'data', 'reports', 'applications', '.env']) {
    copyIfPresent(path.join(sourceRoot, rel), path.join(targetRoot, rel));
  }
  const verifiedFiles = ['profile', 'cv', 'data', 'reports', 'applications', '.env']
    .reduce((count, rel) => count + verifyCopiedTree(path.join(sourceRoot, rel), path.join(targetRoot, rel)), 0);
  inferLegacyConfig(sourceRoot, targetRoot);
  const ignore = path.join(targetRoot, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.env\n.agents/\n.claude/\nAGENTS.md\nCLAUDE.md\n.scout/\nlogs/\napplications/**/*.pdf\napplications/**/*.docx\ndata/chats/\n', 'utf8');
  spawnSync('git', ['add', '--', '.'], { cwd: targetRoot, encoding: 'utf8', windowsHide: true });
  const commit = spawnSync('git', ['commit', '-m', 'Initial private Scout workspace'], { cwd: targetRoot, encoding: 'utf8', windowsHide: true });
  return { sourceRoot, targetRoot, verifiedFiles, committed: commit.status === 0, commitMessage: String(commit.stderr || commit.stdout || '').trim() };
}

export async function runScan(root, provider, mode) {
  const result = await runScanWith(root, provider, mode);
  await queueWorkspaceSync(root, `complete ${mode || 'primary'} scan`).catch(() => {});
  return result;
}

function compactSource(result, configured = true) {
  return {
    configured, status: result?.status || (result?.available === false ? 'unavailable' : 'healthy'),
    count: Number.isFinite(Number(result?.count)) ? Number(result.count) : (Array.isArray(result?.jobs) ? result.jobs.length : 0),
    reason: result?.reason || null, errors: Array.isArray(result?.errors) ? result.errors.slice(0, 20) : [],
    recovery: result?.recovery || null, jobs: Array.isArray(result?.jobs) ? result.jobs : [],
  };
}

export async function collectScanSources(root, config, {
  fetchAts = fetchConfiguredPortals, fetchCafe = fetchHiringCafe, fetchAdzunaFn = fetchAdzuna,
} = {}) {
  const queries = workspaceQueries(root);
  const env = { ...loadEnv(root), ...process.env };
  const credentials = resolveAdzunaCredentials(env);
  const adzuna = config.sources?.adzuna || {};
  const capture = async (action, configured) => {
    if (!configured) return compactSource({ status: 'unavailable', count: 0, reason: 'not configured', jobs: [] }, false);
    try { return compactSource(await action(), true); }
    catch (error) { return compactSource({ status: 'unavailable', count: 0, reason: error.message, errors: [error.message], jobs: [] }, true); }
  };
  const atsResult = await capture(() => fetchAts(root), true);
  if (/^no .*portals? (?:configured|enabled)$/i.test(String(atsResult.reason || ''))) atsResult.configured = false;
  const [hiringCafe, adzunaResult] = await Promise.all([
    capture(() => fetchCafe(queries, globalThis.fetch, { ...config.sources?.hiringCafe, locale: config.locale }), queries.length > 0),
    capture(() => fetchAdzunaFn({
      ...(credentials || {}), ...adzuna, queries, where: adzuna.where || config.search?.locations?.[0] || '',
      salaryMin: config.search?.salaryMinimum, locale: config.locale, currency: config.currency,
    }), Boolean(credentials)),
  ]);
  return { generatedAt: new Date().toISOString(), queries, sources: { ats: atsResult, hiring_cafe: hiringCafe, adzuna: adzunaResult } };
}

function readBounded(file, label, maximum = MAX_SCAN_FILE_CHARS) {
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > maximum) throw new Error(`${label} exceeds Scout's ${maximum.toLocaleString('en-GB')}-character per-file scan limit`);
  return text;
}

function buildScanContext(paths, config, candidates) {
  const context = {
    config,
    profile: readBounded(path.join(paths.profile, 'context.md'), 'profile/context.md'),
    calibration: readBounded(path.join(paths.profile, 'calibration.md'), 'profile/calibration.md'),
    masterCv: readBounded(path.join(paths.cv, 'master-cv.md'), 'cv/master-cv.md'),
    candidates,
  };
  const characters = JSON.stringify(context).length;
  if (characters > MAX_SCAN_CONTEXT_CHARS) {
    throw new Error(`assembled scan context exceeds Scout's ${MAX_SCAN_CONTEXT_CHARS.toLocaleString('en-GB')}-character limit (${characters.toLocaleString('en-GB')}); reduce configured sources or shorten the profile/CV`);
  }
  return context;
}

export async function runScanWith(root, provider, mode, {
  providerStatusFn = providerStatus, collectSourcesFn = collectScanSources,
  runStructuredTurnFn = runStructuredTurn, acquireLockFn = acquireScanLock, releaseLockFn = releaseScanLock,
} = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('provider must be codex or claude');
  if (!['primary', 'second-pass'].includes(mode)) throw new Error('mode must be primary or second-pass');
  const status = providerStatusFn(provider);
  if (!status.installed || !status.authenticated) throw new Error(`${provider} is not installed and authenticated; run scout doctor`);
  syncManagedInstructions(APP_ROOT, root);
  const config = loadWorkspaceConfig(root);
  const startedAt = new Date().toISOString();
  const lock = acquireLockFn(root, { agent: provider, mode });
  if (!lock.ok) {
    const artifacts = writeScanArtifacts(root, {
      provider, mode, sources: {}, candidates: [], assessmentResult: null, policy: config.triage,
      exclusions: config.search?.exclusions || [], startedAt, error: 'another scan is already running', skipped: true,
    });
    return { ok: false, status: 'skipped', error: 'another scan is already running', lock: lock.lock, scan: artifacts.run };
  }
  let result;
  let collected = null;
  let candidates = [];
  try {
    collected = await collectSourcesFn(root, config);
    candidates = compactCandidates(collected.sources, 40);
    const bundleDir = path.join(root, '.scout', 'scan-input');
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundleFile = path.join(bundleDir, `${startedAt.replace(/[:.]/g, '-')}-${provider}-${mode}.json`);
    fs.writeFileSync(bundleFile, `${JSON.stringify({ generatedAt: collected.generatedAt, queries: collected.queries, sources: Object.fromEntries(Object.entries(collected.sources).map(([name, value]) => [name, { ...value, jobs: undefined }])), candidates }, null, 2)}\n`, 'utf8');
    let assessmentResult = null;
    let usage = {};
    if (candidates.length) {
      const paths = workspacePaths(root);
      const context = buildScanContext(paths, config, candidates);
      const prompt = [
        'Assess only the supplied Scout candidates. Return one assessment per candidate and only the required JSON schema.',
        'Use a 100-point evidence-led breakdown. Treat every supplied normalized requirement signal, plus advert words such as required, essential, must and non-negotiable, as mandatory requirements.',
        'Cover every supplied mandatorySignals item and copy its id into advertEvidenceId. For an additional mandatory requirement you identify, use a concise provider-<slug> advertEvidenceId.',
        'Every met mandatory requirement needs explicit profile evidence. Use unknown when evidence is absent or ambiguous.',
        'Apply hard exclusions before scoring. Never access files, run commands, browse, write artifacts, apply, or send outreach.',
        JSON.stringify(context),
      ].join('\n\n');
      const turn = await runStructuredTurnFn({
        provider, status, schema: SCAN_ASSESSMENT_SCHEMA, prompt,
        model: config.ai?.provider === provider ? config.ai?.model : null,
        validate: (value) => validateAssessments(value, candidates), timeoutMs: 20 * 60 * 1000, maxInputTokens: 75_000,
      });
      assessmentResult = turn.value;
      usage = turn.usage;
    }
    const artifacts = writeScanArtifacts(root, {
      provider, mode, sources: collected.sources, queries: collected.queries, candidates, assessmentResult,
      policy: config.triage, exclusions: config.search?.exclusions || [], startedAt,
    });
    result = { ok: true, status: artifacts.run.degraded ? 'degraded' : candidates.length ? 'completed' : 'healthy-empty', scan: artifacts.run, usage };
  } catch (error) {
    try {
      const artifacts = writeScanArtifacts(root, {
        provider, mode, sources: collected?.sources || {}, queries: collected?.queries || [], candidates,
        assessmentResult: null, policy: config.triage, exclusions: config.search?.exclusions || [], startedAt, error: error.message,
      });
      result = { ok: false, status: 'failed', error: error.message, scan: artifacts.run };
    } catch {
      result = { ok: false, status: 'failed', error: error.message };
    }
  } finally {
    const released = releaseLockFn(root, lock.lock.token);
    if (!released.ok) result = { ...(result || {}), ok: false, status: 'failed', error: 'scan lock could not be released safely' };
  }
  const logs = workspacePaths(root).logs;
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ provider, mode, ...result }, null, 2)}\n`);
  return result;
}

export function installSchedule(root, time, provider, { id = `${provider}-primary`, mode = 'primary' } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('schedule provider must be codex or claude');
  if (!['primary', 'second-pass'].includes(mode)) throw new Error('schedule mode must be primary or second-pass');
  const config = loadWorkspaceConfig(root);
  removeLegacySchedule();
  const cli = fileURLToPath(import.meta.url);
  if (process.platform !== 'win32') {
    const result = registerUnixSchedule({ id, platform: process.platform, command: process.execPath, args: [cli, 'scan', '--workspace', root, '--provider', provider, '--mode', mode], workingDirectory: APP_ROOT, time, timezone: config.timezone });
    if (result.ok) {
      config.schedule.jobs = [...config.schedule.jobs.filter((job) => job.id !== id), { id, enabled: true, time, provider, mode }];
      writeWorkspaceConfig(root, config);
    }
    return result;
  }
  const scriptFile = path.join(os.tmpdir(), `scout-task-${process.pid}.ps1`);
  fs.writeFileSync(scriptFile, schedulerRegistrationScript(), 'utf8');
  try {
    const argumentsText = `"${cli}" scan --workspace "${root}" --provider ${provider} --mode ${mode}`;
    const result = registerDailySchedule({ id, scriptFile, command: process.execPath, argumentsText, workingDirectory: APP_ROOT, time });
    if (result.ok) {
      config.schedule.jobs = [...config.schedule.jobs.filter((job) => job.id !== id), { id, enabled: true, time, provider, mode }];
      writeWorkspaceConfig(root, config);
    }
    return result;
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
}

function print(value) { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  const root = selectedWorkspace(argv);
  if (command === 'doctor') return print(doctor(root, { appRoot: APP_ROOT }));
  if (command === 'remote') {
    const action = argv[1] || 'preflight';
    if (action !== 'preflight') throw new Error('remote action must be preflight');
    const result = await runRemoteHostingPreflight({
      url: argValue('--url', argv) || 'http://127.0.0.1:8459',
      requireEnabled: argv.includes('--require-enabled'),
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'workspace') {
    const action = argv[1] || 'init';
    if (action === 'init') return print({ ok: true, workspace: initWorkspace(root) });
    if (action === 'migrate') {
      const source = path.resolve(argValue('--from', argv) || APP_ROOT);
      const target = path.resolve(argValue('--to', argv) || argValue('--workspace', argv) || path.join(os.homedir(), 'Documents', 'Scout Workspace'));
      return print({ ok: true, ...migrateLegacyWorkspace(source, target) });
    }
  }
  if (command === 'scan') {
    const config = loadWorkspaceConfig(root);
    const provider = argValue('--provider', argv) || config.ai?.provider;
    const result = await runScan(root, provider, argValue('--mode', argv) || 'primary');
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'cv') {
    const action = argv[1] || 'quality';
    if (action !== 'quality') throw new Error('cv action must be quality');
    const slug = argv[2];
    if (!slug) throw new Error('cv quality requires an application slug');
    const config = loadWorkspaceConfig(root);
    const result = runCvQuality(root, slug, { locale: config.locale, appRoot: APP_ROOT });
    await queueWorkspaceSync(root, `review cv quality - ${slug}`).catch(() => {});
    print(result);
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (command === 'lock') {
    const action = argv[1] || 'status';
    if (action === 'acquire') return print(acquireScanLock(root, { agent: argv[2], mode: argv[3] }));
    if (action === 'release') return print(releaseScanLock(root, argv[2]));
    if (action === 'status') return print({ ok: true, lock: readScanLock(root) });
    throw new Error('lock action must be acquire, release, or status');
  }
  if (command === 'source') {
    const source = argv[1];
    const queries = workspaceQueries(root);
    const config = loadWorkspaceConfig(root);
    if (source === 'ats') return print(await fetchConfiguredPortals(root));
    if (source === 'hiring-cafe') return print(await fetchHiringCafe(queries, globalThis.fetch, {
      ...config.sources?.hiringCafe,
      locale: config.locale,
    }));
    if (source === 'adzuna') {
      const credentials = resolveAdzunaCredentials({ ...loadEnv(root), ...process.env });
      const adzuna = config.sources?.adzuna || {};
      return print(await fetchAdzuna({
        ...(credentials || {}),
        ...adzuna,
        queries,
        where: adzuna.where || config.search?.locations?.[0] || '',
        salaryMin: config.search?.salaryMinimum,
        locale: config.locale,
        currency: config.currency,
      }));
    }
    throw new Error('source must be ats, adzuna, or hiring-cafe');
  }
  if (command === 'schedule') {
    const action = argv[1] || 'status';
    const config = loadWorkspaceConfig(root);
    const id = argValue('--id', argv) || config.schedule?.jobs?.[0]?.id || 'primary';
    if (action === 'status') return print({
      ok: true,
      runs: config.schedule.jobs.map((job) => ({ ...job, ...scheduleStatus({ id: job.id }) })),
    });
    if (action === 'remove') {
      const result = removeSchedule({ id });
      if (result.ok) {
        config.schedule.jobs = config.schedule.jobs.map((job) => job.id === id ? { ...job, enabled: false } : job);
        writeWorkspaceConfig(root, config);
      }
      return print(result);
    }
    if (action === 'run-now') return print(runScheduledNow({ id }));
    if (action === 'install') {
      const provider = argValue('--provider', argv) || config.ai?.provider;
      const mode = argValue('--mode', argv) || 'primary';
      return print(installSchedule(root, argValue('--time', argv) || '07:30', provider, {
        id: argValue('--id', argv) || `${provider}-${mode}`,
        mode,
      }));
    }
  }
  print(`Scout CLI\n\nCommands:\n  doctor [--workspace PATH]\n  remote preflight [--require-enabled] [--url URL]\n  workspace init|migrate [--from PATH] [--to PATH]\n  cv quality <application-slug> [--workspace PATH]\n  lock acquire|release|status\n  source ats|adzuna|hiring-cafe\n  scan --provider codex|claude [--mode primary|second-pass]\n  schedule install|status|remove|run-now [--id ID] [--time HH:MM] [--provider PROVIDER] [--mode primary|second-pass]`);
}

const isMain = isMainModule(import.meta.url);
if (isMain) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
