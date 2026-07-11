import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { commandInvocation } from './providers.mjs';

function killTree(child) {
  if (process.platform === 'win32') {
    // taskkill is the only built-in way to reliably stop a shell-launched CLI
    // and its descendants, but managed Windows environments can deny it even
    // for a process we spawned. Fall back to killing the immediate child so a
    // direct executable (and our tests) still stops instead of hanging forever.
    let fellBack = false;
    const fallback = () => {
      if (fellBack) return;
      fellBack = true;
      try { child.kill(); } catch { /* it may already have exited */ }
    };
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', fallback);
    killer.once('close', (code) => { if (code !== 0) fallback(); });
    setTimeout(fallback, 1000).unref();
  } else {
    child.kill();
  }
}

function relativeToRepo(cwd, file) {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return rel.replace(/\\/g, '/');
}

export function runTurn({
  command, args, prompt, cwd, parseLine,
  onEvent = () => {},
  timeoutMs = 600000,
}) {
  let child = null;
  let stopped = false;
  let timedOut = false;
  const finished = new Promise((resolve) => {
    const state = { sessionId: null, deltas: [], files: new Set(), done: null, stderr: '' };
    const invocation = commandInvocation(command, args);
    child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: err.code === 'ENOENT'
          ? `${command} not found on PATH - install it, then restart the Scout server`
          : `spawn failed: ${err.message}`,
      });
    });
    child.stderr.on('data', (c) => { state.stderr = (state.stderr + c).slice(-2000); });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let events = [];
      try { events = parseLine(line) || []; } catch { /* skip unparseable line */ }
      for (const ev of events) {
        if (ev.kind === 'session') state.sessionId = ev.sessionId;
        if (ev.kind === 'delta') state.deltas.push(ev.text);
        if (ev.kind === 'tool' && ev.file) {
          const rel = relativeToRepo(cwd, ev.file);
          if (rel) state.files.add(rel);
        }
        if (ev.kind === 'done') state.done = ev;
        onEvent(ev);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const filesTouched = [...state.files];
      if (timedOut) {
        const duration = timeoutMs % 60000 === 0 ? `${timeoutMs / 60000} minutes` : `${timeoutMs} ms`;
        resolve({ ok: false, error: `timed out after ${duration}`, sessionId: state.sessionId, filesTouched });
      } else if (stopped) {
        resolve({ ok: false, error: 'stopped', stopped: true, sessionId: state.sessionId, filesTouched });
      } else if (code !== 0) {
        const detail = (state.done && state.done.text) || state.stderr.trim() || `exit code ${code}`;
        resolve({ ok: false, error: detail, sessionId: state.sessionId, filesTouched });
      } else if (state.done && state.done.ok !== false) {
        resolve({
          ok: true,
          text: state.done.text || state.deltas.join('\n\n'),
          sessionId: state.sessionId,
          filesTouched,
          usage: state.done.usage || {},
        });
      } else {
        const detail = (state.done && state.done.text) || state.stderr.trim() || `exit code ${code}`;
        resolve({ ok: false, error: detail, sessionId: state.sessionId, filesTouched });
      }
    });
    child.stdin.on('error', () => { /* child may exit before reading stdin */ });
    child.stdin.end(prompt);
  });
  return {
    finished,
    stop: () => { stopped = true; if (child) killTree(child); },
  };
}
