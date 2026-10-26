import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function nativeInstallEnvironment(source, { home, temporary, workspace }) {
  const allowed = new Set(['path', 'systemroot', 'comspec', 'pathext', 'windir', 'programfiles', 'programfiles(x86)', 'display', 'xauthority']);
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())));
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMPDIR: temporary, TEMP: temporary, TMP: temporary, SCOUT_WORKSPACE: workspace,
    SCOUT_DEVICE_SETTINGS: path.join(temporary, 'device.json'), PORT: '8459', BROWSER: '/bin/true',
  });
}

export function runIsolatedNativeCommand(command, args, { env, ...options }) {
  assert.ok(env?.SCOUT_DEVICE_SETTINGS && env.SCOUT_WORKSPACE && env.HOME, 'Native commands require the isolated acceptance environment');
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options, env, windowsHide: true, shell: false });
  assert.equal(result.status, 0, `Native installation command failed: ${path.basename(command)}\n${result.stdout}\n${result.stderr}`);
  return result;
}

export function uninstallWindowsNative(installedRoot, { env, run = runIsolatedNativeCommand }) {
  // Inno's final _?= argument runs the actual uninstaller synchronously rather
  // than returning after it relaunches a temporary copy beneath TEMP.
  return run(path.join(installedRoot, 'unins000.exe'), [
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `_?=${installedRoot}`,
  ], { env });
}

export async function finishNativeInstallCleanup(cleanup, { primaryError = null } = {}) {
  try { await cleanup(); }
  catch (error) {
    const allowed = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'ENOENT', 'ETIMEDOUT']);
    const reason = allowed.has(error?.code) ? error.code : 'failed';
    const message = `Native installation cleanup failed (${reason}); temporary installation retained for runner cleanup.`;
    if (primaryError instanceof Error) primaryError.message += `\n${message}`;
    else throw new Error(message);
  }
}

export function createNativeScanBoundary(invoke, operation) {
  const completion = Promise.withResolvers();
  void completion.promise.catch(() => {});
  return {
    completion: completion.promise,
    async route(route) {
      try {
        const result = await invoke('scan');
        assert.equal(result.ok, true, result.error);
        operation.result = result;
        await route.fulfill({ status: 202, json: { operation } });
        completion.resolve(result);
      } catch (error) {
        await route.fulfill({ status: 500, json: { error: 'Synthetic installed scan failed.' } }).catch(() => {});
        completion.reject(error);
      }
    },
  };
}

export function nativeWorkspaceSnapshot(root) {
  if (!fs.existsSync(root)) return null;
  const entries = {};
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'Synthetic career data must not link outside its workspace');
      if (stat.isDirectory()) { entries[relative] = { kind: 'directory' }; walk(file); }
      else {
        assert.ok(stat.isFile(), 'Synthetic career data must contain ordinary files');
        entries[relative] = { kind: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
      }
    }
  };
  walk(root);
  return entries;
}
