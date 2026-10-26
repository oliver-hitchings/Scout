import { readProviderHealth } from './providerHealth.mjs';

const BLOCKED_REASON = 'sign-in-required';
const blockedBySignIn = (run) => run?.state === 'abandoned' && run.terminalReason === BLOCKED_REASON;

// What the dashboard banner needs: providers whose session has expired, plus
// providers that are signed in again while a scan they blocked is still
// unrun. `runs` is readPublicRunSummaries().runs, newest first.
export function providerRecoveryView(root, config, runs = [], read = readProviderHealth) {
  const jobs = (config?.schedule?.jobs || []).filter((job) => job?.enabled === true);
  const providers = new Set([config?.ai?.provider, ...jobs.map((job) => job.provider)]);
  const view = [];
  for (const provider of ['codex', 'claude', 'local']) {
    if (!providers.has(provider)) continue;
    let record;
    try { record = read(root, provider); } catch { continue; }
    const own = runs.filter((run) => run.provider === provider);
    const providerJobs = jobs.filter((job) => job.provider === provider);
    const missedJobIds = providerJobs
      .filter((job) => blockedBySignIn(own.find((run) => run.scheduleJobId === job.id)))
      .map((job) => job.id);
    // Only the newest run counts: a later success means nothing is waiting.
    const manualBlocked = own[0]?.scheduleJobId === null && blockedBySignIn(own[0]);
    const signInRequired = record.state === 'sign-in-required';
    const signedIn = ['ready', 'credentials-present-unverified'].includes(record.state)
      && !record.remoteAuthBarrier && record.checkedAt !== null;
    if (!signInRequired && !(signedIn && (missedJobIds.length || manualBlocked))) continue;
    view.push({
      provider,
      signInRequired,
      alertId: record.alert?.id ?? null,
      acknowledged: record.alert?.acknowledgedAt != null,
      jobs: providerJobs.map(({ id, time, mode }) => ({ id, time, mode })),
      missedJobIds,
      manualBlocked,
    });
  }
  return view;
}
