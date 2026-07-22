const DEFAULT_LOW_SECONDS = 5 * 60;
const DEFAULT_HIGH_SECONDS = 10 * 60;

function durationSeconds(run) {
  const started = Date.parse(run?.started_at || run?.startedAt || '');
  const finished = Date.parse(run?.timestamp || run?.finishedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) return null;
  const seconds = Math.round((finished - started) / 1000);
  return seconds >= 30 && seconds <= 60 * 60 ? seconds : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function scanEstimate(runs = [], provider, mode = 'primary') {
  const durations = runs.filter((run) => run?.agent === provider && run?.mode === mode
    && !run?.skipped && !run?.degraded && !(run?.errors || []).length)
    .map(durationSeconds).filter(Number.isFinite).slice(-10);
  if (!durations.length) {
    return { basis: 'default', sampleSize: 0, totalSecondsLow: DEFAULT_LOW_SECONDS, totalSecondsHigh: DEFAULT_HIGH_SECONDS };
  }
  const typical = median(durations);
  const low = Math.max(60, Math.floor(typical * 0.8));
  const high = Math.max(low + 60, Math.ceil(typical * 1.2));
  return { basis: 'history', sampleSize: durations.length, totalSecondsLow: low, totalSecondsHigh: high };
}

export function scanRemainingText(operation, now = Date.now()) {
  const estimate = operation?.estimate;
  const started = Date.parse(operation?.startedAt || '');
  if (!estimate || !Number.isFinite(started)) return '';
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const low = Math.max(0, Number(estimate.totalSecondsLow || 0) - elapsed);
  const high = Math.max(0, Number(estimate.totalSecondsHigh || 0) - elapsed);
  if (elapsed > Number(estimate.totalSecondsHigh || 0)) {
    const range = `${Math.max(1, Math.ceil(estimate.totalSecondsLow / 60))}–${Math.max(1, Math.ceil(estimate.totalSecondsHigh / 60))} min`;
    return `Taking longer than the recent ${range} range — Scout is still working`;
  }
  const lowMinutes = Math.max(0, Math.floor(low / 60));
  const highMinutes = Math.max(1, Math.ceil(high / 60));
  return lowMinutes < 1 ? `About ${highMinutes} min or less remaining` : `About ${lowMinutes}–${highMinutes} min remaining`;
}
