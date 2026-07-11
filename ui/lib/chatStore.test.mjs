import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chatPath, emptyChat, loadChat, saveChat, appendMessage, addFilesTouched, recordHandoff,
} from './chatStore.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-chat-'));
}

test('chatPath builds a path under data/chats and rejects bad ids', () => {
  const root = 'C:/repo';
  assert.equal(
    chatPath(root, 'acme-avionics-lead-2026-07'),
    path.join(root, 'data', 'chats', 'acme-avionics-lead-2026-07.json'),
  );
  assert.throws(() => chatPath(root, '../evil'), /invalid chat id/i);
  assert.throws(() => chatPath(root, 'Bad Slug'), /invalid chat id/i);
  assert.throws(() => chatPath(root, ''), /invalid chat id/i);
});

test('loadChat returns null when missing; saveChat round-trips', () => {
  const root = tmpRoot();
  assert.equal(loadChat(root, 'acme-role-2026-07'), null);
  const chat = emptyChat('claude');
  appendMessage(chat, 'user', 'hello', '2026-07-10T09:00:00Z');
  saveChat(root, 'acme-role-2026-07', chat);
  const loaded = loadChat(root, 'acme-role-2026-07');
  assert.equal(loaded.engine, 'claude');
  assert.equal(loaded.cliSessionId, null);
  assert.deepEqual(loaded.messages, [{ role: 'user', text: 'hello', ts: '2026-07-10T09:00:00Z' }]);
  assert.deepEqual(loaded.filesTouched, []);
  assert.deepEqual(loaded.handoffs, []);
});

test('addFilesTouched dedupes and skips falsy', () => {
  const chat = emptyChat('codex');
  addFilesTouched(chat, ['applications/acme/cv.typ', null, 'applications/acme/cv.typ', '']);
  addFilesTouched(chat, ['applications/acme/outreach.md']);
  assert.deepEqual(chat.filesTouched, ['applications/acme/cv.typ', 'applications/acme/outreach.md']);
});

test('recordHandoff flips engine, clears session id, leaves a divider', () => {
  const chat = emptyChat('claude');
  chat.cliSessionId = 'sess-1';
  recordHandoff(chat, 'codex', '2026-07-10T10:00:00Z');
  assert.equal(chat.engine, 'codex');
  assert.equal(chat.cliSessionId, null);
  assert.deepEqual(chat.handoffs, [{ from: 'claude', to: 'codex', ts: '2026-07-10T10:00:00Z' }]);
  const last = chat.messages.at(-1);
  assert.equal(last.role, 'system');
  assert.match(last.text, /handed off from claude to codex/);
});
