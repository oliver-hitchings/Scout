import fs from 'node:fs';
import path from 'node:path';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';
import { atomicWriteFile } from './atomicWrite.mjs';
import { deviceSettingsPath } from './deviceSettings.mjs';

export function householdSettingsPath(env = process.env) {
  const hostEnv = { ...env };
  delete hostEnv.SCOUT_DEVICE_SETTINGS;
  return path.resolve(env.SCOUT_HOUSEHOLD_SETTINGS || path.join(path.dirname(deviceSettingsPath(hostEnv, process.platform, { household: false })), 'household.json'));
}
function identity(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('household workspace is linked or unavailable');
  return `${stat.dev}:${stat.ino}`;
}
function checkInstance(item) {
  if (!item || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || item.id.length > 48
    || !path.isAbsolute(item.workspace || '') || !Number.isInteger(item.port) || item.port < 1024 || item.port > 65535
    || typeof item.identity !== 'string' || !path.isAbsolute(item.deviceSettings || '') || !path.isAbsolute(item.providerHome || '')) throw new Error('household registry is invalid');
  if (identity(item.workspace) !== item.identity || fs.realpathSync(item.workspace) !== item.workspace) throw new Error('household workspace identity changed');
  validatePhysicalWorkspacePath(item.workspace, item.deviceSettings, 'household device settings');
  validatePhysicalWorkspacePath(item.workspace, item.providerHome, 'household provider home');
  if (item.providerHome !== path.join(item.workspace, '.scout', 'provider-home')) throw new Error('household provider home must be isolated');
  if (item.deviceSettings !== path.join(item.workspace, '.scout', 'device-settings.json')) throw new Error('household device settings must be isolated');
  return item;
}
export function readHousehold({ file = householdSettingsPath() } = {}) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, active: null, instances: [] };
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 128 * 1024) throw new Error('household registry is linked or oversized');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schemaVersion !== 1 || !Array.isArray(state.instances) || state.instances.length > 100) throw new Error('household registry is invalid');
  state.instances.forEach(checkInstance);
  for (const [index, item] of state.instances.entries()) {
    if (state.instances.slice(index + 1).some((other) => overlaps(item.workspace, other.workspace) || overlaps(other.workspace, item.workspace))) throw new Error('household workspaces overlap');
  }
  if (new Set(state.instances.map((item) => item.id)).size !== state.instances.length
    || new Set(state.instances.map((item) => item.port)).size !== state.instances.length
    || (state.active !== null && !state.instances.some((item) => item.id === state.active))) throw new Error('household registry is invalid');
  return state;
}
export function selectedHouseholdInstance({ env = process.env, workspace = null } = {}) {
  const state = readHousehold({ file: householdSettingsPath(env) });
  return state.instances.find((item) => workspace ? item.workspace === path.resolve(workspace) : item.id === state.active) || null;
}
function update(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('household registry is busy; retry after the other command finishes'); }
  try {
    const state = readHousehold({ file });
    const result = action(state);
    atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return result;
  } finally { fs.rmdirSync(lock); }
}
const overlaps = (a, b) => { const rel = path.relative(a, b); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
export function createHouseholdInstance({ appRoot, directory, id, port, file = householdSettingsPath(), initialise }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id || '') || id.length > 48) throw new Error('household id must use lower-case letters, numbers and hyphens (maximum 48 characters)');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('household port must be a whole number from 1024 to 65535');
  if (!directory || typeof initialise !== 'function') throw new Error('household create requires --directory PATH');
  directory = path.resolve(directory);
  let existing = directory;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('household directory must not be symbolic or linked');
  directory = path.join(fs.realpathSync(existing), path.relative(existing, directory));
  return update(file, (state) => {
    if (state.instances.length >= 100 || state.instances.some((item) => item.id === id || item.port === port)) throw new Error('household id or port already exists');
    const workspace = path.join(directory, `workspace-${id}`);
    const app = fs.realpathSync(appRoot);
    if (overlaps(app, workspace) || overlaps(workspace, app) || state.instances.some((item) => overlaps(item.workspace, workspace) || overlaps(workspace, item.workspace))) throw new Error('household workspace must be separate from the app and every other workspace');
    if (fs.existsSync(workspace)) throw new Error('household workspace already exists; existing data is never replaced');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { mode: 0o700 });
    // On failure retain any partial workspace for inspection; never delete data.
    initialise(workspace);
    const providerHome = path.join(workspace, '.scout', 'provider-home');
    fs.mkdirSync(providerHome, { recursive: true, mode: 0o700 });
    const instance = { id, workspace, port, identity: identity(workspace), deviceSettings: path.join(workspace, '.scout', 'device-settings.json'), providerHome };
    state.instances.push(instance);
    state.active ||= id;
    return { ok: true, ...instance };
  });
}
export function switchHouseholdInstance(id, { file = householdSettingsPath() } = {}) {
  return update(file, (state) => {
    const instance = state.instances.find((item) => item.id === id);
    if (!instance) throw new Error('household instance is unavailable');
    state.active = id;
    return { ok: true, ...instance, appliesTo: 'next process; running instances keep their workspace' };
  });
}

// Called only at a process entry point, before provider work. Selection never
// mutates an already-running server or imports another person's credentials.
export function activateHouseholdRuntime(root, { env = process.env } = {}) {
  const instance = selectedHouseholdInstance({ env, workspace: root });
  if (!instance) return null;
  env.SCOUT_HOUSEHOLD_SETTINGS = householdSettingsPath(env);
  env.SCOUT_WORKSPACE = instance.workspace;
  env.SCOUT_DEVICE_SETTINGS = instance.deviceSettings;
  env.PORT ||= String(instance.port);
  env.HOME = instance.providerHome;
  env.USERPROFILE = instance.providerHome;
  env.XDG_CONFIG_HOME = path.join(instance.providerHome, '.config');
  env.CODEX_HOME = path.join(instance.providerHome, '.codex');
  env.CLAUDE_CONFIG_DIR = path.join(instance.providerHome, '.claude');
  if (process.platform === 'win32') {
    env.APPDATA = path.join(instance.providerHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(instance.providerHome, 'AppData', 'Local');
    env.HOMEDRIVE = path.parse(instance.providerHome).root.slice(0, 2);
    env.HOMEPATH = instance.providerHome.slice(env.HOMEDRIVE.length);
  }
  for (const name of Object.keys(env)) {
    if (/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY)$/i.test(name)) delete env[name];
  }
  return instance;
}

export function householdScheduleManagement(root, { env = process.env } = {}) {
  if (env.SCOUT_HEADLESS !== '1' && !selectedHouseholdInstance({ env, workspace: root })) return null;
  return {
    managedExternally: true, supported: false, scheduler: 'owner-system-timers',
    reasonCode: 'household-system-timer-required',
    managementMessage: 'Your server owner manages per-person system timers. Ask them to change scheduled scans using the Home server guide; desktop schedule controls are unavailable here.',
  };
}

export function assertDesktopScheduleAllowed(root, options = {}) {
  const management = householdScheduleManagement(root, options);
  if (!management) return;
  const error = new Error(management.managementMessage);
  error.code = management.reasonCode;
  throw error;
}
