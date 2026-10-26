// Copied into a disposable provider home by provider-recovery.test.mjs.
// Every invocation is a real subprocess; no provider SDK, network or account is used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(import.meta.url);
const provider = path.basename(file, '.mjs');
const directory = path.dirname(file);
const controlFile = path.join(directory, 'control.json');
const read = () => JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const args = process.argv.slice(2);
const same = (...expected) => JSON.stringify(args) === JSON.stringify(expected);
const record = (kind) => fs.appendFileSync(path.join(directory, 'calls.jsonl'), `${JSON.stringify({
  provider, kind, pid: process.pid,
  ...(['login', 'status'].includes(kind) ? { args } : {}),
})}\n`);
const finish = (text = '', status = 0) => { process.stdout.write(text); process.exitCode = status; };

if (same('--version')) {
  record('version');
  finish(`${provider} synthetic acceptance CLI\n`);
} else if (same('login', 'status') || same('auth', 'status')) {
  // Deliberately stale local credentials: only a remote turn can establish expiry.
  record('status');
  finish('Signed in locally\n');
} else if (same('exec', '--help') || same('--help')) {
  record('help');
  finish('--output-schema --json-schema\n');
} else if (same('debug', 'models')) {
  record('catalogue');
  finish('', 2);
} else if (same('login', '--device-auth') || same('auth', 'login')) {
  record('login');
  const complete = () => {
    const state = read();
    if (state[provider].loginSucceeds) {
      state[provider].remote = 'ready';
      // The test controls this private, external stand-in for provider state.
      fs.writeFileSync(`${controlFile}.next`, JSON.stringify(state));
      fs.renameSync(`${controlFile}.next`, controlFile);
    }
    finish('Synthetic sign-in completed\n');
  };
  if (provider === 'claude') {
    process.stdout.write('https://claude.ai/login\nEnter authorization code:\n');
    process.stdin.setEncoding('utf8');
    let input = '';
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      process.stdin.pause();
      complete();
    });
  } else {
    const state = read();
    process.stdout.write(`https://auth.openai.com/device\nEnter code ${state.deviceCode}\n`);
    const poll = setInterval(() => {
      if (!read()[provider].deviceApproved) return;
      clearInterval(poll);
      complete();
    }, 20);
  }
} else if ((provider === 'codex' && args[0] === 'exec') || (provider === 'claude' && args[0] === '-p')) {
  const structured = args.includes('--output-schema') || args.includes('--json-schema');
  record(structured ? 'health-turn' : 'chat-turn');
  process.stdin.resume();
  process.stdin.on('end', () => {
    const state = read();
    if (state[provider].remote !== 'ready') {
      const description = {
        expired: '401 Unauthorized: credentials expired',
        revoked: '403 Forbidden: access token revoked',
        'refresh-failed': '401 Unauthorized: refresh token rejected',
      }[state[provider].remote];
      process.stderr.write(`${description}; ${state.privateDiagnostic}\n`);
      process.exitCode = 3;
      return;
    }
    const text = structured ? '{"ready":true}' : 'Synthetic request completed.';
    if (provider === 'claude') {
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'synthetic-session' }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
    } else {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-session' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
    }
  });
} else {
  record('unexpected');
  finish('Unexpected synthetic provider command\n', 82);
}
