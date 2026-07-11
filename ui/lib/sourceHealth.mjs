export function withSourceStatus(result = {}, { unavailableReason = null } = {}) {
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const available = result.available !== false;
  const status = !available ? 'unavailable' : errors.length ? 'degraded' : 'healthy';
  return {
    ...result,
    status,
    count: jobs.length,
    reason: result.reason || (!available ? (result.note || unavailableReason) : errors.length ? errors[0] : null),
  };
}
