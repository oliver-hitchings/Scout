import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { registerChatRoutes } from './chatService.mjs';
import { loadChat } from './chatStore.mjs';
import { createChatDrawerState, reduceChatDrawer } from './chatDrawerState.mjs';
import { readProviderHealth, recordProviderHealth } from './providerHealth.mjs';
import { mergeWorkspaceDefaults, writeWorkspaceConfig } from './workspace.mjs';

const ID = 'synthetic-role-2026-10';

async function fixture(t, { fail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-local-chat-recovery-'));
  const requests = [];
  const state = { fail };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(state.fail ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.fail
      ? { error: { message: 'Synthetic rejected credentials' } }
      : { choices: [{ message: { content: 'Synthetic local answer.' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeWorkspaceConfig(root, mergeWorkspaceDefaults({ ai: { provider: 'local', local: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'synthetic/model-27b', retries: 0,
  } } }));
  const routes = {};
  registerChatRoutes({
    routes, repoRoot: root,
    readTracker: () => ({ opportunities: [{ id: ID, company: 'Synthetic', role: 'Engineer' }] }),
    runTurnFn: () => assert.fail('local chat must never start a CLI'),
  });
  async function request(url, options = {}) {
    const parsed = new URL(url, 'http://127.0.0.1');
    const handler = routes[`${options.method || 'GET'} ${parsed.pathname}`];
    assert.ok(handler, `real chat route exists for ${url}`);
    const res = new EventEmitter();
    let status;
    let headers;
    const chunks = [];
    res.writeHead = (value, fields) => { status = value; headers = fields; res.headersSent = true; };
    res.write = (chunk) => { chunks.push(String(chunk)); return true; };
    const finished = new Promise((resolve) => { res.end = (chunk) => {
      if (chunk !== undefined) chunks.push(String(chunk));
      res.writableEnded = true;
      resolve();
    }; });
    handler(new EventEmitter(), res, options.body || '', parsed);
    await finished;
    return new Response(chunks.join(''), { status, headers });
  }
  const send = (body) => request('/api/chat/send', { method: 'POST', body: JSON.stringify({ id: ID, ...body }) });
  return { root, requests, state, request, send };
}

// Evaluate the real browser controller with a small DOM surface. Rendering,
// delegated actions, sendChat and SSE handling all remain production code.
function app(request) {
  const element = () => ({
    innerHTML: '', value: '', style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null, querySelectorAll: () => [],
    insertAdjacentHTML(_position, html) { this.innerHTML += html; },
  });
  const elements = Object.fromEntries(['chat-drawer', 'chat-body', 'chat-input', 'chat-send', 'chat-stop'].map((id) => [id, element()]));
  const context = {
    window: {}, URL, TextDecoder, console, fetch: request,
    document: { querySelector: () => null, getElementById: (id) => elements[id] || null },
    matchMedia: () => ({ matches: false }), createChatDrawerState, reduceChatDrawer,
    alert: (message) => assert.fail(message),
  };
  const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/Scout\.init\(\);\s*$/, '');
  vm.runInNewContext(source, context, { filename: 'ui/app.js' });
  const scout = context.window.Scout;
  // Provider catalogue, usage and desktop-link refreshes are unrelated to the
  // local conversation. Keep the real drawer and message rendering intact.
  for (const name of ['loadEngineOptions', 'refreshUsage', 'refreshCodexDeepLink', 'setHostAvailable']) scout[name] = () => {};
  return { scout, elements };
}

test('local HTTP authentication failure renders a saved resend action and the owner can execute it once', async (t) => {
  const f = await fixture(t, { fail: true });
  const failed = await f.send({ engine: 'local', text: 'Keep this synthetic question.' });
  assert.match(await failed.text(), /authentication-required/);
  const saved = loadChat(f.root, ID);
  assert.ok(saved.retry?.id);
  assert.equal(saved.retry.engine, 'local');
  assert.equal(readProviderHealth(f.root, 'local').state, 'sign-in-required');

  const { scout, elements } = app(f.request);
  await scout.openChat(ID);
  const action = elements['chat-body'].innerHTML.match(/<button[^>]*data-action="(resend-chat)"[^>]*>Resend with Local model<\/button>/);
  assert.ok(action, 'the saved failed local message must offer its explicit resend action');
  assert.match(elements['chat-body'].innerHTML, /Settings.*AI providers/);
  assert.doesNotMatch(elements['chat-body'].innerHTML, /Reconnect Local model/);
  assert.equal(f.requests.length, 1, 'opening the saved message never resends it');

  f.state.fail = false;
  recordProviderHealth(f.root, 'local', { kind: 'remote-success', source: 'post-auth' }, { purpose: 'post-auth' });
  assert.equal(f.requests.length, 1, 'provider recovery never resends the message');
  scout.chat.streaming = true;
  assert.match(scout.chatRetryHtml(), /data-action="resend-chat" disabled/);
  await scout.runAction({ dataset: { action: action[1] } });
  assert.equal(f.requests.length, 1, 'the resend action is gated while work is active');
  scout.chat.streaming = false;
  await scout.runAction({ dataset: { action: action[1] } });
  assert.equal(f.requests.length, 2);
  const completed = loadChat(f.root, ID);
  assert.equal(completed.messages.filter(({ role }) => role === 'user').length, 1);
  assert.equal(completed.messages.at(-1).text, 'Synthetic local answer.');
  assert.equal(completed.retry, undefined);
  assert.doesNotMatch(elements['chat-body'].innerHTML, /data-action="resend-chat"/);
  const replay = await f.send({ retryId: saved.retry.id });
  assert.equal(replay.status, 409);
  assert.equal(f.requests.length, 2, 'a consumed action cannot execute the provider again');
});

test('successful local conversation reopens with its composer and continues without provider reselection', async (t) => {
  const f = await fixture(t);
  const first = await f.send({ engine: 'local', text: 'First synthetic question.' });
  assert.match(await first.text(), /Synthetic local answer/);
  assert.equal(loadChat(f.root, ID).cliSessionId, null);
  const { scout, elements } = app(f.request);
  await scout.openChat(ID);
  assert.equal(scout.chat.engine, 'local', 'local conversation identity must survive GET /api/chat and opening the drawer');
  assert.doesNotMatch(elements['chat-body'].innerHTML, /class="chat-picker"/);
  assert.match(elements['chat-drawer'].innerHTML, /<div class="chat-foot" >/);
  assert.doesNotMatch(elements['chat-drawer'].innerHTML, /data-action="handoff-chat"/);
  assert.match(elements['chat-body'].innerHTML, /Synthetic local answer/);
  assert.equal(f.requests.length, 1, 'reopening a successful conversation never sends provider work');
  elements['chat-input'].value = 'Follow-up synthetic question.';
  await scout.runAction({ dataset: { action: 'send-chat' } });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.some(({ role, content }) => role === 'assistant' && content === 'Synthetic local answer.'));
  assert.equal(loadChat(f.root, ID).messages.filter(({ role }) => role === 'user').length, 2);
});
