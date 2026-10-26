import { classifyVacancyChange } from './vacancyCanonical.mjs';
import { jobIdentity, sameUnderlyingJob } from './jobIdentity.mjs';

const REJECTED_OUTCOMES = new Set([
  'rejected',
  'ignore',
  'below_threshold',
  'provider_discarded',
  'mandatory_unmet',
  'hard_exclusion',
]);

export function normaliseVacancyOutcome(value) {
  const supplied = String(value || '').trim().toLowerCase();
  const canonical = supplied.replaceAll('-', '_');
  return REJECTED_OUTCOMES.has(canonical) ? canonical : supplied;
}

export function rejected(previous) {
  return REJECTED_OUTCOMES.has(normaliseVacancyOutcome(previous?.outcome || previous?.status));
}

// A changed prompt, schema or model can overturn an earlier rejection, but re-testing every rejection at once would
// flood assessment capacity (60 jobs by default), so only the strongest few per scan are let through.
export const ASSESSMENT_CHANGE_REASSESS_LIMIT = 6;
// The key names match the scan compatibility record, and avoid `prompt`, which the privacy projection strips.
const ASSESSMENT_VERSION_KEYS = ['promptVersion', 'assessmentSchemaVersion', 'provider', 'model'];

// The compact assessment version stored with each scan's decisions.
export function assessmentVersionOf(compatibility) {
  const version = Object.fromEntries(ASSESSMENT_VERSION_KEYS.map((key) => [key, compatibility?.[key]]));
  return Object.values(version).every((value) => value !== undefined && value !== null && value !== '') ? version : null;
}

// shortcut: a decision recorded before versions were stored has no version to compare, so it is never re-assessed
// for an assessment change; it is assessed again as soon as its advert, the profile or the learning version changes.
function assessmentVersionChanged(previous, current) {
  return Boolean(previous && current
    && ASSESSMENT_VERSION_KEYS.some((key) => String(previous[key]) !== String(current[key])));
}

export function decideVacancyLifecycle(previous, current, {
  profileId = null,
  learningVersionId = null,
  scoringChanged: scoringChangedOption = false,
  assessmentChanged = false,
} = {}) {
  // A different published learning version can re-rank a vacancy even when its advert and profile are unchanged.
  const scoringChanged = scoringChangedOption || Boolean(
    learningVersionId && previous?.learningVersionId
      && String(learningVersionId) !== String(previous.learningVersionId),
  );
  if (!previous) {
    return {
      change: 'new',
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: 'new-vacancy',
    };
  }

  const change = classifyVacancyChange(previous, current);
  if (change === 'reopened' || change === 'material') {
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: change === 'reopened' ? 'reopened-vacancy' : 'material-change',
    };
  }

  const profileChanged = Boolean(
    profileId && previous.profileId && String(profileId) !== String(previous.profileId),
  );
  const legacyProfile = Boolean(profileId && !previous.profileId);
  if (legacyProfile) {
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: 'legacy-profile-rerank',
    };
  }
  if (profileChanged) {
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: 'profile-change',
    };
  }

  if (assessmentChanged) {
    return {
      change,
      revalidate: true,
      rerank: scoringChanged,
      reassess: true,
      skipAssessment: false,
      reason: 'assessment-change',
    };
  }

  if (scoringChanged) {
    const skipAssessment = rejected(previous);
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: !skipAssessment,
      skipAssessment,
      reason: 'scoring-change',
    };
  }

  const skipAssessment = rejected(previous);
  return {
    change,
    revalidate: true,
    rerank: false,
    reassess: !skipAssessment,
    skipAssessment,
    reason: skipAssessment ? 'unchanged-rejection' : 'unchanged-prior-assessment',
  };
}

// sameUnderlyingJob is true only for a shared URL, a shared source and provider ID, or the same employer, so
// those keys select every candidate worth comparing and a long rejection history stays cheap to search.
function identityKeys(job) {
  const { company, references } = jobIdentity(job);
  return [
    company && `company:${company}`,
    ...references.flatMap(({ url, source, providerId }) => [
      url && `url:${url}`, source && providerId && `ref:${source}|${providerId}`,
    ]),
  ].filter(Boolean);
}

function previousDecisionLookup(history) {
  const entries = history || [];
  const index = new Map();
  entries.forEach((entry, position) => {
    for (const key of identityKeys(entry)) {
      if (index.has(key)) index.get(key).push(position);
      else index.set(key, [position]);
    }
  });
  return (vacancy) => {
    const positions = [...new Set(identityKeys(vacancy).flatMap((key) => index.get(key) || []))]
      .sort((left, right) => left - right);
    const match = positions.find((position) => sameUnderlyingJob(entries[position], vacancy));
    return match === undefined ? null : entries[match];
  };
}

export function partitionVacanciesForAssessment(ranked, history, options = {}) {
  const { assessmentVersion = null, assessmentChangeLimit = ASSESSMENT_CHANGE_REASSESS_LIMIT, ...lifecycleOptions } = options;
  const previousDecision = previousDecisionLookup(history);
  const decided = (ranked || []).map((vacancy) => {
    const previous = previousDecision(vacancy);
    const assessmentChanged = assessmentVersionChanged(previous?.assessmentVersion, assessmentVersion);
    const lifecycle = decideVacancyLifecycle(previous, vacancy, { ...lifecycleOptions, assessmentChanged });
    // Only a rejection that would otherwise be skipped is rate limited: anything else is assessed anyway.
    return { vacancy, lifecycle, retest: assessmentChanged && lifecycle.reason === 'assessment-change' && rejected(previous) };
  });
  const admitted = new Set(decided.filter(({ retest }) => retest)
    .sort((left, right) => (Number(right.vacancy.preRankScore) || 0) - (Number(left.vacancy.preRankScore) || 0)
      || String(left.vacancy.vacancyId).localeCompare(String(right.vacancy.vacancyId)))
    .slice(0, Math.max(0, assessmentChangeLimit)));
  const eligible = [];
  const skipped = [];
  for (const item of decided) {
    const deferred = item.retest && !admitted.has(item);
    const lifecycle = deferred
      ? { ...item.lifecycle, reassess: false, skipAssessment: true, reason: 'assessment-change-deferred' }
      : item.lifecycle;
    const annotated = { ...item.vacancy, lifecycle };
    if (lifecycle.skipAssessment) skipped.push(annotated);
    else eligible.push(annotated);
  }
  return { eligible, skipped };
}

// One compact record per vacancy that has an earlier decision, so a report can say why it was skipped, revalidated,
// re-ranked or reassessed. New vacancies are left out: they are most of a first scan and the stage artifact has a size limit.
export function lifecycleRecords({ eligible = [], skipped = [] } = {}) {
  return [...eligible, ...skipped].filter(({ lifecycle }) => lifecycle.reason !== 'new-vacancy')
    .map(({ vacancyId, lifecycle }) => ({ vacancyId, change: lifecycle.change, reason: lifecycle.reason }));
}
