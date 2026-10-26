import { workspaceModePolicy } from './workspaceMode.mjs';

// Versioned, deliberately small projection for the owner's local dashboard.
// Never spread tracker, profile, scan errors or provider records into this API.
export const HOME_SUMMARY_SCHEMA_VERSION = 1;
const STATES = new Set(['checking', 'ready', 'credentials-present-unverified', 'sign-in-required', 'login-in-progress', 'network-unavailable', 'rate-limited', 'cli-update-required', 'provider-error']);
const bounded = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
const time = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
function link(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = ''; url.hash = '';
    return url.href.length <= 2000 ? url.href : null;
  } catch { return null; }
}

export function buildHomeSummary({ config = {}, tracker = {}, scanHealth = {}, providers = [], notifications = { alerts: [] }, now = new Date() } = {}) {
  const policy = workspaceModePolicy(config);
  const mode = policy.mode;
  const threshold = policy.triage.actionScore;
  const matches = (tracker.opportunities || []).filter((item) => ['new', 'shortlist'].includes(item.status)
    && Number.isFinite(item.score) && item.score >= threshold).map((item) => ({
    id: bounded(item.id, 160), title: bounded(item.role || item.title), employer: bounded(item.company || item.employer),
    score: item.score, link: link(item.url || item.link || item.sources?.[0]), firstSeen: time(item.firstSeen || item.firstSeenAt),
  })).filter((item) => item.id).sort((a, b) => b.score - a.score || String(b.firstSeen).localeCompare(String(a.firstSeen)) || a.id.localeCompare(b.id));
  const alerts = (notifications.alerts || []).filter((item) => !item.acknowledgedAt).map((item) => ({
    id: bounded(item.id, 64), kind: ['match', 'digest', 'provider'].includes(item.kind) ? item.kind : 'provider',
    provider: ['codex', 'claude', 'local'].includes(item.provider) ? item.provider : null,
    count: Number.isSafeInteger(item.count) && item.count > 0 ? Math.min(item.count, 10000) : 1,
    createdAt: time(item.createdAt), delivered: Boolean(item.deliveredAt),
  }));
  if (alerts.length > 1064) throw new Error('notification projection exceeds its storage boundary');
  return {
    schemaVersion: HOME_SUMMARY_SCHEMA_VERSION, generatedAt: now.toISOString(), mode,
    scanHealth: {
      healthy: scanHealth.healthy === true, stale: scanHealth.stale !== false,
      degraded: scanHealth.degraded === true, lastRunAt: time(scanHealth.lastRunAt),
    },
    providers: providers.filter((item) => ['codex', 'claude', 'local'].includes(item.provider)).map((item) => ({
      provider: item.provider, state: STATES.has(item.state) ? item.state : 'provider-error', checkedAt: time(item.checkedAt),
    })),
    threshold, newMatchCount: matches.length, matchesTruncated: matches.length > 200, newMatches: matches.slice(0, 200),
    pendingAlertCount: alerts.length, pendingAlerts: alerts,
  };
}
