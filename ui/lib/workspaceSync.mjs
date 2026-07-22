import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  initializeRecoveryBackup, loadRecoveryHeader, RECOVERY_DIR, restoreRecoveryBackup, restoreRecoveryBackupWithKey,
  rotateRecoveryPassphrase, writeRecoveryBackup,
} from './recoveryBackup.mjs';

const SETTINGS = '.scout/sync.json';
const STATUS = new Map();
const GITHUB_ED25519_HOST = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

function runGit(cwd, args, options = {}) {
  const result = (options.spawn || spawnSync)('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...(options.env || {}), GIT_TERMINAL_PROMPT: options.allowPrompt ? '1' : '0' },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: String(result.stderr || result.stdout || `git ${args[0]} failed`).trim(),
  };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function settingsPath(root) { return path.join(root, ...SETTINGS.split('/')); }

export function prepareGithubDeployKey(root, options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Scout could not locate the account home directory');
  const sshDir = path.join(home, '.ssh');
  const keyPath = path.join(sshDir, 'scout-workspace-deploy');
  const knownHosts = path.join(sshDir, 'scout-github-known-hosts');
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyPath)) {
    const created = (options.spawn || spawnSync)('ssh-keygen', [
      '-t', 'ed25519', '-N', '', '-C', 'scout-workspace-backup', '-f', keyPath,
    ], { encoding: 'utf8', windowsHide: true });
    if (created.status !== 0) throw new Error(String(created.stderr || created.stdout || 'ssh-keygen failed').trim());
  }
  fs.chmodSync(keyPath, 0o600);
  const known = fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, 'utf8') : '';
  if (!known.split(/\r?\n/).includes(GITHUB_ED25519_HOST)) fs.appendFileSync(knownHosts, `${known && !known.endsWith('\n') ? '\n' : ''}${GITHUB_ED25519_HOST}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(knownHosts, 0o600);
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const sshCommand = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${knownHosts}"`;
  ensureRepo(root, options);
  const configured = runGit(root, ['config', 'core.sshCommand', sshCommand], options);
  if (!configured.ok) throw new Error(configured.error);
  return { ok: true, keyPath, knownHosts, publicKey, sshCommand };
}

