import fs from 'node:fs';
import path from 'node:path';

const FIVE_HOURS = 5 * 3600 * 1000;
const WEEK = 7 * 24 * 3600 * 1000;

export function claudeUsageFromLines(lines, nowMs = Date.now()) {
  let fiveHourTokens = 0;
  let weekTokens = 0;
  // Claude's limits are account-wide, so these totals are headroom. The per-model
  // split is spend only: the logs record which model produced each turn, but not
  // any per-model ceiling, so it must never be presented as remaining quota.
  const byModel = new Map();
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const usage = e && e.message && e.message.usage;
    if (!usage || !e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || nowMs - t > WEEK || t > nowMs) continue;
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    weekTokens += tokens;
    const recent = nowMs - t <= FIVE_HOURS;
    if (recent) fiveHourTokens += tokens;
    const model = String(e.message.model || '').trim();
    if (!model) continue;
    const entry = byModel.get(model) || { model, fiveHourTokens: 0, weekTokens: 0 };
    entry.weekTokens += tokens;
    if (recent) entry.fiveHourTokens += tokens;
    byModel.set(model, entry);
  }
  return {
    fiveHourTokens,
    weekTokens,
    byModel: [...byModel.values()].sort((a, b) => b.weekTokens - a.weekTokens),
    approximate: true,
  };
}

function findRateLimits(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  if (obj.rate_limits && typeof obj.rate_limits === 'object') return obj.rate_limits;
  for (const v of Object.values(obj)) {
    const found = findRateLimits(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// Codex reports each limit window with its own length. Treating `primary` as the
// five-hour window mislabels accounts whose primary window is weekly, which reads
// as "100% of your 5h used" when it means the weekly allowance.
export function windowLabel(windowMinutes) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 'current window';
  if (minutes % (60 * 24 * 7) === 0) {
    const weeks = minutes / (60 * 24 * 7);
    return weeks === 1 ? 'weekly' : `${weeks}-weekly`;
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? 'daily' : `${days}-day`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function codexUsageFromLines(lines, nowMs = Date.now()) {
  let latest = null;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const rl = findRateLimits(e);
    if (rl) latest = rl;
  }
  if (!latest) return { unknown: true };
  const win = (w) => {
    if (!w || typeof w.used_percent !== 'number') return null;
    const resetsInSeconds = Number.isFinite(Number(w.resets_in_seconds)) ? Number(w.resets_in_seconds) : null;
    return {
      usedPercent: w.used_percent,
      windowMinutes: w.window_minutes ?? null,
      label: windowLabel(w.window_minutes),
      resetsInSeconds,
      resetsAt: resetsInSeconds === null ? null : new Date(nowMs + resetsInSeconds * 1000).toISOString(),
    };
  };
  const windows = [win(latest.primary), win(latest.secondary)].filter(Boolean);
  return {
    primary: win(latest.primary),
    secondary: win(latest.secondary),
    windows,
    planType: latest.plan_type || null,
    credits: latest.credits ?? null,
    approximate: true,
  };
}

function jsonlFilesUnder(dir, sinceMs) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs });
        } catch { /* skip unreadable file */ }
      }
    }
  };
  walk(dir);
  return out;
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

export function readUsage(homeDir, nowMs = Date.now()) {
  const since = nowMs - WEEK;
  const claudeFiles = jsonlFilesUnder(path.join(homeDir, '.claude', 'projects'), since);
  const claude = claudeFiles.length
    ? claudeUsageFromLines(claudeFiles.flatMap((f) => readLines(f.path)), nowMs)
    : { unknown: true };
  const codexFiles = jsonlFilesUnder(path.join(homeDir, '.codex', 'sessions'), since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let codex = { unknown: true };
  for (const f of codexFiles.slice(0, 5)) {
    const u = codexUsageFromLines(readLines(f.path), nowMs);
    if (!u.unknown) { codex = u; break; }
  }
  return { claude, codex, checkedAt: new Date(nowMs).toISOString() };
}
