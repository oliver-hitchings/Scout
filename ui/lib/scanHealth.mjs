export function parseScanRuns(text) {
  const runs = [];
  const errors = [];
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      runs.push(JSON.parse(line));
    } catch (e) {
      errors.push({ line: index + 1, error: e.message });
    }
  }
  return { runs, errors };
}

export function scanHealthFromText(text, today) {
  const parsed = parseScanRuns(text);
  const last = parsed.runs.at(-1) || null;
  if (!last) {
    return {
      lastRunAt: null,
      healthy: false,
      stale: true,
      degraded: false,
      reason: parsed.errors.length ? 'scan log contains invalid JSON' : 'no scan runs recorded yet',
      runs: 0,
      parseErrors: parsed.errors,
    };
  }

  const lastDate = String(last.timestamp || '').slice(0, 10);
  const stale = lastDate !== today;
  const runErrors = Array.isArray(last.errors) ? last.errors : [];
  const degraded = Boolean(last.search_degraded || last.degraded);
  const healthy = !stale && !degraded && runErrors.length === 0 && parsed.errors.length === 0;
  let reason = null;
  if (stale) reason = `no run recorded for ${today}`;
  else if (degraded) reason = 'last scan was degraded';
  else if (runErrors.length) reason = runErrors.join('; ');
  else if (parsed.errors.length) reason = 'scan log contains invalid JSON';

  return {
    lastRunAt: last.timestamp || null,
    healthy,
    stale,
    degraded,
    reason,
    sourcesChecked: last.sources_checked || last.sourcesChecked || [],
    atsPortalsChecked: last.ats_portals_checked || last.atsPortalsChecked || 0,
    candidatesFound: last.candidates_found ?? last.candidatesFound ?? null,
    keepersAdded: last.keepers_added ?? last.keepersAdded ?? null,
    discarded: last.discarded || {},
    errors: runErrors,
    runs: parsed.runs.length,
    parseErrors: parsed.errors,
    raw: last,
  };
}