export function loadSyncSettings(root) {
  const file = settingsPath(root);
  if (!fs.existsSync(file)) return { version: 1, enabled: false, remoteUrl: null, dataKey: null };
  try { return { version: 1, enabled: false, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { version: 1, enabled: false, remoteUrl: null, dataKey: null }; }
}

export function saveSyncSettings(root, value) {
  atomicJson(settingsPath(root), { version: 1, ...value });
  return value;
}

export function pendingRecoveryKey(root) {
  return loadSyncSettings(root).pendingRecoveryKey || null;
}

export function confirmRecoveryKey(root) {
  const settings = loadSyncSettings(root);
  const hadPendingKey = Boolean(settings.pendingRecoveryKey);
  delete settings.pendingRecoveryKey;
  saveSyncSettings(root, settings);
  return { ok: true, confirmed: hadPendingKey };
}

export function validateGithubUrl(value) {
  const text = String(value || '').trim();
  const ssh = text.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (ssh) return {
    url: `git@github.com:${ssh[1]}/${ssh[2]}.git`,
    owner: ssh[1], repo: ssh[2], transport: 'ssh', identity: `${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}`,
  };
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a valid GitHub HTTPS or SSH repository URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a credential-free https://github.com/owner/repository or git@github.com:owner/repository URL');
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error('Use a credential-free https://github.com/owner/repository or git@github.com:owner/repository URL');
  return {
    url: `https://github.com/${match[1]}/${match[2]}.git`,
    owner: match[1], repo: match[2], transport: 'https', identity: `${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
  };
}

export function detectGit(options = {}) {
  const git = runGit(process.cwd(), ['--version'], options);
  if (!git.ok) return { installed: false, credentialManager: false, error: git.error };
  const manager = runGit(process.cwd(), ['credential-manager', '--version'], options);
  return { installed: true, version: git.stdout, credentialManager: manager.ok, credentialManagerVersion: manager.ok ? manager.stdout : null };
}

export async function verifyPrivateGithubRemote(value, options = {}) {
  const parsed = (options.validateUrl || validateGithubUrl)(value);
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (!fetchFn) throw new Error('Scout could not verify that the repository is private');
  let visibility;
  try {
    visibility = await fetchFn(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Scout' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Scout could not verify that the GitHub repository is private');
  }
  if (visibility.status === 200) throw new Error('This GitHub repository is public. Change it to Private before connecting Scout');
  if (visibility.status !== 404) throw new Error(`GitHub privacy check failed (${visibility.status})`);
  const cwd = options.cwd || process.cwd();
  const configuredSsh = parsed.transport === 'ssh' ? runGit(cwd, ['config', '--get', 'core.sshCommand'], options) : null;
  const access = runGit(cwd, ['ls-remote', '--heads', parsed.url], {
    ...options,
    allowPrompt: parsed.transport === 'https',
    ...(parsed.transport === 'ssh' ? {
      env: {
        ...(options.env || {}),
        GIT_SSH_COMMAND: configuredSsh?.ok
          ? configuredSsh.stdout
          : 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      },
    } : {}),
  });
  if (!access.ok) throw new Error(`GitHub sign-in or repository access failed: ${access.error}`);
  return { ...parsed, empty: !access.stdout, refs: access.stdout };
}

function repoReady(root, options = {}) {
  const result = runGit(root, ['rev-parse', '--show-toplevel'], options);
  if (!result.ok) return false;
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return fs.realpathSync.native(resolved); } catch { return resolved; }
  };
  const top = canonical(result.stdout);
  const workspace = canonical(root);
  return process.platform === 'win32'
    ? top.toLowerCase() === workspace.toLowerCase()
    : top === workspace;
}

function sensitiveTrackedPath(value) {
  const file = String(value || '').replaceAll('\\', '/');
  return file === '.env' || file === 'AGENTS.md' || file === 'CLAUDE.md'
    || file.startsWith('.scout/') || file.startsWith('.agents/') || file.startsWith('.claude/') || file.startsWith('logs/')
    || file.startsWith('data/chats/')
    || (/^applications\/.+\.(?:pdf|docx)$/i.test(file));
}

function untrackLegacyChats(root, options = {}) {
  const tracked = runGit(root, ['ls-files', '-z', '--', 'data/chats'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  if (!tracked.stdout.split('\0').filter(Boolean).length) return;
  const removed = runGit(root, ['rm', '--cached', '-r', '--ignore-unmatch', '--', 'data/chats'], options);
  if (!removed.ok) throw new Error(`Private backup could not make chats device-local: ${removed.error}`);
}

function untrackLegacyManagedInstructions(root, options = {}) {
  const tracked = runGit(root, ['ls-files', '-z', '--', 'AGENTS.md', 'CLAUDE.md'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  if (!tracked.stdout.split('\0').filter(Boolean).length) return;
  const removed = runGit(root, ['rm', '--cached', '--ignore-unmatch', '--', 'AGENTS.md', 'CLAUDE.md'], options);
  if (!removed.ok) throw new Error(`Private backup could not make managed instructions device-local: ${removed.error}`);
}

function assertNoTrackedSecrets(root, options = {}) {
  const tracked = runGit(root, ['ls-files', '-z'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  const unsafe = tracked.stdout.split('\0').filter(sensitiveTrackedPath);
  if (unsafe.length) throw new Error(`Private backup cannot continue because sensitive ignored files are already tracked: ${unsafe.slice(0, 5).join(', ')}`);
}

function ensureRepo(root, options = {}) {
  if (!repoReady(root, options)) {
    const enclosing = runGit(root, ['rev-parse', '--show-toplevel'], options);
    if (enclosing.ok) {
      throw new Error('Private backup refuses a workspace nested inside another Git repository');
    }
    const init = runGit(root, ['init'], options);
    if (!init.ok) throw new Error(init.error);
  }
  if (!runGit(root, ['config', '--get', 'user.name'], options).ok) runGit(root, ['config', 'user.name', 'Scout'], options);
  if (!runGit(root, ['config', '--get', 'user.email'], options).ok) runGit(root, ['config', 'user.email', 'scout@local'], options);
}

function remoteUrl(root, options = {}) {
  const result = runGit(root, ['remote', 'get-url', 'origin'], options);
  return result.ok ? result.stdout : null;
}

function setState(root, state, details = {}) {
  const checkedAt = new Date().toISOString();
  const value = { state, checkedAt, ...details, ...(state === 'synced' ? { lastSuccessfulAt: checkedAt } : {}) };
  if (state === 'synced') {
    const settings = loadSyncSettings(root);
    if (settings.enabled) saveSyncSettings(root, { ...settings, lastSuccessfulAt: checkedAt });
  }
  STATUS.set(path.resolve(root), value);
  return value;
}

export function syncStatus(root, options = {}) {
  const settings = loadSyncSettings(root);
  const git = detectGit(options);
  if (!settings.enabled) return { state: git.installed ? 'disabled' : 'setup-required', enabled: false, git, remoteUrl: remoteUrl(root, options) };
  return { state: 'pending', enabled: true, git, remoteUrl: settings.remoteUrl, lastSuccessfulAt: settings.lastSuccessfulAt || null, ...(STATUS.get(path.resolve(root)) || {}) };
}

function sameGithubRepository(left, right) {
  try { return validateGithubUrl(left).identity === validateGithubUrl(right).identity; }
  catch { return left === right; }
}

function commitAll(root, message, options = {}) {
  untrackLegacyChats(root, options);
  untrackLegacyManagedInstructions(root, options);
  assertNoTrackedSecrets(root, options);
  const update = runGit(root, ['add', '-u'], options);
  if (!update.ok) throw new Error(update.error);
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (!untracked.ok) throw new Error(untracked.error);
  const files = untracked.stdout.split('\0').filter(Boolean).filter((file) => !sensitiveTrackedPath(file));
  for (let index = 0; index < files.length; index += 100) {
    const add = runGit(root, ['add', '--', ...files.slice(index, index + 100)], options);
    if (!add.ok) throw new Error(add.error);
  }
  const commit = runGit(root, ['commit', '-m', message], options);
  if (commit.ok || /nothing to commit|nothing added|no changes added/i.test(commit.error)) return;
  throw new Error(commit.error);
}

function deviceBackupPreferences(settings) {
  if (settings === undefined) return undefined;
  return settings ? {
    startWithWindows: Boolean(settings.startWithWindows),
    completedSections: settings.completedSections || {},
  } : null;
}

function worktreeDirty(root, options = {}) {
  const status = runGit(root, ['status', '--porcelain', '--untracked-files=normal'], options);
  if (!status.ok) throw new Error(status.error);
  return Boolean(status.stdout);
}

function checkpointLocally(root, settings, options, reason) {
  if (settings.enabled) {
    const key = Buffer.from(String(settings.dataKey || ''), 'base64url');
    if (key.length !== 32) throw new Error('Recovery key cache is missing');
    const header = loadRecoveryHeader(root);
    writeRecoveryBackup(root, key, header, { devicePreferences: deviceBackupPreferences(options.deviceSettings) });
  }
  commitAll(root, `scout: ${reason}`, options);
}

export async function runWorkspaceSync(root, reason = 'workspace update', options = {}) {
  const settings = loadSyncSettings(root);
  if (!repoReady(root, options)) return setState(root, 'disabled', { enabled: false });
  ensureRepo(root, options);
  untrackLegacyChats(root, options);
  untrackLegacyManagedInstructions(root, options);
  assertNoTrackedSecrets(root, options);
  if (!settings.enabled) {
    commitAll(root, `scout: ${reason}`, options);
    return setState(root, 'disabled', { enabled: false, committed: true });
  }
  const key = Buffer.from(String(settings.dataKey || ''), 'base64url');
  if (key.length !== 32) return setState(root, 'needs-attention', { enabled: true, error: 'Recovery key cache is missing' });

  setState(root, 'syncing', { enabled: true });
  const fetch = runGit(root, ['fetch', 'origin'], options);
  if (!fetch.ok) {
    checkpointLocally(root, settings, options, reason);
    return setState(root, 'offline', { enabled: true, pending: true, error: fetch.error });
  }
  const branchResult = runGit(root, ['branch', '--show-current'], options);
  const branch = branchResult.stdout || 'master';
  const upstream = `refs/remotes/origin/${branch}`;
  if (!runGit(root, ['show-ref', '--verify', '--quiet', upstream], options).ok) {
    checkpointLocally(root, settings, options, reason);
    const pushInitial = runGit(root, ['push', '-u', 'origin', 'HEAD'], { ...options, allowPrompt: true });
    return pushInitial.ok
      ? setState(root, 'synced', { enabled: true, pending: false })
      : setState(root, 'offline', { enabled: true, pending: true, error: pushInitial.error });
  }
  const counts = runGit(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], options);
  if (!counts.ok) return setState(root, 'needs-attention', { enabled: true, error: counts.error });
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  if (ahead > 0 && behind > 0) {
    checkpointLocally(root, settings, options, reason);
    return setState(root, 'needs-attention', { enabled: true, pending: true, conflict: true, ahead, behind, error: 'This device and GitHub both contain new changes' });
  }
  if (behind > 0) {
    if (worktreeDirty(root, options)) {
      checkpointLocally(root, settings, options, reason);
      return setState(root, 'needs-attention', { enabled: true, pending: true, conflict: true, ahead: Math.max(1, ahead), behind, error: 'This device has unsynced work and GitHub contains newer changes' });
    }
    const ff = runGit(root, ['merge', '--ff-only', upstream], options);
    if (!ff.ok) return setState(root, 'needs-attention', { enabled: true, conflict: true, error: ff.error });
    try {
      restoreRecoveryBackupWithKey(root, root, key);
    } catch (error) {
      return setState(root, 'needs-attention', { enabled: true, error: `Remote recovery data could not be applied: ${error.message}` });
    }
  }
  checkpointLocally(root, settings, options, reason);
  const after = runGit(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], options);
  if (!after.ok) return setState(root, 'needs-attention', { enabled: true, error: after.error });
  const [aheadAfter] = after.stdout.split(/\s+/).map(Number);
  if (aheadAfter > 0) {
    const push = runGit(root, ['push', 'origin', 'HEAD'], { ...options, allowPrompt: true });
    if (!push.ok) return setState(root, 'offline', { enabled: true, pending: true, error: push.error });
  }
  return setState(root, 'synced', {
    enabled: true, pending: false, pulled: behind > 0,
    ...(behind > 0 ? { pulledAt: new Date().toISOString() } : {}),
  });
}

const QUEUES = new Map();
export function queueWorkspaceSync(root, reason, options = {}) {
  const key = path.resolve(root);
  const previous = QUEUES.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => runWorkspaceSync(root, reason, options));
  const tracked = next.finally(() => { if (QUEUES.get(key) === tracked) QUEUES.delete(key); });
  QUEUES.set(key, tracked);
  return next;
}

export async function connectWorkspaceSync(root, { remoteUrl: value, passphrase }, options = {}) {
  const git = detectGit(options);
  if (!git.installed) throw new Error('Install Git before setting up private backup');
  const verified = options.verifyRemote
    ? await options.verifyRemote(value)
    : await verifyPrivateGithubRemote(value, { ...options, cwd: root });
  const transport = verified.transport || (() => { try { return validateGithubUrl(value).transport; } catch { return 'https'; } })();
  if (transport === 'https' && !git.credentialManager) throw new Error('Install Git Credential Manager before setting up an HTTPS private backup');
  ensureRepo(root, options);
  untrackLegacyChats(root, options);
  untrackLegacyManagedInstructions(root, options);
  assertNoTrackedSecrets(root, options);
  const current = remoteUrl(root, options);
  if (current && !sameGithubRepository(current, verified.url)) throw new Error('This workspace is already connected to a different origin');
  if (!verified.empty && !current) throw new Error('This repository is not empty. Use Restore existing workspace instead');
  if (!current) {
    const add = runGit(root, ['remote', 'add', 'origin', verified.url], options);
    if (!add.ok) throw new Error(add.error);
  } else if (current !== verified.url) {
    const update = runGit(root, ['remote', 'set-url', 'origin', verified.url], options);
    if (!update.ok) throw new Error(update.error);
  }
  const created = initializeRecoveryBackup(root, passphrase, { devicePreferences: deviceBackupPreferences(options.deviceSettings) });
  saveSyncSettings(root, {
    enabled: true, remoteUrl: verified.url, dataKey: created.dataKey.toString('base64url'),
    pendingRecoveryKey: created.recoveryKey,
  });
  let status;
  try {
    status = await runWorkspaceSync(root, 'enable private backup', options);
  } catch (error) {
    status = setState(root, 'needs-attention', { enabled: true, pending: true, error: error.message });
  }
  return { status, recoveryKey: created.recoveryKey, remoteUrl: verified.url };
}

export function disableWorkspaceSync(root) {
  const settings = loadSyncSettings(root);
  saveSyncSettings(root, { ...settings, enabled: false });
  return setState(root, 'disabled', { enabled: false, remoteUrl: settings.remoteUrl });
}

function emptyDirectory(dir) {
  if (!fs.existsSync(dir)) return true;
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error('Restore target must not be a symbolic link');
  return stat.isDirectory() && fs.readdirSync(dir).length === 0;
}

function assertNoSymlinks(root, current = root) {
  for (const name of fs.readdirSync(current)) {
    if (current === root && name === '.git') continue;
    const child = path.join(current, name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('The repository contains a symbolic link and cannot be restored safely');
    if (stat.isDirectory()) assertNoSymlinks(root, child);
  }
}

export async function restoreWorkspaceFromGithub({ remoteUrl: value, targetRoot, secret }, options = {}) {
  if (!emptyDirectory(targetRoot)) throw new Error('Restore requires an empty workspace folder');
  const targetExisted = fs.existsSync(targetRoot);
  const git = detectGit(options);
  if (!git.installed) throw new Error('Install Git before restoring Scout');
  const verified = options.verifyRemote
    ? await options.verifyRemote(value)
    : await verifyPrivateGithubRemote(value, options);
  const transport = verified.transport || (() => { try { return validateGithubUrl(value).transport; } catch { return 'https'; } })();
  if (transport === 'https' && !git.credentialManager) throw new Error('Install Git Credential Manager before restoring an HTTPS backup');
  if (verified.empty) throw new Error('The repository is empty; there is no Scout workspace to restore');
  const parent = path.dirname(path.resolve(targetRoot));
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.scout-restore-${crypto.randomUUID()}`);
  let activated = false;
  try {
    const clone = runGit(parent, ['clone', verified.url, temp], { ...options, allowPrompt: true });
    if (!clone.ok) throw new Error(`Restore clone failed: ${clone.error}`);
    assertNoSymlinks(temp);
    for (const relative of ['workspace.json', 'data/opportunities.json']) {
      if (!fs.existsSync(path.join(temp, ...relative.split('/')))) throw new Error('The repository is not a Scout workspace');
    }
    const restored = restoreRecoveryBackup(temp, temp, secret);
    if (options.prepareWorkspace) await options.prepareWorkspace(temp);
    if (options.validateWorkspace) {
      const validation = await options.validateWorkspace(temp);
      if (!validation?.ok) throw new Error('The restored workspace did not pass Scout doctor');
    }
    const settings = { enabled: true, remoteUrl: verified.url, dataKey: restored.dataKey.toString('base64url') };
    saveSyncSettings(temp, settings);
    if (fs.existsSync(targetRoot)) fs.rmdirSync(targetRoot);
    fs.renameSync(temp, targetRoot);
    activated = true;
    let validation = null;
    if (options.validateWorkspace) {
      validation = await options.validateWorkspace(targetRoot);
      if (!validation?.ok) throw new Error('The restored workspace failed validation after activation; Scout rolled it back');
    }
    setState(targetRoot, 'synced', { enabled: true, pending: false });
    return {
      ok: true, workspaceRoot: path.resolve(targetRoot), devicePreferences: restored.devicePreferences,
      files: restored.files, validation,
    };
  } catch (error) {
    if (activated && fs.existsSync(targetRoot)) fs.rmSync(targetRoot, { recursive: true, force: true });
    if (activated && targetExisted && !fs.existsSync(targetRoot)) fs.mkdirSync(targetRoot, { recursive: true });
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function rotateWorkspaceRecoveryPassphrase(root, passphrase, options = {}) {
  const settings = loadSyncSettings(root);
  if (!settings.enabled) throw new Error('Encrypted private backup is not enabled');
  const dataKey = Buffer.from(String(settings.dataKey || ''), 'base64url');
  if (dataKey.length !== 32) throw new Error('Recovery key cache is missing');
  rotateRecoveryPassphrase(root, dataKey, passphrase);
  const status = await runWorkspaceSync(root, 'rotate recovery passphrase', options);
  return { ok: status.state === 'synced', status };
}

export async function adoptExistingWorkspaceFromGithub({
  remoteUrl: value, targetRoot, passphrase, confirmation,
}, options = {}) {
  if (confirmation !== 'replace-with-existing-private-workspace') {
    throw new Error('Explicit private-workspace replacement confirmation is required');
  }
  const target = path.resolve(targetRoot);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) {
    throw new Error('The current Scout workspace must be a real directory');
  }
  for (const relative of ['workspace.json', 'data/opportunities.json']) {
    if (!fs.existsSync(path.join(target, ...relative.split('/')))) throw new Error('The current Scout workspace is not initialised');
  }
  const prepared = prepareGithubDeployKey(target, options);
  const verified = options.verifyRemote
    ? await options.verifyRemote(value)
    : await verifyPrivateGithubRemote(value, { ...options, cwd: target });
  if (verified.empty) throw new Error('The private repository is empty; there is no existing workspace to adopt');
  if ((verified.transport || validateGithubUrl(value).transport) !== 'ssh') {
    throw new Error('Unattended VPS workspace adoption requires a repository-scoped SSH deploy key');
  }

  const parent = path.dirname(target);
  const temporary = path.join(parent, `.scout-adopt-${crypto.randomUUID()}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = `${target}.before-adopt-${stamp}`;
  let originalMoved = false;
  try {
    const clone = runGit(parent, ['clone', verified.url, temporary], {
      ...options, env: { ...(options.env || {}), GIT_SSH_COMMAND: prepared.sshCommand },
    });
    if (!clone.ok) throw new Error(`Private workspace clone failed: ${clone.error}`);
    assertNoSymlinks(temporary);
    for (const relative of ['workspace.json', 'data/opportunities.json']) {
      if (!fs.existsSync(path.join(temporary, ...relative.split('/')))) throw new Error('The private repository is not a Scout workspace');
    }
    const configured = runGit(temporary, ['config', 'core.sshCommand', prepared.sshCommand], options);
    if (!configured.ok) throw new Error(configured.error);
    untrackLegacyChats(temporary, options);
    untrackLegacyManagedInstructions(temporary, options);
    assertNoTrackedSecrets(temporary, options);
    const hasRecoveryBackup = fs.existsSync(path.join(temporary, ...RECOVERY_DIR.split('/'), 'header.json'));
    const recovery = hasRecoveryBackup
      ? restoreRecoveryBackup(temporary, temporary, passphrase)
      : initializeRecoveryBackup(temporary, passphrase, { devicePreferences: deviceBackupPreferences(options.deviceSettings) });
    if (options.prepareWorkspace) await options.prepareWorkspace(temporary);
    if (options.validateWorkspace) {
      const validation = await options.validateWorkspace(temporary);
      if (!validation?.ok) throw new Error('The private workspace did not pass Scout doctor');
    }
    saveSyncSettings(temporary, {
      enabled: true, remoteUrl: verified.url, dataKey: recovery.dataKey.toString('base64url'),
      ...(recovery.recoveryKey ? { pendingRecoveryKey: recovery.recoveryKey } : {}),
    });
    const status = await runWorkspaceSync(temporary, 'adopt existing private workspace', options);
    if (status.state !== 'synced') throw new Error(`Initial private backup did not complete: ${status.error || status.state}`);

    fs.renameSync(target, backupRoot);
    originalMoved = true;
    fs.renameSync(temporary, target);
    originalMoved = false;
    setState(target, 'synced', { enabled: true, pending: false, lastSuccessfulAt: status.lastSuccessfulAt });
    return {
      ok: true, workspaceRoot: target, backupRoot, recoveryKey: recovery.recoveryKey || null,
      restoredExistingRecovery: hasRecoveryBackup, status: syncStatus(target, options),
    };
  } catch (error) {
    if (originalMoved && !fs.existsSync(target) && fs.existsSync(backupRoot)) fs.renameSync(backupRoot, target);
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
