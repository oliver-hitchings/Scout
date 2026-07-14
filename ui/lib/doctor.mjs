import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadEnv } from './env.mjs';
import { commandInvocation, detectProviders } from './providers.mjs';
import { loadWorkspaceConfig, workspacePaths } from './workspace.mjs';

function binary(name) {
  const invocation = commandInvocation(name, ['--version']);
  const r = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return { available: r.status === 0, version: String(r.stdout || r.stderr || '').trim() || null };
}

export function doctor(workspaceRoot) {
  const paths = workspacePaths(workspaceRoot);
  const checks = {};
  try {
    checks.config = { ok: true, value: loadWorkspaceConfig(workspaceRoot) };
  } catch (e) {
    checks.config = { ok: false, error: e.message };
  }
  checks.tracker = { ok: fs.existsSync(paths.tracker), path: paths.tracker };
  const git = binary('git');
  const typst = binary('typst');
  checks.git = { ok: git.available, ...git, optional: true };
  checks.typst = { ok: typst.available, ...typst, optional: true };
  checks.providers = detectProviders();
  const env = { ...loadEnv(workspaceRoot), ...process.env };
  checks.adzuna = { ok: !!(env.ADZUNA_APP_ID && env.ADZUNA_API_KEY), optional: true };
  const providerReady = Object.values(checks.providers).some((p) => p.installed && p.authenticated);
  const required = checks.config.ok && checks.tracker.ok && providerReady;
  return { ok: required, workspaceRoot, checks };
}
