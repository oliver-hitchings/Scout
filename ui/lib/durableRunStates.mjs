// The durable scan run-state vocabulary lives here so the server projection and
// the browser UI cannot drift apart. The UI refuses a durable state it does not
// recognise instead of guessing, so a new state must be published in one place.
//
// `retrying` means a single failed assessment job is being retried on its own.
// `recovered` means the run resumed compatible durable work after a recovery.
// Both are distinct from `repairing` (a malformed batch is being repaired) and
// from the terminal outcomes.

export const DURABLE_RUN_STATES = new Set([
  'collecting', 'normalising', 'deduplicating', 'filtering', 'ranking', 'selecting',
  'assessing', 'repairing', 'retrying', 'recovered', 'updating-tracker',
  'writing-report', 'finalising', 'partial', 'abandoned', 'failed', 'complete',
]);

export const TERMINAL_RUN_STATES = new Set(['partial', 'abandoned', 'failed', 'complete']);

export const RUN_STATE_LABELS = Object.freeze({
  waiting: 'Waiting to scan',
  collecting: 'Collecting vacancies',
  normalising: 'Normalising vacancies',
  deduplicating: 'Deduplicating vacancies',
  filtering: 'Filtering confirmed exclusions',
  ranking: 'Ranking eligible vacancies',
  selecting: 'Selecting vacancies for assessment',
  assessing: 'Assessing selected vacancies',
  repairing: 'Repairing affected jobs',
  retrying: 'Retrying failed job',
  recovered: 'Recovered compatible work',
  'updating-tracker': 'Updating tracker',
  'writing-report': 'Writing report',
  finalising: 'Finalising scan',
  partial: 'Scan partially completed',
  abandoned: 'Scan abandoned',
  failed: 'Scan failed',
  complete: 'Scan complete',
});
