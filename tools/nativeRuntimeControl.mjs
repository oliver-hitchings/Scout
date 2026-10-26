// Private native-acceptance fixture transport. Never registered with Scout's API.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIMIT = 16 * 1024;
const ACTIONS = new Set(['drain-checkpoints', 'hold-checkpoint']);
const failure = () => new Error('Native acceptance runtime control is unavailable.');
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
export function nativeControlIdentity(directory) {
  try {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw failure();
    return `${stat.dev}:${stat.ino}`;
  } catch { throw failure(); }
}
function checkedFile(directory, identity, name) {
  if (!/^[a-z][a-z0-9-]{0,80}\.json$/.test(name) || nativeControlIdentity(directory) !== identity) throw failure();
  return path.join(directory, name);
}
export function readNativeControlRecord(directory, identity, name) {
  let descriptor;
  try {
    const file = checkedFile(directory, identity, name);
    const selected = fs.lstatSync(file, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink() || selected.size > BigInt(LIMIT)) throw failure();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== selected.dev || opened.ino !== selected.ino || opened.size > BigInt(LIMIT)) throw failure();
    const bytes = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (length > LIMIT || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink()
      || nativeControlIdentity(directory) !== identity) throw failure();
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure();
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
export function writeNativeControlRecord(directory, identity, name, value) {
  const file = checkedFile(directory, identity, name);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > LIMIT || fs.existsSync(file)) throw failure();
  const temporary = path.join(directory, `record-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    if (nativeControlIdentity(directory) !== identity) throw failure();
    fs.renameSync(temporary, file);
  } catch { throw failure(); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

export function createNativeRuntimeControl({ temporary, workspace, env, timeoutMs = 60000 }) {
  if (typeof temporary !== 'string' || typeof workspace !== 'string' || !env || typeof env !== 'object' || env === process.env) throw failure();
  temporary = path.resolve(temporary);
  workspace = path.resolve(workspace);
  const inside = (file) => {
    const relative = path.relative(temporary, path.resolve(file || temporary));
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  nativeControlIdentity(temporary);
  if (!inside(workspace) || !inside(env?.HOME)
    || !inside(env?.SCOUT_DEVICE_SETTINGS) || path.resolve(env?.SCOUT_WORKSPACE || '') !== workspace
    || path.resolve(env?.TMPDIR || '') !== temporary || env.NODE_OPTIONS || env.SCOUT_NATIVE_CONTROL_DIR
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw failure();
  const directory = path.join(temporary, `native-control-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const identity = nativeControlIdentity(directory);
  const sessionId = randomUUID();
  writeNativeControlRecord(directory, identity, 'session.json', { schemaVersion: 1, sessionId, workspace, controllerPid: process.pid });
  const preload = pathToFileURL(fileURLToPath(new URL('../tests/native/runtime-control.mjs', import.meta.url))).href;
  const nodeOptions = `--import=${preload}`;
  env.SCOUT_NATIVE_CONTROL_DIR = directory;
  env.NODE_OPTIONS = nodeOptions;
  let closed = false;
  let queue = Promise.resolve();
  const submit = async (action) => {
    const deadline = Date.now() + timeoutMs;
    const waitFor = async (name, matches) => {
      while (!closed && Date.now() < deadline) {
        const record = readNativeControlRecord(directory, identity, name);
        if (record) { if (!matches(record)) throw failure(); return record; }
        await delay();
      }
      throw new Error('Native acceptance runtime control timed out or closed.');
    };
    await waitFor('ready.json', (record) => record.schemaVersion === 1 && record.sessionId === sessionId && Number.isSafeInteger(record.pid));
    const id = randomUUID();
    const response = `response-${id}.json`;
    writeNativeControlRecord(directory, identity, `request-${id}.json`, { schemaVersion: 1, sessionId, id, action });
    const result = await waitFor(response, (record) => record.schemaVersion === 1 && record.sessionId === sessionId && record.id === id && typeof record.ok === 'boolean');
    fs.unlinkSync(checkedFile(directory, identity, response));
    if (!result.ok) throw failure();
    return { ok: true };
  };
  const request = (action) => {
    if (closed || !ACTIONS.has(action)) return Promise.reject(failure());
    const result = queue.then(() => submit(action));
    queue = result.catch(() => {});
    return result;
  };
  return Object.freeze({
    request,
    drain: () => request('drain-checkpoints'),
    async close() {
      closed = true;
      await queue;
      if (env.NODE_OPTIONS === nodeOptions) delete env.NODE_OPTIONS;
      if (env.SCOUT_NATIVE_CONTROL_DIR === directory) delete env.SCOUT_NATIVE_CONTROL_DIR;
      if (fs.existsSync(directory) && nativeControlIdentity(directory) === identity) fs.rmSync(directory, { recursive: true });
    },
  });
}
