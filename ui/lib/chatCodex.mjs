import { assertSafeModel, providerCommand } from './providers.mjs';

const SESSION_ID = /^[A-Za-z0-9-]+$/;

export function codexToolActivity(type, value = '') {
  const text = `${type || ''} ${value || ''}`.toLowerCase();
  if (/search|read|fetch|browse|source|advert/.test(text)) return 'searching';
  if (/file_change|edit|write|patch|cv\./.test(text)) return 'writing';
  return 'thinking';
}

export function buildCodexArgs(resumeId, options = {}) {
  const args = [
    'exec', '--json',
    '-c', 'model_reasoning_effort="high"',
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
  ];
  const model = assertSafeModel(options.model);
  if (model) args.push('--model', model);
  if (resumeId) {
    if (!SESSION_ID.test(resumeId)) throw new Error(`invalid session id: ${resumeId}`);
    // `resume` is an exec subcommand. Exec-level flags such as --sandbox must
    // precede it; current Codex releases reject those flags after the session id.
    args.push('resume', resumeId);
  }
  args.push('-'); // prompt arrives on stdin
  return { command: providerCommand('codex'), args };
}

export function parseCodexLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }
  if (!ev || typeof ev !== 'object') return [];

  // current `codex exec --json` shape
  if (ev.type === 'thread.started' && ev.thread_id) {
    return [{ kind: 'session', sessionId: ev.thread_id }];
  }
  if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
    const it = ev.item;
    if (it.type === 'agent_message' && it.text) return [{ kind: 'delta', text: it.text }];
    if (it.type === 'file_change') {
      return (it.changes || [])
        .map((c) => c && c.path)
        .filter(Boolean)
        .map((f) => ({ kind: 'tool', label: `edit: ${f}`, file: f, activity: codexToolActivity('file_change', f) }));
    }
    if (it.type === 'command_execution') {
      return [{ kind: 'tool', label: `run: ${it.command || ''}`.trim(), file: null, activity: codexToolActivity('command', it.command) }];
    }
    return [];
  }
  if (ev.type === 'turn.completed') {
    return [{ kind: 'done', text: '', ok: true, usage: ev.usage || {} }];
  }
  if (ev.type === 'turn.failed') {
    return [{ kind: 'done', text: (ev.error && ev.error.message) || 'turn failed', ok: false, usage: {} }];
  }

  // legacy shape
  const m = ev.msg && typeof ev.msg === 'object' ? ev.msg : null;
  if (m) {
    if (m.type === 'session_configured' && m.session_id) return [{ kind: 'session', sessionId: m.session_id }];
    if (m.type === 'agent_message' && m.message) return [{ kind: 'delta', text: m.message }];
    if (m.type === 'task_complete') return [{ kind: 'done', text: m.last_agent_message || '', ok: true, usage: {} }];
    if (m.type === 'error') return [{ kind: 'done', text: m.message || 'error', ok: false, usage: {} }];
  }
  return [];
}
