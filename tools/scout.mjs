#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildClaudeArgs, parseClaudeLine } from '../ui/lib/chatClaude.mjs';
import { buildCodexArgs, parseCodexLine } from '../ui/lib/chatCodex.mjs';
import { runTurn } from '../ui/lib/chatRun.mjs';
import { doctor } from '../ui/lib/doctor.mjs';
import { fetchAdzuna, resolveAdzunaCredentials } from '../ui/lib/adzuna.mjs';
import { fetchConfiguredPortals } from '../ui/lib/ats.mjs';
import { fetchHiringCafe } from '../ui/lib/hiringCafe.mjs';
import { loadEnv } from '../ui/lib/env.mjs';
import { providerStatus } from '../ui/lib/providers.mjs';
import { registerDailySchedule, registerUnixSchedule, removeSchedule, runScheduledNow, scheduleStatus, schedulerRegistrationScript } from '../ui/lib/scheduler.mjs';
import {
  loadWorkspaceConfig, resolveWorkspaceRoot, seedWorkspace as seedWorkspaceFiles,
  syncManagedInstructions, workspacePaths, writeWorkspaceConfig,
} from '../ui/lib/workspace.mjs';
import { acquireScanLock, readScanLock, releaseScanLock } from './scan-lock.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.env\n.agents/\n.claude/\nAGENTS.md\nCLAUDE.md\n.scout/\nlogs/\napplications/**/*.pdf\napplications/**/*.docx\n', 'utf8');
  spawnSync('git', ['add', '--', '.'], { cwd: targetRoot, encoding: 'utf8', windowsHide: true });
  const commit = spawnSync('git', ['commit', '-m', 'Initial private Scout workspace'], { cwd: targetRoot, encoding: 'utf8', windowsHide: true });
  return { sourceRoot, targetRoot, verifiedFiles, committed: commit.status === 0, commitMessage: String(commit.stderr || commit.stdout || '').trim() };
}

export async function runScan(root, provider, mode) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('provider must be codex or claude');
  if (!['primary', 'second-pass'].includes(mode)) throw new Error('mode must be primary or second-pass');
  const status = providerStatus(provider);
  if (!status.installed || !status.authenticated) throw new Error(`${provider} is not installed and authenticated; run scout doctor`);
  syncManagedInstructions(APP_ROOT, root);
  const config = loadWorkspaceConfig(root);
  const cli = fileURLToPath(import.meta.url);
  const prompt = `Run the Scout scan skill in this workspace with agent=${provider} and mode=${mode}. Follow AGENTS.md and docs/SCOUT_SCAN_PROTOCOL.md. The Scout CLI is available as: "${process.execPath}" "${cli}" --workspace "${root}". Never send applications or outreach.`;
  const builder = provider === 'codex' ? buildCodexArgs : buildClaudeArgs;
  const parser = provider === 'codex' ? parseCodexLine : parseClaudeLine;
  const turn = runTurn({ ...builder(null, {
    model: config.ai?.provider === provider ? config.ai?.model : null,
    ...(provider === 'claude' ? { permissionMode: 'auto' } : {}),
  }), prompt, cwd: root, parseLine: parser, timeoutMs: 45 * 60 * 1000 });
  const result = await turn.finished;
  const logs = workspacePaths(root).logs;
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ provider, mode, ...result }, null, 2)}\n`);
  return result;
}

export function installSchedule(root, time, provider) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('schedule provider must be codex or claude');
  const config = loadWorkspaceConfig(root);
  const cli = fileURLToPath(import.meta.url);
  if (process.platform !== 'win32') {
    const result = registerUnixSchedule({ platform: process.platform, command: process.execPath, args: [cli, 'scan', '--workspace', root, '--provider', provider, '--mode', 'primary'], workingDirectory: APP_ROOT, time });
    if (result.ok) { config.schedule = { enabled: true, time, provider }; writeWorkspaceConfig(root, config); }
    return result;
  }
  const scriptFile = path.join(os.tmpdir(), `scout-task-${process.pid}.ps1`);
  fs.writeFileSync(scriptFile, schedulerRegistrationScript(), 'utf8');
  try {
    const argumentsText = `"${cli}" scan --workspace "${root}" --provider ${provider} --mode primary`;
    const result = registerDailySchedule({ scriptFile, command: process.execPath, argumentsText, workingDirectory: APP_ROOT, time });
    if (result.ok) {
      config.schedule = { enabled: true, time, provider };
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
  if (command === 'doctor') return print(doctor(root));
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
    const provider = argValue('--provider', argv) || config.schedule?.provider || config.ai?.provider;
    const result = await runScan(root, provider, argValue('--mode', argv) || 'primary');
    print(result);
    if (!result.ok) process.exitCode = 1;
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
    if (action === 'status') return print(scheduleStatus());
    if (action === 'remove') {
      const result = removeSchedule();
      if (result.ok) {
        const config = loadWorkspaceConfig(root);
        config.schedule = { ...config.schedule, enabled: false };
        writeWorkspaceConfig(root, config);
      }
      return print(result);
    }
    if (action === 'run-now') return print(runScheduledNow());
    if (action === 'install') {
      const config = loadWorkspaceConfig(root);
      return print(installSchedule(root, argValue('--time', argv) || config.schedule?.time || '07:30', argValue('--provider', argv) || config.ai?.provider));
    }
  }
  print(`Scout CLI\n\nCommands:\n  doctor [--workspace PATH]\n  workspace init|migrate [--from PATH] [--to PATH]\n  lock acquire|release|status\n  source ats|adzuna|hiring-cafe\n  scan --provider codex|claude [--mode primary|second-pass]\n  schedule install|status|remove|run-now [--time HH:MM] [--provider PROVIDER]`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
