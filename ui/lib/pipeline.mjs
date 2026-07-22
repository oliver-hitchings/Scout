import { daysBetween, followUpsDue, triage } from './derive.mjs';
import { currentStage, isInterviewStage, lastCompletedStage, stagesOf } from './tracker.mjs';

const ACTIVE_STATUSES = ['outreach', 'applied', 'interviewing'];
const OPEN_STATUSES = ['new', 'watch'];
const CLOSED_STATUSES = ['accepted', 'rejected', 'ignore'];

function latestDate(dates) {
  return dates.filter(Boolean).sort().at(-1) || null;
}

export function applicationSummary(entry, today, policy = {}) {
  const stages = stagesOf(entry);
  const completed = lastCompletedStage(entry);
  const appliedDate = entry.application?.appliedDate || null;
  const rejectedDate = entry.application?.rejectedDate || null;
  const logDate = latestDate((entry.log || []).map((l) => l.date));
  const stageDate = latestDate(stages.map((s) => s.date));
  const trackerCheckDate = ['new', 'watch'].includes(entry.status) ? entry.lastChecked : null;
  const lastMovementDate = latestDate([rejectedDate, stageDate, logDate, appliedDate, trackerCheckDate]);
  const current = currentStage(entry);
  return {
    id: entry.id,
    company: entry.company,
    role: entry.role,
    status: entry.status,
    score: entry.score,
    currentStage: current,
    lastCompletedStage: completed ? completed.name : null,
    appliedDate,
    rejectedDate,
    lastMovementDate,
    daysSinceApplied: appliedDate ? daysBetween(appliedDate, today) : null,
    daysSinceLastMovement: lastMovementDate ? daysBetween(lastMovementDate, today) : null,
    needsInterviewPrep: current ? isInterviewStage(current) : false,
    followUps: followUpsDue(entry, today, policy),
  };
}

function byScoreThenMovement(a, b) {
  const scoreA = typeof a.score === 'number' ? a.score : -1;
  const scoreB = typeof b.score === 'number' ? b.score : -1;
  if (scoreA !== scoreB) return scoreB - scoreA;
  return String(b.lastMovementDate || '').localeCompare(String(a.lastMovementDate || ''));
}

export function pipeline(data, today, policy = {}) {
  const staleDays = Number(policy.staleDays ?? 10);
  const decisionDays = Number(policy.decisionDays ?? 2);
  const summaries = (data.opportunities || []).map((entry) => applicationSummary(entry, today, policy));
  const byStatus = {};
  for (const item of summaries) byStatus[item.status] = (byStatus[item.status] || 0) + 1;

  const newItems = summaries
    .filter((item) => item.status === 'new')
    .sort(byScoreThenMovement);
  const watch = summaries
    .filter((item) => item.status === 'watch')
    .sort(byScoreThenMovement);
  const active = summaries
    .filter((item) => ACTIVE_STATUSES.includes(item.status))
    .sort((a, b) => String(b.lastMovementDate || '').localeCompare(String(a.lastMovementDate || '')));
  const awaitingDecision = summaries
    .filter((item) => OPEN_STATUSES.includes(item.status))
    .sort(byScoreThenMovement);
  const recentlyClosed = summaries
    .filter((item) => CLOSED_STATUSES.includes(item.status))
    .sort((a, b) => String(b.rejectedDate || b.lastMovementDate || '').localeCompare(String(a.rejectedDate || a.lastMovementDate || '')));

  const flags = [];
  for (const item of summaries) {
    if (item.followUps.length) {
      flags.push({
        id: item.id,
        company: item.company,
        role: item.role,
        kind: item.followUps[0].kind === 'nudge' ? 'nudge' : 'closeout',
        detail: `follow-up due since ${item.followUps[0].since}`,
      });
    }
    if (item.needsInterviewPrep) {
      flags.push({
        id: item.id,
        company: item.company,
        role: item.role,
        kind: 'interview-prep',
        detail: `prep for ${item.currentStage}`,
      });
    }
    if (ACTIVE_STATUSES.includes(item.status) && item.daysSinceLastMovement !== null && item.daysSinceLastMovement >= staleDays) {
      flags.push({
        id: item.id,
        company: item.company,
        role: item.role,
        kind: 'stale',
        detail: `${item.daysSinceLastMovement} days since movement`,
      });
    }
    if (item.status === 'new' && item.daysSinceLastMovement !== null && item.daysSinceLastMovement >= decisionDays) {
      flags.push({
        id: item.id,
        company: item.company,
        role: item.role,
        kind: 'decision',
        detail: 'new item awaiting triage',
      });
    }
  }

  return {
    summary: {
      total: summaries.length,
      byStatus,
      new: newItems.length,
      watch: watch.length,
      active: active.length,
      awaitingDecision: awaitingDecision.length,
      recentlyClosed: recentlyClosed.length,
      flags: flags.length,
    },
    new: newItems,
    watch,
    active,
    awaitingDecision,
    recentlyClosed,
    flags,
  };
}

// A workspace that has not been created yet must still answer /api/opportunities
// with exactly the shape a populated workspace returns. Deriving it from the
// same functions keeps the two branches from drifting apart: a hand-written
// literal previously omitted pipeline.flags, which crashed the dashboard on
// every fresh install.
export function emptyTrackerView(today, policy = {}) {
  const data = { updated: today, opportunities: [] };
  return {
    ...data,
    triage: triage(data, today, policy),
    pipeline: pipeline(data, today, policy),
  };
}
