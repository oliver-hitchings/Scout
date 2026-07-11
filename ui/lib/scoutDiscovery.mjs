export function strongUnseenMatches(entries, threshold, acknowledged = []) {
  const seen = new Set(acknowledged || []);
  return (entries || []).filter((entry) => entry.status === 'new'
    && Number.isFinite(entry.score)
    && entry.score >= threshold
    && !seen.has(entry.id));
}

export function discoveryStorageKey(workspaceIdentity = 'default') {
  let hash = 2166136261;
  for (const char of String(workspaceIdentity)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `scout.discoveries.${(hash >>> 0).toString(36)}.v1`;
}

export function mergeAcknowledged(current, entries) {
  return [...new Set([...(current || []), ...(entries || []).map((entry) => entry.id).filter(Boolean)])];
}
