import fs from 'node:fs';
import path from 'node:path';

const FIVE_HOURS = 5 * 3600 * 1000;
const WEEK = 7 * 24 * 3600 * 1000;

export function claudeUsageFromLines(lines, nowMs = Date.now()) {
  let fiveHourTokens = 0;
  let weekTokens = 0;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const usage = e && e.message && e.message.usage;
    if (!usage || !e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || nowMs - t > WEEK || t > nowMs) continue;
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    weekTokens += tokens;
    if (nowMs - t <= FIVE_HOURS) fiveHourTokens += tokens;
  }
  return { fiveHourTokens, weekTokens, approximate: true };
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

export function codexUsageFromLines(lines) {
  let latest = null;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const rl = findRateLimits(e);
    if (rl) latest = rl;
  }
  if (!latest) return { unknown: true };
  const win = (w) => (w && typeof w.used_percent === 'number')
    ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes ?? null, resetsInSeconds: w.resets_in_seconds ?? null }
    : null;
  return { primary: win(latest.primary), secondary: win(latest.secondary), approximate: true };
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
    const u = codexUsageFromLines(readLines(f.path));
    if (!u.unknown) { codex = u; break; }
  }
  return { claude, codex, checkedAt: new Date(nowMs).toISOString() };
}
