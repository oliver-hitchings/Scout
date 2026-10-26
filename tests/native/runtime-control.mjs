// NODE_OPTIONS preload for the owned native acceptance server only. Provider
// processes and installed-worker imports deliberately receive no control hook.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { nativeControlIdentity, readNativeControlRecord, writeNativeControlRecord } from '../../tools/nativeRuntimeControl.mjs';

async function attach() {
  const directory = path.resolve(process.env.SCOUT_NATIVE_CONTROL_DIR);
  const identity = nativeControlIdentity(directory);
  const session = readNativeControlRecord(directory, identity, 'session.json');
  if (session?.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(session.sessionId || '')
    || session.workspace !== path.resolve(process.env.SCOUT_WORKSPACE || '') || !Number.isSafeInteger(session.controllerPid) || session.controllerPid < 1) {
    throw new Error('Native acceptance runtime control is unavailable.');
  }
  // Match resolveWorkspaceRoot's first explicit --workspace argument before
  // loading any server code that might otherwise open a different workspace.
  const workspaceIndex = process.argv.indexOf('--workspace', 2);
  const requestedWorkspace = workspaceIndex < 0 ? process.env.SCOUT_WORKSPACE : process.argv[workspaceIndex + 1];
  if (!requestedWorkspace || path.resolve(requestedWorkspace) !== session.workspace) {
    throw new Error('Native acceptance runtime control is unavailable.');
  }
  const spawnChild = childProcess.spawn;
  let hold = null;
  let heldChild = null;
  childProcess.spawn = (command, args, options) => {
    if (!['git', 'git.exe'].includes(path.basename(String(command)).toLowerCase()) || !hold) return spawnChild(command, args, options);
    const pending = hold;
    hold = null;
    const script = `
      const { spawnSync } = require('node:child_process');
      process.once('message', () => {
        const result = spawnSync('git', process.argv.slice(1), {stdio:['ignore','inherit','inherit'],env:process.env});
        process.exit(result.status ?? 1);
      });
      process.send('ready');
    `;
    heldChild = spawnChild(process.execPath, ['-e', script, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    heldChild.once('message', pending.resolve);
    heldChild.once('error', pending.reject);
    return heldChild;
  };
  syncBuiltinESMExports();
  const server = await import(pathToFileURL(path.resolve(process.argv[1])));
  if (server.WORKSPACE_ROOT !== session.workspace || typeof server.drainScheduledCheckpoints !== 'function'
    || typeof server.scheduleCheckpoint !== 'function') throw new Error('Native acceptance runtime control is unavailable.');
  writeNativeControlRecord(directory, identity, 'ready.json', { schemaVersion: 1, sessionId: session.sessionId, pid: process.pid });
  const releaseHeld = () => {
    if (heldChild?.connected) heldChild.send('continue');
    heldChild = null;
  };
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (nativeControlIdentity(directory) !== identity) throw new Error('changed control directory');
      const file = fs.readdirSync(directory).sort().find((name) => /^request-[a-f0-9-]{36}\.json$/.test(name));
      if (!file) return;
      const request = readNativeControlRecord(directory, identity, file);
      const id = file.slice('request-'.length, -'.json'.length);
      let ok = false;
      try {
        if (!request || Object.keys(request).sort().join(',') !== 'action,id,schemaVersion,sessionId'
          || request.schemaVersion !== 1 || request.sessionId !== session.sessionId || request.id !== id) throw new Error('invalid request');
        if (request.action === 'hold-checkpoint') {
          let timer;
          try {
            await new Promise((resolve, reject) => {
              hold = { resolve, reject };
              timer = setTimeout(() => reject(new Error('checkpoint child did not start')), 15000);
              void Promise.resolve(server.scheduleCheckpoint('synthetic native checkpoint boundary')).catch(reject);
              void server.drainScheduledCheckpoints().catch(reject);
            });
          } finally { clearTimeout(timer); hold = null; }
        } else if (request.action === 'drain-checkpoints') {
          releaseHeld();
          await server.drainScheduledCheckpoints();
        } else throw new Error('unknown request');
        ok = true;
      } catch { releaseHeld(); }
      writeNativeControlRecord(directory, identity, `response-${id}.json`, { schemaVersion: 1, sessionId: session.sessionId, id, ok });
      fs.unlinkSync(path.join(directory, file));
    } catch {
      clearInterval(timer);
      releaseHeld();
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 20);
  timer.unref();
}

if (process.env.SCOUT_NATIVE_CONTROL_DIR && process.argv[1] && path.basename(process.argv[1]) === 'server.mjs') await attach();
