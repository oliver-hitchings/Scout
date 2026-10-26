import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomicWrite.mjs';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';
import { workspaceModePolicy } from './workspaceMode.mjs';

const HASH = /^[a-f0-9]{64}$/;
const BLOCKING = new Set(['sign-in-required', 'network-unavailable', 'rate-limited', 'cli-update-required', 'provider-error']);
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MATCHES = 10_000;
const MAX_ALERTS = 1_000;
const MAX_PROVIDER_ALERTS = 64;
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const nullableTime = (value) => value === null || iso(value);
const tuple = (value) => keys(value, ['qualified', 'exceptional', 'episode'])
  && typeof value.qualified === 'boolean' && typeof value.exceptional === 'boolean'
  && Number.isSafeInteger(value.episode) && value.episode >= 0;
const pendingDigestId = (pending) => hash(`digest:${pending.slice().sort().join(':')}`);

export function emptyNotifications() {
  return { schemaVersion: 1, matches: {}, pending: [], digestAfter: null, providerEpisodes: {}, alerts: [] };
}

export function validateNotifications(value) {
  const fail = () => { throw new Error('notification storage has an unsupported schema'); };
  if (!keys(value, ['schemaVersion', 'matches', 'pending', 'digestAfter', 'providerEpisodes', 'alerts'])
    || value.schemaVersion !== 1 || !value.matches || typeof value.matches !== 'object' || Array.isArray(value.matches)
    || Object.keys(value.matches).length > MAX_MATCHES || !Array.isArray(value.pending)
    || value.pending.length > MAX_MATCHES || new Set(value.pending).size !== value.pending.length
    || !value.pending.every((item) => HASH.test(item)) || !nullableTime(value.digestAfter)
    || !value.providerEpisodes || typeof value.providerEpisodes !== 'object' || Array.isArray(value.providerEpisodes)
    || !Array.isArray(value.alerts) || value.alerts.length > MAX_ALERTS + MAX_PROVIDER_ALERTS) fail();
  for (const [id, item] of Object.entries(value.matches)) if (!HASH.test(id) || !tuple(item)) fail();
  for (const [provider, item] of Object.entries(value.providerEpisodes)) {
    if (!['codex', 'claude', 'local'].includes(provider) || !(keys(item, ['state', 'episode']) || keys(item, ['state', 'episode', 'intentId']))
      || !(item.state === null || BLOCKING.has(item.state))
      || !Number.isSafeInteger(item.episode) || item.episode < 0
      || (item.intentId !== undefined && item.intentId !== null && !HASH.test(item.intentId))) fail();
  }
  const ids = new Set();
  for (const item of value.alerts) {
    if (!keys(item, ['id', 'kind', 'provider', 'count', 'createdAt', 'deliveredAt', 'acknowledgedAt'])
      || !HASH.test(item.id) || ids.has(item.id) || !['match', 'digest', 'provider'].includes(item.kind)
      || ![null, 'codex', 'claude', 'local'].includes(item.provider)
      || (item.kind === 'provider') !== (item.provider !== null)
      || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > MAX_MATCHES
      || !iso(item.createdAt) || !nullableTime(item.deliveredAt) || !nullableTime(item.acknowledgedAt)) fail();
    ids.add(item.id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail();
  return value;
}

function fileAt(root, name) {
  return validatePhysicalWorkspacePath(root, path.join(root, '.scout', name), 'notification storage');
}

export function notificationFile(root) { return fileAt(root, 'notifications.json'); }

function readJson(root, name) {
  const file = fileAt(root, name);
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('notification storage needs review');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('notification storage could not be read'); }
}

function readState(root, name = 'notifications.json') {
  const state = readJson(root, name);
  if (state === null) return emptyNotifications();
  delete state._scoutMutation;
  return validateNotifications(state);
}

function readReceipts(root) {
  const value = readJson(root, 'notification-receipts.json') || { schemaVersion: 1, receipts: {} };
  if (!keys(value, ['schemaVersion', 'receipts']) || value.schemaVersion !== 1
    || !value.receipts || typeof value.receipts !== 'object' || Array.isArray(value.receipts)
    || Object.keys(value.receipts).length > 12_065) throw new Error('notification receipts have an unsupported schema');
  for (const [id, item] of Object.entries(value.receipts)) {
    if (!HASH.test(id) || !keys(item, ['deliveredAt', 'acknowledgedAt'])
      || !nullableTime(item.deliveredAt) || !nullableTime(item.acknowledgedAt)) {
      throw new Error('notification receipts have an unsupported schema');
    }
  }
  return value;
}

function trimAcknowledged(alerts) {
  while (alerts.length > MAX_ALERTS) {
    const index = alerts.findIndex((item) => item.acknowledgedAt !== null);
    if (index < 0) throw new Error('Review older notifications before creating more alerts');
    alerts.splice(index, 1);
  }
}

function combine(base, runtime, receipts, providerState = emptyNotifications(), consumedPending = []) {
  const state = structuredClone(base);
  const consumed = new Set(consumedPending);
  state.pending = state.pending.filter((id) => !consumed.has(id));
  if (!state.pending.length) state.digestAfter = null;
  state.providerEpisodes = structuredClone(providerState.providerEpisodes);
  state.alerts = [...new Map([...base.alerts, ...runtime.alerts].filter((item) => item.kind !== 'provider').map((item) => [item.id, item])).values()]
    .map((item) => ({ ...item, ...(receipts.receipts[item.id] || {}) }));
  trimAcknowledged(state.alerts);
  state.alerts.push(...providerState.alerts.map((item) => ({ ...item, ...(receipts.receipts[item.id] || {}) })));
  if (state.pending.length && state.alerts.some((item) => item.id === pendingDigestId(state.pending))) {
    state.pending = [];
    state.digestAfter = null;
  }
  return validateNotifications(state);
}

export function readNotifications(root) {
  for (const provider of ['codex', 'claude', 'local']) readProviderIntent(root, provider);
  const runtime = readRuntime(root);
  return combine(readState(root), runtime.state, readReceipts(root), readProviderState(root), runtime.consumedPending);
}

function persistJson(root, name, state) {
  const file = fileAt(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFile(fileAt(root, name), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function readRuntime(root) {
  const { consumedPending = [], ...state } = readJson(root, 'notifications-runtime.json') || emptyNotifications();
  if (!Array.isArray(consumedPending) || consumedPending.length > MAX_MATCHES
    || new Set(consumedPending).size !== consumedPending.length || !consumedPending.every((id) => HASH.test(id))) {
    throw new Error('notification runtime storage has an unsupported schema');
  }
  validateNotifications(state);
  const receipts = readReceipts(root);
  state.alerts = state.alerts.filter((item) => item.kind !== 'provider').map((item) => ({ ...item, ...(receipts.receipts[item.id] || {}) }));
  state.providerEpisodes = {};
  return { state, consumedPending };
}

function persistRuntime(root, runtime) {
  const { state } = runtime;
  const base = readState(root);
  const pending = new Set(base.pending);
  // Polls cannot rewrite the scan's receipted target. Keep bounded tombstones
  // beside runtime alerts until a later scan removes those pending identities.
  const consumedPending = [...new Set(runtime.consumedPending)].filter((id) => pending.has(id));
  const merged = combine(base, validateNotifications(state), readReceipts(root), readProviderState(root), consumedPending);
  const retained = new Set(merged.alerts.map((item) => item.id));
  state.alerts = state.alerts.filter((item) => retained.has(item.id));
  const stored = { ...state, consumedPending };
  if (Buffer.byteLength(JSON.stringify(stored)) > MAX_BYTES) throw new Error('notification storage needs review');
  persistJson(root, 'notifications-runtime.json', stored);
}

function addAlert(state, kind, identity, at, count = 1, provider = null) {
  if (!iso(at)) throw new TypeError('notification time must be an ISO timestamp');
  const id = hash(`${kind}:${identity}`);
  if (state.alerts.some((item) => item.id === id)) return;
  const providerAlert = kind === 'provider';
  const limit = providerAlert ? MAX_PROVIDER_ALERTS : MAX_ALERTS;
  const activeProviderIds = new Set(Object.entries(state.providerEpisodes).filter(([, value]) => value.state !== null)
    .map(([name, value]) => hash(`provider:${name}:${value.episode}`)));
  while (state.alerts.filter((item) => (item.kind === 'provider') === providerAlert).length >= limit) {
    const index = state.alerts.findIndex((item) => (item.kind === 'provider') === providerAlert
      && (item.acknowledgedAt !== null || (providerAlert && !activeProviderIds.has(item.id))));
    if (index < 0) throw new Error('Review older notifications before creating more alerts');
    state.alerts.splice(index, 1);
  }
  state.alerts.push({ id, kind, provider, count, createdAt: at, deliveredAt: null, acknowledgedAt: null });
}

function trackerReferences(tracker) {
  const index = new Map();
  for (const entry of tracker?.opportunities || []) {
    for (const reference of [entry.vacancyId, entry.id, ...(entry.sources || [])].filter(Boolean)) {
      if (!index.has(reference)) index.set(reference, entry);
    }
  }
  return index;
}

function identityOf(item, entry = null) {
  return entry?.vacancyId || entry?.id || item.vacancyId || item.trackerId || item.id || hash(JSON.stringify({
    sourceUrl: item.sourceUrl || '', company: item.company || '', role: item.role || '',
    contentFingerprint: item.contentFingerprint || '',
  }));
}

function allMatchStates(state, tracker) {
  return [
    ...Object.entries(state.matches),
    ...(tracker?.opportunities || []).filter((entry) => tuple(entry.notificationState))
      .map((entry) => [hash(identityOf(entry)), entry.notificationState]),
  ];
}

export function flushNotificationDigest(input, config, at, { tracker } = {}) {
  const state = structuredClone(validateNotifications(input));
  const policy = workspaceModePolicy(config);
  if (policy.mode === 'background') {
    const pending = new Set(state.pending);
    const alreadyDigested = state.alerts.some((item) => item.id === pendingDigestId(state.pending));
    if (!alreadyDigested) {
      for (const [id, match] of allMatchStates(state, tracker)) {
        if (match.exceptional && pending.has(hash(`${id}:${match.episode}`))) {
          addAlert(state, 'match', `${id}:${match.episode}`, at);
        }
      }
    }
    state.pending = [];
    state.digestAfter = null;
  } else if (state.pending.length && state.digestAfter && at >= state.digestAfter) {
    addAlert(state, 'digest', state.pending.slice().sort().join(':'), at, state.pending.length);
    state.pending = [];
    state.digestAfter = null;
  }
  return validateNotifications(state);
}

// Tracker metadata holds lifetime per-vacancy dedupe. The bounded outbox keeps
// pending obligations rather than accumulating every historically good job.
export function notificationsForAssessment(input, config, reviewed, at, { tracker } = {}) {
  const initial = structuredClone(validateNotifications(input));
  initial.alerts = initial.alerts.filter((item) => item.kind !== 'provider');
  const index = trackerReferences(tracker);
  for (const entry of tracker?.opportunities || []) {
    const id = hash(identityOf(entry));
    if (initial.matches[id]) {
      entry.notificationState = initial.matches[id];
      delete initial.matches[id];
    }
  }
  const state = flushNotificationDigest(initial, config, at, { tracker });
  const policy = workspaceModePolicy(config);
  const goodScore = Number(config.triage?.actionScore ?? 70);
  for (const item of reviewed || []) {
    const entry = index.get(item.vacancyId) || index.get(item.trackerId) || index.get(item.id) || index.get(item.sourceUrl);
    const id = hash(identityOf(item, entry));
    const supplied = entry?.notificationState || state.matches[id];
    const previous = tuple(supplied) ? supplied : { qualified: false, exceptional: false, episode: 0 };
    const kept = item.outcome === 'kept' && Number.isFinite(item.score);
    const qualified = kept && item.score >= goodScore;
    const exceptional = kept && item.score >= Math.max(95, goodScore);
    const notify = policy.mode === 'background' ? exceptional && !previous.exceptional : qualified && !previous.qualified;
    if (!qualified && !exceptional && !supplied) continue;
    const episode = previous.episode + Number(notify);
    const next = { qualified, exceptional, episode };
    if (entry) entry.notificationState = next;
    else {
      if (!Object.hasOwn(state.matches, id) && Object.keys(state.matches).length >= MAX_MATCHES) throw new Error('Notification match history needs review');
      state.matches[id] = next;
    }
    if (!notify) continue;
    if (policy.mode === 'background') addAlert(state, 'match', `${id}:${episode}`, at);
    else {
      const pendingId = hash(`${id}:${episode}`);
      if (!state.pending.includes(pendingId)) state.pending.push(pendingId);
      state.digestAfter ||= new Date(Date.parse(at) + policy.digestHours * 3_600_000).toISOString();
    }
  }
  state.providerEpisodes = {};
  return validateNotifications(state);
}

function readProviderState(root) {
  const state = readState(root, 'provider-notifications.json');
  if (state.alerts.length > MAX_PROVIDER_ALERTS || state.alerts.some((item) => item.kind !== 'provider')
    || Object.keys(state.matches).length || state.pending.length || state.digestAfter !== null) {
    throw new Error('provider notification storage has an unsupported schema');
  }
  const receipts = readReceipts(root);
  state.alerts = state.alerts.map((item) => ({ ...item, ...(receipts.receipts[item.id] || {}) }));
  return state;
}

function readProviderIntent(root, provider) {
  const value = readJson(root, `notification-pending-${provider}.json`);
  if (value === null) return null;
  if (!keys(value, ['schemaVersion', 'id', 'provider', 'events']) || value.schemaVersion !== 1
    || value.provider !== provider || !HASH.test(value.id) || !Array.isArray(value.events)
    || value.events.length < 1 || value.events.length > MAX_PROVIDER_ALERTS
    || value.events.some((item) => !keys(item, ['state', 'createdAt'])
      || !(BLOCKING.has(item.state) || item.state === 'ready') || !iso(item.createdAt))) {
    throw new Error('provider notification intent has an unsupported schema');
  }
  return value;
}

function providerEvent(record) {
  if (!record) return null;
  if (BLOCKING.has(record.state) && record.alert) return { state: record.state, createdAt: record.alert.createdAt };
  if (['ready', 'credentials-present-unverified'].includes(record.state) && record.remoteAuthBarrier !== true) {
    return { state: 'ready', createdAt: iso(record.checkedAt) ? record.checkedAt : new Date().toISOString() };
  }
  return null;
}

// The tiny intent is independent of match history. Its preparation is best
// effort: a notification error must never prevent authoritative health writes.
export function prepareProviderNotificationUnderFence(root, current, record) {
  const provider = record?.provider;
  if (!['codex', 'claude', 'local'].includes(provider)) throw new TypeError('notification provider is unsupported');
  const state = readProviderState(root);
  const existing = readProviderIntent(root, provider);
  const events = existing && state.providerEpisodes[provider]?.intentId !== existing.id
    ? existing.events.slice() : [];
  for (const value of [current, record]) {
    const event = providerEvent(value);
    if (event && events.at(-1)?.state !== event.state) events.push(event);
  }
  if (!events.length) return;
  // Superseded transitions are historical; retain the oldest unreported event
  // and newest state when an unavailable notification store spans many changes.
  while (events.length > MAX_PROVIDER_ALERTS) events.splice(BLOCKING.has(events[0].state) ? 1 : 0, 1);
  const unchanged = existing && JSON.stringify(events) === JSON.stringify(existing.events)
    && state.providerEpisodes[provider]?.intentId !== existing.id;
  const intent = { schemaVersion: 1, id: unchanged ? existing.id : hash(randomUUID()), provider, events };
  persistJson(root, `notification-pending-${provider}.json`, intent);
}

export function publishProviderNotificationIntentUnderFence(root, provider) {
  if (!['codex', 'claude', 'local'].includes(provider)) throw new TypeError('notification provider is unsupported');
  const intent = readProviderIntent(root, provider);
  if (!intent) return;
  const state = readProviderState(root);
  let previous = state.providerEpisodes[provider] || { state: null, episode: 0, intentId: null };
  if (previous.intentId !== intent.id) {
    for (const event of intent.events) {
      if (event.state === 'ready') previous = { ...previous, state: null };
      else if (previous.state !== event.state) {
        previous = { state: event.state, episode: previous.episode + 1, intentId: previous.intentId };
        state.providerEpisodes[provider] = previous;
        addAlert(state, 'provider', `${provider}:${previous.episode}`, event.createdAt, 1, provider);
      }
    }
    state.providerEpisodes[provider] = { ...previous, intentId: intent.id };
    validateNotifications(state);
    persistJson(root, 'provider-notifications.json', state);
  }
  fs.rmSync(fileAt(root, `notification-pending-${provider}.json`), { force: true });
}

// Public producer for callers already holding the current workspace fence.
export function enqueueProviderNotificationUnderFence(root, record) {
  prepareProviderNotificationUnderFence(root, null, record);
  publishProviderNotificationIntentUnderFence(root, record.provider);
}

function loadNotificationTracker(root) {
  const file = validatePhysicalWorkspacePath(root, path.join(root, 'data', 'opportunities.json'), 'notification tracker');
  if (!fs.existsSync(file)) return { opportunities: [] };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Notification tracker could not be read'); }
}

export function markNotification(root, id, action, at = new Date().toISOString()) {
  if (!HASH.test(String(id)) || !['delivered', 'acknowledged'].includes(action) || !iso(at)) throw new TypeError('notification request is invalid');
  return withWorkspaceMutationAuthority(root, { kind: 'notifications', phase: action }, () => {
    const state = readNotifications(root);
    if (!state.alerts.some((item) => item.id === id)) throw new Error('notification is unavailable');
    const base = readState(root);
    const runtime = readRuntime(root).state;
    const providerState = readProviderState(root);
    const retained = new Set([...base.alerts, ...runtime.alerts, ...providerState.alerts].map((item) => item.id));
    retained.add(pendingDigestId(base.pending));
    const pending = new Set(base.pending);
    for (const [matchId, match] of allMatchStates(base, loadNotificationTracker(root))) {
      if (pending.has(hash(`${matchId}:${match.episode}`))) retained.add(hash(`match:${matchId}:${match.episode}`));
    }
    const receipts = readReceipts(root);
    receipts.receipts = Object.fromEntries(Object.entries(receipts.receipts).filter(([key]) => retained.has(key)));
    receipts.receipts[id] ||= { deliveredAt: null, acknowledgedAt: null };
    const field = action === 'delivered' ? 'deliveredAt' : 'acknowledgedAt';
    receipts.receipts[id][field] ||= at;
    persistJson(root, 'notification-receipts.json', receipts);
    return notificationView(readNotifications(root));
  });
}

export function refreshNotificationDigest(root, config, at = new Date().toISOString()) {
  return withWorkspaceMutationAuthority(root, { kind: 'notifications', phase: 'digest' }, () => {
    for (const provider of ['codex', 'claude', 'local']) publishProviderNotificationIntentUnderFence(root, provider);
    const current = readNotifications(root);
    const next = flushNotificationDigest(current, config, at, { tracker: loadNotificationTracker(root) });
    const known = new Set(current.alerts.map((item) => item.id));
    const added = next.alerts.filter((item) => !known.has(item.id));
    const remaining = new Set(next.pending);
    const consumed = current.pending.filter((id) => !remaining.has(id));
    if (added.length || consumed.length) {
      const runtime = readRuntime(root);
      for (const item of added) {
        runtime.state.alerts.push(item);
        trimAcknowledged(runtime.state.alerts);
      }
      runtime.consumedPending.push(...consumed);
      persistRuntime(root, runtime);
    }
    return notificationView(readNotifications(root));
  });
}

export function notificationView(input) {
  const state = validateNotifications(input);
  const activeProviderIds = new Set(Object.entries(state.providerEpisodes).filter(([, value]) => value.state !== null)
    .map(([name, value]) => hash(`provider:${name}:${value.episode}`)));
  const view = (item) => ({
    ...item,
    title: item.kind === 'provider' ? `${({ codex: 'Codex', claude: 'Claude', local: 'Local model' })[item.provider]} provider warning`
      : item.kind === 'digest' ? 'Your daily Scout matches' : 'An exceptional match is ready',
    body: item.kind === 'provider' ? 'A provider problem was recorded. Open Scout to review its current state and any missed work.'
      : item.kind === 'digest' ? `${item.count} new match${item.count === 1 ? '' : 'es'} to review. Your feedback helps Scout learn what matters.`
        : 'Open Scout to review a newly assessed exceptional match.',
  });
  return {
    alerts: state.alerts.filter((item) => item.acknowledgedAt === null).map(view),
    outbox: state.alerts.filter((item) => item.deliveredAt === null && item.acknowledgedAt === null)
      .sort((left, right) => Number(activeProviderIds.has(right.id)) - Number(activeProviderIds.has(left.id))
        || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)).map(view),
  };
}
