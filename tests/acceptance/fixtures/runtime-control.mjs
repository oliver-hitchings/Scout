// Loaded only by the disposable acceptance server, through its private IPC
// channel. The real server entry point and checkpoint coordinator still run.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (typeof process.send !== 'function' || path.basename(process.argv[1]) !== 'server.mjs') {
  throw new Error('Acceptance runtime control requires the owned server IPC channel');
}

const spawnChild = childProcess.spawn;
let holdRequest = null;
let heldChild = null;
childProcess.spawn = (command, args, options) => {
  if (command !== 'git' || holdRequest === null) return spawnChild(command, args, options);
  const id = holdRequest;
  holdRequest = null;
  const script = `
    const { spawnSync } = require('node:child_process');
    process.once('message', () => {
      const result = spawnSync('git', process.argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
      process.exit(result.status ?? 1);
    });
    process.send('ready');
  `;
  heldChild = spawnChild(process.execPath, ['-e', script, ...args], {
    ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  heldChild.once('message', () => process.send({ id, ok: true }));
  return heldChild;
};
syncBuiltinESMExports();

const server = await import(pathToFileURL(path.resolve(process.argv[1])));
process.on('message', async ({ id, action }) => {
  try {
    if (action === 'hold-checkpoint') {
      holdRequest = id;
      void server.scheduleCheckpoint('synthetic process acceptance checkpoint');
      void server.drainScheduledCheckpoints();
      return; // Acknowledge after the real Git child is alive under the fence.
    }
    if (action !== 'drain-checkpoints') throw new Error('Unknown acceptance runtime control');
    if (heldChild) {
      heldChild.send('continue');
      heldChild = null;
    }
    await server.drainScheduledCheckpoints();
    process.send({ id, ok: true });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
