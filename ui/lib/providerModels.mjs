// Models Scout offers when choosing an engine for a conversation.
//
// The list is deliberately three sources merged: a short curated set, whatever
// the local provider logs show you have actually used, and the model already
// saved in settings. A curated list alone goes stale the day a provider ships a
// new model; detection alone is empty on a fresh install.
//
// Codex has neither a curated list nor detection, on purpose. Scout cannot
// verify OpenAI model identifiers, and its session logs record collaboration-mode
// names in the same `model` field as base models — offering those would produce a
// choice that fails at send time, after the person has composed their message.
// Codex therefore offers the provider default plus free text.
const CURATED = Object.freeze({
  claude: Object.freeze([
    { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
  ]),
  codex: Object.freeze([]),
});

const SAFE_MODEL = /^[A-Za-z0-9._:-]+$/;

export function isSafeModelId(value) {
  return SAFE_MODEL.test(String(value || ''));
}

function label(id, curated) {
  return curated.find((model) => model.id === id)?.label || id;
}

// `detected` comes from the local usage logs; `configured` is the settings default.
export function providerModels(provider, { detected = [], configured = null } = {}) {
  const curated = CURATED[provider] || [];
  const ids = [
    ...curated.map((model) => model.id),
    ...detected.map((value) => String(value || '').trim()),
    ...(configured ? [String(configured).trim()] : []),
  ].filter((id) => id && isSafeModelId(id));
  return [...new Set(ids)].map((id) => ({
    id,
    label: label(id, curated),
    detected: detected.includes(id),
  }));
}

// Models seen in this machine's own Claude logs, heaviest usage first. These are
// real model identifiers taken from each turn's `message.model`.
export function detectedModels(usage = {}) {
  const claude = (usage.claude?.byModel || []).map((entry) => entry.model);
  return { claude: [...new Set(claude.filter(isSafeModelId))], codex: [] };
}
