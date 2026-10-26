#!/usr/bin/env node
// Native runner only. Installs generated artifacts into disposable locations;
// synthetic process/source boundaries never use provider accounts or career data.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createNativeScanBoundary, finishNativeInstallCleanup, nativeInstallEnvironment, nativeWorkspaceSnapshot, runIsolatedNativeCommand, uninstallWindowsNative } from './nativeInstallBoundary.mjs';
import { createNativeRuntimeControl } from './nativeRuntimeControl.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'installer/output');
const portable = process.argv.slice(2).join(' ') === '--portable';
assert.ok(process.argv.length === 2 || (portable && process.platform === 'linux'), 'Only --portable on Linux is supported');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-installed-')));
const workspace = path.join(temporary, 'workspace');
const home = path.join(temporary, 'home');
fs.mkdirSync(home, { recursive: true });
// Install and uninstall helpers can execute Scout code too. Isolate them
// before the first native command, not only when launching the installed app.
const env = nativeInstallEnvironment(process.env, { home, temporary, workspace });
const runtimeControl = createNativeRuntimeControl({ temporary, workspace, env });
let installedRoot, appRoot, runtime, launcher, launcherArgs = [], uninstall;
let host, worker, browser;
let ownsServer = false;
let primaryError = null;
const base = 'http://127.0.0.1:8459';
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
function run(command, args, options = {}) {
  return runIsolatedNativeCommand(command, args, { ...options, env });
}
async function until(check, label, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await wait(); }
  throw new Error(`Timed out waiting for ${label}`);
}
function removeOwnedInstall(directory) {
  assert.ok(path.relative(temporary, directory) && !path.relative(temporary, directory).startsWith('..'));
  const writable = (entry) => {
    const stat = fs.lstatSync(entry);
    assert.equal(stat.isSymbolicLink(), false);
    fs.chmodSync(entry, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) writable(path.join(entry, name));
  };
  writable(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}
function syntheticProposal() {
  const sourced = (text) => ({ text, evidenceIds: ['config-roles'] });
  return { summary: 'Synthetic installed-artifact proposal.', unresolvedQuestions: [],
    profile: { headline: sourced('Synthetic Engineer'), priorities: [sourced('Synthetic Engineer')],
      evidence: [sourced('Delivered reliable synthetic systems. '.repeat(8))], exclusions: [], tone: sourced('Clear and direct') },
    calibration: { dimensions: [{ name: 'Evidence fit', weight: 100, description: 'Synthetic advert and profile evidence.' }],
      gates: [], actionScore: 70, checkScore: 55 },
    searchCategories: [{ id: 'synthetic-engineering', label: 'Synthetic engineering', description: 'Synthetic engineering roles',
      priority: 'primary', queries: ['Synthetic Engineer'], keeperRule: 'Evidence-led fit' }],
    masterCv: { title: sourced('Synthetic Profile — Synthetic Engineer'), profile: sourced('Delivered reliable synthetic systems. '.repeat(66)),
      skills: [sourced('Synthetic delivery'), sourced('Synthetic reliability'), sourced('Synthetic collaboration')],
      experience: [{ heading: sourced('Synthetic systems experience'), bullets: [sourced('Delivered reliable synthetic systems.')] }], education: [], otherEvidence: [] },
  };
}
try {
  // Refuse an occupied loopback port before installing or starting anything.
  // Cleanup is allowed to stop only the app root that this run installed.
  const portGuard = net.createServer();
  await new Promise((resolve, reject) => portGuard.once('error', reject).listen(8459, '127.0.0.1', resolve));
  await new Promise((resolve) => portGuard.close(resolve));
  if (process.platform === 'win32') {
    assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Programs/Scout')), false, 'Use a fresh Windows runner with no existing Scout installation');
    installedRoot = path.join(temporary, 'installed');
    const installer = path.join(output, `Scout-${version}-windows-x64.exe`);
    run(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${installedRoot}`]);
    appRoot = path.join(installedRoot, 'app'); runtime = path.join(installedRoot, 'runtime/ScoutRuntime.exe');
    launcher = path.join(installedRoot, 'Scout.exe'); launcherArgs = ['--background'];
    uninstall = () => uninstallWindowsNative(installedRoot, { env });
  } else if (process.platform === 'darwin') {
    const mount = path.join(temporary, 'mount'); fs.mkdirSync(mount);
    run('hdiutil', ['attach', path.join(output, `Scout-${version}-macos-${process.arch}.dmg`), '-mountpoint', mount, '-nobrowse']);
    installedRoot = path.join(temporary, 'Scout.app');
    try { run('ditto', [path.join(mount, 'Scout.app'), installedRoot]); }
    finally { run('hdiutil', ['detach', mount]); }
    const resources = path.join(installedRoot, 'Contents/Resources');
    appRoot = path.join(resources, 'app'); runtime = path.join(resources, 'runtime/node');
    launcher = path.join(installedRoot, 'Contents/MacOS/Scout'); launcherArgs = ['--workspace', workspace];
    uninstall = () => removeOwnedInstall(installedRoot);
  } else if (process.platform === 'linux' && portable) {
    const archive = path.join(output, `Scout-${version}-linux-x64.tar.gz`);
    const listing = run('tar', ['-tzf', archive], { timeout: 30000 });
    assert.equal(listing.status, 0, listing.stderr);
    const prefix = `Scout-${version}-linux-x64/`;
    assert.ok(listing.stdout.trim().split('\n').every((name) => name.startsWith(prefix) && !name.split('/').includes('..')));
    run('tar', ['-xzf', archive, '-C', temporary, '--no-same-owner']);
    installedRoot = path.join(temporary, `Scout-${version}-linux-x64`);
    appRoot = path.join(installedRoot, 'app'); runtime = path.join(installedRoot, 'runtime/node'); launcher = path.join(installedRoot, 'scout-dashboard');
    uninstall = () => removeOwnedInstall(installedRoot);
  } else if (process.platform === 'linux') {
    assert.equal(fs.existsSync('/opt/scout'), false, 'Use a fresh runner: an existing Scout installation must not be changed');
    run('sudo', ['dpkg', '-i', path.join(output, `Scout-${version}-linux-x64.deb`)]);
    installedRoot = '/opt/scout'; appRoot = '/opt/scout/app'; runtime = '/opt/scout/runtime/node'; launcher = '/usr/bin/scout-dashboard';
    uninstall = () => run('sudo', ['dpkg', '-r', 'scout']);
  } else throw new Error('Unsupported native acceptance platform');
  assert.ok(fs.existsSync(launcher)); assert.ok(fs.existsSync(runtime));
  const bin = path.join(home, process.platform === 'win32' ? 'AppData/Roaming/npm' : '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = fs.readFileSync(path.join(root, 'tests/native/fake-provider.mjs'), 'utf8');
  fs.writeFileSync(path.join(bin, 'proposal.json'), JSON.stringify(syntheticProposal()));
  for (const provider of ['codex', 'claude']) {
    const script = path.join(bin, `${provider}.mjs`); fs.writeFileSync(script, fake);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${provider}.cmd`), `@"${runtime}" "${script}" %*\r\n`);
    else fs.writeFileSync(path.join(bin, provider), `#!${runtime}\n${fake}`, { mode: 0o700 });
  }
  env.SCOUT_ROOT = installedRoot;
  host = spawn(launcher, launcherArgs, { env, stdio: 'ignore', windowsHide: true, shell: false });
  host.on('error', () => {});
  await until(async () => { try { return (await fetch(`${base}/api/app-info`)).ok; } catch { return false; } }, 'installed native first launch');
  const info = await (await fetch(`${base}/api/app-info`)).json();
  assert.equal(fs.realpathSync(info.appRoot), fs.realpathSync(appRoot), 'The listener must be the installed artifact');
  ownsServer = true;
  browser = await chromium.launch(process.env.SCOUT_SMOKE_CHROMIUM ? { executablePath: process.env.SCOUT_SMOKE_CHROMIUM, args: ['--no-sandbox'] } : {});
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: 'Create my local workspace' }).click();
  await until(() => fs.existsSync(path.join(workspace, 'workspace.json')), 'first workspace creation');
  const post = async (route, data) => {
    await runtimeControl.drain();
    const response = await context.request.post(`${base}${route}`, { data, headers: { origin: base } });
    assert.ok(response.ok(), `Installed API action failed: ${route} ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await post('/api/setup/config', { mode: 'background', locale: 'en-US', currency: 'USD', timezone: 'UTC',
    profile: { displayName: 'Synthetic Profile', tone: 'Clear and direct' }, ai: { provider: 'codex' },
    search: { roleFamilies: ['Synthetic Engineer'], locations: ['Remote'], sectors: [], exclusions: [], salaryMinimum: null } });
  await post('/api/setup/import-cv', { name: 'synthetic.md', base64: Buffer.from('Delivered reliable synthetic systems. '.repeat(70)).toString('base64') });
  worker = fork(path.join(root, 'tests/native/installed-worker.mjs'), [appRoot, workspace], { execPath: runtime, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let ready = false; const pending = new Map(); let next = 0;
  worker.on('message', (message) => { if (message.ready) ready = true; const callback = pending.get(message.id); if (callback) { pending.delete(message.id); callback(message); } });
  worker.stdout.resume(); worker.stderr.resume();
  await until(() => ready, 'installed worker import');
  const invoke = async (command) => {
    await runtimeControl.drain();
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Installed synthetic operation timed out')); }, 60000);
      pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result); });
      worker.send({ id, command });
    });
  };
  const proposal = await invoke('onboarding');
  await post('/api/setup/activate', { proposalId: proposal.proposalId, confirmed: true });
  await page.reload();
  await page.getByLabel('I reviewed this complete profile and want to publish it').check();
  await runtimeControl.drain();
  const [publicationResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/search-profile/publish' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Publish this reviewed profile' }).click(),
  ]);
  assert.ok(publicationResponse.ok(), `Installed UI profile publication failed (${publicationResponse.status()})`);
  await page.keyboard.press('Escape');
  await page.locator('#scout-settings').click();
  await page.getByRole('button', { name: 'Search & profile', exact: false }).click();
  await page.getByLabel('How should Scout help you?').selectOption('active');
  // Make this browser boundary deterministic even when real Git is fast on
  // the runner: the preceding owned checkpoint must finish before this save.
  await runtimeControl.request('hold-checkpoint');
  await runtimeControl.drain();
  const [modeResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/setup/config' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Save search mode', exact: true }).click(),
  ]);
  assert.ok(modeResponse.ok(), `Installed UI mode mutation failed (${modeResponse.status()})`);
  await until(() => JSON.parse(fs.readFileSync(path.join(workspace, 'workspace.json'), 'utf8')).mode === 'active', 'reviewed search mode');
  await page.keyboard.press('Escape');
  const operation = { id: 'installed-synthetic-scan', type: 'scan', status: 'succeeded', phase: 'Synthetic scan completed', progress: { current: 5, total: 5 } };
  const scan = createNativeScanBoundary(invoke, operation);
  await page.route('**/api/scan', scan.route);
  await page.route('**/api/operations/installed-synthetic-scan', (route) => route.fulfill({ json: { operation } }));
  await Promise.all([scan.completion, page.locator('#scan-now').click()]);
  const resultCard = page.locator('#tab-jobs .card[data-id]').filter({ hasText: 'Synthetic Studio - Synthetic Engineer' });
  await resultCard.getByText('Synthetic Studio - Synthetic Engineer', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  const calls = fs.readFileSync(path.join(bin, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(({ kind }) => kind === 'onboarding')); assert.ok(calls.some(({ kind }) => kind === 'assessment'));
  assert.ok(fs.existsSync(path.join(workspace, 'data/scan-runs.jsonl')));
  await browser.close(); browser = null;
  console.log('Installed artifact: native first launch, workspace, CV import, reviewed onboarding/profile, mode choice, synthetic provider scan and visible results passed.');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await finishNativeInstallCleanup(async () => {
    await browser?.close().catch(() => {});
    if (ownsServer) {
      try { await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}', signal: AbortSignal.timeout(10000) }); } catch {}
    }
    const stopChild = async (child) => {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise((resolve) => { child.once('close', resolve); child.once('error', resolve); });
      child.kill();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      try { await closed; } finally { clearTimeout(timeout); }
    };
    await Promise.all([stopChild(host), stopChild(worker)]);
    if (ownsServer) await until(async () => {
      try { return !(await fetch(`${base}/api/app-info`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return true; }
    }, 'installed runtime shutdown', 30000);
    await wait(250);
    await runtimeControl.close();
    if (uninstall) {
      const before = nativeWorkspaceSnapshot(workspace);
      uninstall();
      assert.deepEqual(nativeWorkspaceSnapshot(workspace), before, 'Uninstall must preserve every private workspace path and file digest');
      assert.equal(fs.existsSync(path.join(appRoot, 'ui/server.mjs')), false, 'Uninstall must remove application files');
    }
    // Windows directory watchers may release just after all owned processes
    // close. Retries are bounded and cannot turn an acceptance failure green.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }, { primaryError });
}
