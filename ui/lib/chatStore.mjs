import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const CHAT_PURPOSES = Object.freeze(['job', 'interview-prep']);

export function chatPurpose(value = 'job') {
  const purpose = String(value || 'job');
  if (!CHAT_PURPOSES.includes(purpose)) throw new Error(`invalid chat purpose: ${purpose}`);
  return purpose;
}

function storageId(id, purpose) {
  if (!ID.test(String(id ?? ''))) throw new Error(`invalid chat id: ${id}`);
  return purpose === 'interview-prep' ? `${id}-interview-prep` : id;
}

export function chatPath(repoRoot, id, purpose = 'job') {
  return path.join(repoRoot, 'data', 'chats', `${storageId(id, chatPurpose(purpose))}.json`);
}

export function emptyChat(engine, model = null) {
  return { engine, model: model || null, cliSessionId: null, messages: [], filesTouched: [], handoffs: [] };
}

export function loadChat(repoRoot, id, purpose = 'job') {
  const p = chatPath(repoRoot, id, purpose);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveChat(repoRoot, id, chat, purpose = 'job') {
  const p = chatPath(repoRoot, id, purpose);
  return withWorkspaceMutationAuthority(repoRoot, {
    kind: 'chat-save', phase: 'persist-chat',
  }, () => {
    atomicWriteFile(p, `${JSON.stringify(chat, null, 2)}\n`);
    return p;
  });
}

// Reserve the one-use action durably before a provider can execute it. A later
// transcript failure or process exit must never make the same token usable.
export function consumeChatRetry(repoRoot, id, retryId, purpose = 'job') {
  return withWorkspaceMutationAuthority(repoRoot, {
    kind: 'chat-save', phase: 'consume-chat-retry',
  }, () => {
    const current = loadChat(repoRoot, id, purpose);
    if (!current?.retry || current.retry.id !== retryId) {
      throw new Error('Chat retry is no longer available');
    }
    delete current.retry;
    atomicWriteFile(chatPath(repoRoot, id, purpose), `${JSON.stringify(current, null, 2)}\n`);
  });
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
