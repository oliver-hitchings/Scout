import os from 'node:os';
import {
  loadChat, saveChat, emptyChat, appendMessage, addFilesTouched, recordHandoff,
} from './chatStore.mjs';
import { buildClaudeArgs, parseClaudeLine } from './chatClaude.mjs';
import { buildCodexArgs, parseCodexLine } from './chatCodex.mjs';
import { runTurn } from './chatRun.mjs';
import { buildPrefills, HANDOFF_SUMMARY_PROMPT, handoffOpening } from './chatPrompts.mjs';
import { readUsage } from './usage.mjs';
import { loadWorkspaceConfig } from './workspace.mjs';
import { providerStatus } from './providers.mjs';

export const ENGINES = {
  claude: { build: buildClaudeArgs, parse: parseClaudeLine },
  codex: { build: buildCodexArgs, parse: parseCodexLine },
};

const running = new Map(); // opportunity id -> { stop() }
export const ONBOARDING_CHAT_ID = 'setup-onboarding';

function replyJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function sseStart(res) {
  res.on('error', () => { /* client disconnected mid-stream - writes are guarded */ });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function sseSend(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseEnd(res) {
  if (res.destroyed || res.writableEnded) return;
  res.end();
}

function parseBody(body) {
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

function nowIso() { return new Date().toISOString(); }

function stopTurnOnDisconnect(req, res, id) {
  const stop = () => {
    if (res.writableEnded) return;
    const turn = running.get(id);
    if (turn) turn.stop();
  };
  req.on('aborted', stop);
  res.on('close', stop);
}

export function registerChatRoutes({
  routes, repoRoot, readTracker, runTurnFn = runTurn, saveChatFn = saveChat, providerStatusFn = providerStatus,
}) {
  function engineBuild(engine, resumeId) {
    const config = loadWorkspaceConfig(repoRoot);
    const model = config.ai?.provider === engine ? config.ai?.model : null;
    const status = providerStatusFn(engine);
    if (!status.installed || !status.authenticated) throw new Error(`${engine} CLI is not installed and signed in`);
    return ENGINES[engine].build(resumeId, { model, command: status.executable, env: status.env });
  }
  function entryOf(id) {
    if (id === ONBOARDING_CHAT_ID) {
      return { id, company: 'Scout', role: 'Workspace setup', sources: [], notes: '' };
    }
    return (readTracker().opportunities || []).find((o) => o.id === id) || null;
  }

  function onboardingPrefill(config) {
    const interests = [...(config.search?.roleFamilies || []), ...(config.search?.sectors || [])];
    return [
      'Use $onboard-scout to finish setting up and tuning my private Scout workspace.',
      `Workspace: ${repoRoot}`,
      `Selected AI provider: ${config.ai?.provider || 'not selected'}`,
      interests.length ? `Initial interests: ${interests.join(', ')}.` : '',
      'Interview me one focused question at a time about missing career evidence, roles, sectors, compensation, locations, commute, dealbreakers, tone, and employer preferences.',
      'Never invent facts. Stage every proposed profile, calibration, CV, lane, and source change under .scout/onboarding for review. Explain the staged changes and wait for my explicit approval before activation.',
      'Remain local-first and never submit an application or send outreach.',
    ].filter(Boolean).join('\n\n');
  }

  routes['GET /api/chat'] = (req, res, body, url) => {
    const id = url.searchParams.get('id') || '';
    let entry;
    try { entry = entryOf(id); } catch (e) { return replyJson(res, 500, { error: `tracker unreadable: ${e.message}` }); }
    if (!entry) return replyJson(res, 404, { error: 'no such opportunity' });
    let chat;
    try { chat = loadChat(repoRoot, id); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    // A failed cold start has no resumable CLI session. Keep its error history,
    // but expose an unset engine so the other installed CLI remains selectable.
    const visibleChat = chat && !chat.cliSessionId ? { ...chat, engine: null } : chat;
    const config = loadWorkspaceConfig(repoRoot);
    return replyJson(res, 200, {
      exists: !!chat,
      chat: visibleChat,
      prefills: id === ONBOARDING_CHAT_ID
        ? { ask: onboardingPrefill(config), review: 'Review the currently staged onboarding changes. Summarise each proposed change, flag any unsupported claims or missing evidence, and do not activate anything.', approve: 'I have reviewed the staged onboarding changes. Validate them once more, show me the exact files that will be activated, and ask for final confirmation before activation.' }
        : buildPrefills(entry, { locale: config.locale, tone: config.profile?.tone }),
      busy: running.has(id),
    });
  };

  routes['GET /api/usage'] = (req, res) => {
    try { return replyJson(res, 200, readUsage(os.homedir())); } catch (e) { return replyJson(res, 500, { error: e.message }); }
  };

  routes['POST /api/chat/stop'] = (req, res, body) => {
    const b = parseBody(body);
    if (!b) return replyJson(res, 400, { error: 'bad json' });
    const turn = running.get(b.id || '');
    if (turn) turn.stop();
    return replyJson(res, 200, { ok: true, stopped: !!turn });
  };

  routes['POST /api/chat/send'] = (req, res, body) => {
    const b = parseBody(body);
    if (!b) return replyJson(res, 400, { error: 'bad json' });
    handleSend(req, res, b);
  };

  routes['POST /api/chat/handoff'] = (req, res, body) => {
    const b = parseBody(body);
    if (!b) return replyJson(res, 400, { error: 'bad json' });
    handleHandoff(req, res, b).catch((e) => {
      const id = b.id || '';
      const turn = running.get(id);
      if (turn) turn.stop();
      running.delete(id);
      const message = `handoff failed: ${e.message}`;
      if (res.headersSent) {
        sseSend(res, 'error', { message });
        sseEnd(res);
      } else {
        replyJson(res, 500, { error: message });
      }
    });
  };

  async function handleHandoff(req, res, b) {
    const id = b.id || '';
    if (running.has(id)) return replyJson(res, 409, { error: 'a turn is already running for this job' });
    let chat;
    try { chat = loadChat(repoRoot, id); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    if (!chat || !chat.cliSessionId) return replyJson(res, 400, { error: 'no conversation to hand off yet' });
    const from = chat.engine;
    if (!ENGINES[from]) return replyJson(res, 400, { error: 'saved chat engine must be claude or codex' });
    const to = from === 'claude' ? 'codex' : 'claude';

    sseStart(res);
    stopTurnOnDisconnect(req, res, id);

    sseSend(res, 'status', { message: `asking ${from} for a handoff summary…` });
    let t1;
    try {
      t1 = runTurnFn({
        ...engineBuild(from, chat.cliSessionId),
        prompt: HANDOFF_SUMMARY_PROMPT,
        cwd: repoRoot,
        parseLine: ENGINES[from].parse,
        onEvent: () => {},
      });
    } catch (e) {
      sseSend(res, 'error', { message: `summary failed: ${e.message}` });
      return sseEnd(res);
    }
    running.set(id, t1);
    let r1;
    try {
      r1 = await t1.finished;
    } catch (e) {
      r1 = { ok: false, error: `summary failed: ${e.message}` };
    } finally {
      if (running.get(id) === t1) running.delete(id);
    }
    if (!r1.ok || !r1.text) {
      const message = `summary failed: ${r1.error || 'empty summary'}`;
      addFilesTouched(chat, r1.filesTouched);
      appendMessage(chat, 'system', message, nowIso());
      try { saveChatFn(repoRoot, id, chat); } catch (e) {
        sseSend(res, 'error', { message: `${message}; transcript save failed: ${e.message}` });
        return sseEnd(res);
      }
      sseSend(res, 'error', { message, sessionId: chat.cliSessionId, filesTouched: chat.filesTouched });
      return sseEnd(res);
    }

    addFilesTouched(chat, r1.filesTouched);
    recordHandoff(chat, to, nowIso());
    appendMessage(chat, 'system', `handoff summary:\n${r1.text}`, nowIso());
    try { saveChatFn(repoRoot, id, chat); } catch (e) {
      sseSend(res, 'error', { message: `handoff transcript save failed: ${e.message}` });
      return sseEnd(res);
    }

    sseSend(res, 'status', { message: `starting ${to} with the summary…` });
    const opening = handoffOpening(r1.text);
    let t2;
    try {
      t2 = runTurnFn({
        ...engineBuild(to, null),
        prompt: opening,
        cwd: repoRoot,
        parseLine: ENGINES[to].parse,
        onEvent: (ev) => { if (ev.kind === 'delta') sseSend(res, 'delta', { text: ev.text }); },
      });
    } catch (e) {
      const message = `handoff turn failed: ${e.message}`;
      appendMessage(chat, 'system', message, nowIso());
      try { saveChatFn(repoRoot, id, chat); } catch { /* the earlier handoff state is already persisted */ }
      sseSend(res, 'error', { message, engine: to, sessionId: chat.cliSessionId });
      return sseEnd(res);
    }
    running.set(id, t2);
    let r2;
    try {
      r2 = await t2.finished;
    } catch (e) {
      r2 = { ok: false, error: `handoff turn failed: ${e.message}` };
    } finally {
      if (running.get(id) === t2) running.delete(id);
    }

    appendMessage(chat, 'user', opening, nowIso());
    if (r2.sessionId) chat.cliSessionId = r2.sessionId;
    addFilesTouched(chat, r2.filesTouched);
    if (r2.ok) {
      appendMessage(chat, 'assistant', r2.text, nowIso());
    } else {
      appendMessage(chat, 'system', r2.error || 'handoff turn failed', nowIso());
    }
    try { saveChatFn(repoRoot, id, chat); } catch (e) {
      sseSend(res, 'error', { message: `handoff transcript save failed: ${e.message}` });
      return sseEnd(res);
    }
    if (r2.ok) sseSend(res, 'done', { engine: to });
    else sseSend(res, 'error', {
      message: r2.error || 'handoff turn failed',
      engine: to,
      sessionId: chat.cliSessionId,
      filesTouched: chat.filesTouched,
    });
    sseEnd(res);
  }

  async function handleSend(req, res, b) {
    const id = b.id || '';
    let entry;
    try { entry = entryOf(id); } catch (e) { return replyJson(res, 500, { error: `tracker unreadable: ${e.message}` }); }
    if (!entry) return replyJson(res, 404, { error: 'no such opportunity' });
    if (running.has(id)) return replyJson(res, 409, { error: 'a turn is already running for this job' });
    let chat;
    try { chat = loadChat(repoRoot, id); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    const engine = chat && chat.cliSessionId ? chat.engine : b.engine;
    if (!ENGINES[engine]) return replyJson(res, 400, { error: 'engine must be claude or codex' });
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) return replyJson(res, 400, { error: 'text required' });
    if (!chat) chat = emptyChat(engine);
    else chat.engine = engine;

    sseStart(res);
    let built;
    try { built = engineBuild(engine, chat.cliSessionId); } catch (e) {
      sseSend(res, 'error', { message: e.message });
      return sseEnd(res);
    }
    const turn = runTurnFn({
      ...built,
      prompt: text,
      cwd: repoRoot,
      parseLine: ENGINES[engine].parse,
      onEvent: (ev) => {
        if (ev.kind === 'delta') sseSend(res, 'delta', { text: ev.text });
        if (ev.kind === 'tool') sseSend(res, 'tool', { label: ev.label, file: ev.file, activity: ev.activity || 'thinking' });
      },
    });
    running.set(id, turn);
    stopTurnOnDisconnect(req, res, id);
    let r;
    try {
      r = await turn.finished;
    } catch (e) {
      r = { ok: false, error: `turn failed: ${e.message}` };
    } finally {
      running.delete(id);
    }

    appendMessage(chat, 'user', text, nowIso());
    if (r.sessionId) chat.cliSessionId = r.sessionId;
    addFilesTouched(chat, r.filesTouched);
    if (r.ok) {
      appendMessage(chat, 'assistant', r.text, nowIso());
    } else {
      appendMessage(chat, 'system', r.error || 'turn failed', nowIso());
    }
    try { saveChatFn(repoRoot, id, chat); } catch (e) {
      console.error('chat transcript save failed:', e.message); // transcript loss only - agent session still resumable
    }

    if (r.ok) {
      sseSend(res, 'done', {
        text: r.text, sessionId: chat.cliSessionId, usage: r.usage, filesTouched: chat.filesTouched,
      });
    } else {
      sseSend(res, 'error', {
        message: r.error || 'turn failed',
        sessionId: chat.cliSessionId,
        filesTouched: chat.filesTouched,
      });
    }
    sseEnd(res);
  }
}
