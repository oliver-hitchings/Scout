// Explicit --import fixture for the owned local-provider test process only.
// Fire its operation deadline immediately before HTTP error headers are sent.
// A status/body test must already own those headers before starting its timer.
import http from 'node:http';

const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
let deadline = null;
globalThis.setTimeout = (callback, delay, ...args) => {
  const handle = schedule(callback, delay, ...args);
  if (delay === 300 && new Error().stack.includes('localProvider.mjs')) {
    deadline = { handle, expire: () => callback(...args) };
    process.stdout.write('Synthetic known-status operation deadline armed\n');
  }
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (deadline?.handle === handle) deadline = null;
  return cancel(handle);
};
const createServer = http.createServer;
http.createServer = (listener, ...args) => createServer((req, res) => {
  const writeHead = res.writeHead;
  res.writeHead = function (status, ...headArgs) {
    if ([401, 403, 429].includes(status) && deadline) {
      const active = deadline;
      deadline = null;
      active.expire();
    }
    return writeHead.call(this, status, ...headArgs);
  };
  return listener(req, res);
}, ...args);
