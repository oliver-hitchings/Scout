import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const PROVIDERS = Object.freeze(['codex', 'claude']);

export function providerCommand(provider, platform = process.platform) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unsupported AI provider: ${provider}`);
  return platform === 'win32' ? `${provider}.cmd` : provider;
}

export function providerStatus(provider, {
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
  timeoutMs = 10_000,
} = {}) {
  const providerEnv = providerEnvironment(env, platform);
  const command = providerCommand(provider, platform);
  const versionCommand = commandInvocation(command, ['--version'], { platform, env: providerEnv, resolve });
  const version = spawn(versionCommand.command, versionCommand.args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs,
    windowsVerbatimArguments: versionCommand.windowsVerbatimArguments,
    env: providerEnv,
  });
  if (version.status !== 0) return { provider, installed: false, authenticated: false, command };
  const authArgs = provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  const authCommand = commandInvocation(command, authArgs, { platform, env: providerEnv, resolve });
  const auth = spawn(authCommand.command, authCommand.args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs,
    windowsVerbatimArguments: authCommand.windowsVerbatimArguments,
    env: providerEnv,
  });
  const authenticated = auth.status === 0;
  const rawAuthMessage = String(auth.stdout || auth.stderr || '').trim();
  return {
    provider,
    command,
    installed: true,
    authenticated,
    version: String(version.stdout || version.stderr || '').trim(),
    // Some provider CLIs return account email/org identifiers as JSON. The UI
    // needs readiness, not account metadata, so never expose that raw output.
    authMessage: authenticated ? 'Logged in' : (rawAuthMessage.split(/\r?\n/, 1)[0] || 'Not logged in'),
  };
}

export function providerEnvironment(env = process.env, platform = process.platform) {
  const next = { ...env };
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') || (platform === 'win32' ? 'Path' : 'PATH');
  const separator = platform === 'win32' ? ';' : ':';
  const existing = String(next[pathKey] || '');
  const common = platform === 'win32'
    ? [
        platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'npm'),
        platformPath.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        platformPath.join(env.LOCALAPPDATA || platformPath.join(home, 'AppData', 'Local'), 'Programs', 'nodejs'),
        platformPath.join(home, '.local', 'bin'),
        platformPath.join(home, '.codex', 'bin'),
      ]
    : [
        platformPath.join(home, '.local', 'bin'),
        platformPath.join(home, '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
  const seen = new Set();
  next[pathKey] = [...common, ...existing.split(separator)]
    .map((entry) => entry.trim()).filter(Boolean)
    .filter((entry) => {
      const key = platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).join(separator);
  return next;
}

export function detectProviders(options) {
  return Object.fromEntries(PROVIDERS.map((name) => [name, providerStatus(name, options)]));
}

export function assertSafeModel(value) {
  if (value == null || value === '') return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error('invalid model identifier');
  return value;
}

export function resolveExecutable(command, { env = process.env, platform = process.platform } = {}) {
  if (path.isAbsolute(command)) return command;
  if (platform !== 'win32') return command;
  const extension = path.extname(command);
  // npm's .cmd shim is often the usable CLI even when a Windows Store package
  // exposes an inaccessible .exe under WindowsApps. Native-only CLIs (such as
  // Claude's installer) still fall through to .exe.
  const candidates = /\.cmd$/i.test(command)
    ? [command, `${command.slice(0, -4)}.exe`]
    : extension ? [command] : [`${command}.cmd`, `${command}.exe`, command];
  for (const candidate of candidates) {
    const result = spawnSync('where.exe', [candidate], { encoding: 'utf8', windowsHide: true, env });
    const found = String(result.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found) return found;
  }
  return command;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('command arguments cannot contain newlines');
  return `"${text.replace(/%/g, '%%').replace(/(["^&|<>])/g, '^$1')}"`;
}

export function commandInvocation(command, args, {
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
} = {}) {
  const executable = resolve(command, { platform, env });
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { command: executable, args, shell: false };
  const line = [quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(' ');
  return {
    command: env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}
