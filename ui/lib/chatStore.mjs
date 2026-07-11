import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]*$/;

export function chatPath(repoRoot, id) {
  if (!ID.test(String(id ?? ''))) throw new Error(`invalid chat id: ${id}`);
  return path.join(repoRoot, 'data', 'chats', `${id}.json`);
}

export function emptyChat(engine) {
  return { engine, cliSessionId: null, messages: [], filesTouched: [], handoffs: [] };
}

export function loadChat(repoRoot, id) {
  const p = chatPath(repoRoot, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveChat(repoRoot, id, chat) {
  const p = chatPath(repoRoot, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(chat, null, 2));
}

export function appendMessage(chat, role, text, ts) {
  chat.messages.push({ role, text, ts });
  return chat;
}

export function addFilesTouched(chat, files) {
  for (const f of files || []) {
    if (f && !chat.filesTouched.includes(f)) chat.filesTouched.push(f);
  }
  return chat;
}

export function recordHandoff(chat, toEngine, ts) {
  chat.handoffs.push({ from: chat.engine, to: toEngine, ts });
  chat.messages.push({
    role: 'system',
    text: `handed off from ${chat.engine} to ${toEngine} at ${ts}`,
    ts,
  });
  chat.engine = toEngine;
  chat.cliSessionId = null;
  return chat;
}
