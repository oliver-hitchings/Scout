import assert from 'node:assert/strict';
import test from 'node:test';
import { sameUnderlyingJob } from './jobIdentity.mjs';
import { vacancyContentFingerprint } from './vacancyCanonical.mjs';
import {
  ASSESSMENT_CHANGE_REASSESS_LIMIT, assessmentVersionOf, decideVacancyLifecycle, lifecycleRecords, partitionVacanciesForAssessment,
} from './vacancyLifecycle.mjs';

const vacancy = {
  vacancyId: 'vacancy-1',
  title: { value: 'Platform Engineer', provenance: 'explicit-source' },
  employer: { value: 'Acme', provenance: 'explicit-source' },
  location: { value: 'London', provenance: 'explicit-source' },
  description: 'Operate reliable services and improve production resilience.',
};

test('new and materially changed vacancies are revalidated, re-ranked and assessed', () => {
  assert.deepEqual(decideVacancyLifecycle(null, vacancy), {
    change: 'new',
    revalidate: true,
    rerank: true,
    reassess: true,
    skipAssessment: false,
    reason: 'new-vacancy',
  });

  const previous = {
    ...vacancy,
    description: 'Maintain the existing service.',
    outcome: 'provider_discarded',
    profileId: 'profile-old',
  };
  const decision = decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-old' });
  assert.equal(decision.change, 'material');
  assert.equal(decision.reassess, true);
  assert.equal(decision.skipAssessment, false);
  assert.equal(decision.reason, 'material-change');
});

test('an unchanged rejected vacancy is revalidated but does not consume assessment capacity', () => {
  const previous = {
    ...vacancy,
    outcome: 'below_threshold',
    profileId: 'profile-current',
  };
  assert.deepEqual(
    decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-current' }),
    {
      change: 'unchanged',
      revalidate: true,
      rerank: false,
      reassess: false,
      skipAssessment: true,
      reason: 'unchanged-rejection',
    },
  );
});

test('a same-title URL-less opening with a different provider identity never inherits rejection', () => {
  const previous = {
    ...vacancy,
    vacancyId: 'vacancy-ref-semantic',
    sourceReferences: [{ source: 'ats', providerId: 'opening-1', url: '' }],
    outcome: 'below_threshold',
    profileId: 'profile-current',
  };
  const current = {
    ...vacancy,
    vacancyId: 'vacancy-ref-semantic',
    sourceReferences: [{ source: 'ats', providerId: 'opening-2', url: '' }],
  };
  const result = partitionVacanciesForAssessment([current], [previous], {
    profileId: 'profile-current',
  });
  assert.equal(result.skipped.length, 0);
  assert.equal(result.eligible[0].lifecycle.reason, 'new-vacancy');
});

test('profile, scoring and assessment changes have distinct rerank and reassess behaviour', () => {
  const previous = {
    ...vacancy,
    outcome: 'below_threshold',
    profileId: 'profile-old',
  };
  const profile = decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-new' });
  assert.equal(profile.rerank, true);
  assert.equal(profile.reassess, true);
  assert.equal(profile.reason, 'profile-change');

  const scoring = decideVacancyLifecycle(previous, vacancy, {
    profileId: 'profile-old',
    scoringChanged: true,
  });
  assert.equal(scoring.rerank, true);
  assert.equal(scoring.reassess, false);
  assert.equal(scoring.skipAssessment, true);
  assert.equal(scoring.reason, 'scoring-change');

  const assessment = decideVacancyLifecycle(previous, vacancy, {
    profileId: 'profile-old',
    assessmentChanged: true,
  });
  assert.equal(assessment.rerank, false);
  assert.equal(assessment.reassess, true);
  assert.equal(assessment.skipAssessment, false);
  assert.equal(assessment.reason, 'assessment-change');
});

test('reopened vacancies are reassessed even after a prior rejection', () => {
  const previous = {
    ...vacancy,
    status: 'closed',
    outcome: 'mandatory_unmet',
    profileId: 'profile-current',
  };
  const current = { ...vacancy, status: 'open' };
  const decision = decideVacancyLifecycle(previous, current, { profileId: 'profile-current' });
  assert.equal(decision.change, 'reopened');
  assert.equal(decision.reassess, true);
  assert.equal(decision.reason, 'reopened-vacancy');
});

test('a resurfaced legacy rejection is re-ranked and reassessed once under the published profile', () => {
  const previous = {
    ...vacancy,
    outcome: 'below_threshold',
    profileId: null,
  };
  const decision = decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-current' });

  assert.deepEqual(decision, {
    change: 'unchanged',
    revalidate: true,
    rerank: true,
    reassess: true,
    skipAssessment: false,
    reason: 'legacy-profile-rerank',
  });

  const currentDecision = decideVacancyLifecycle(
    { ...previous, profileId: 'profile-current' },
    vacancy,
    { profileId: 'profile-current' },
  );
  assert.equal(currentDecision.reason, 'unchanged-rejection');
  assert.equal(currentDecision.skipAssessment, true);
});

test('a distinct same-source provider reference cannot inherit an earlier rejection', () => {
  const previous = {
    ...vacancy,
    vacancyId: 'vacancy-ref-earlier',
    sourceReferences: [{ source: 'provider-a', providerId: 'opening-1', url: '' }],
    outcome: 'below_threshold',
    profileId: 'profile-current',
  };
  const current = {
    ...vacancy,
    vacancyId: 'vacancy-ref-later',
    sourceReferences: [{ source: 'provider-a', providerId: 'opening-2', url: '' }],
  };
  const result = partitionVacanciesForAssessment([current], [previous], {
    profileId: 'profile-current',
  });
  assert.equal(result.skipped.length, 0);
  assert.equal(result.eligible[0].lifecycle.reason, 'new-vacancy');
});

test('a different learning version re-ranks an unchanged rejection but never assesses it again', () => {
  const previous = {
    ...vacancy, outcome: 'below_threshold', profileId: 'profile-current', learningVersionId: 'learning-a',
  };
  const options = { profileId: 'profile-current' };

  const changed = decideVacancyLifecycle(previous, vacancy, { ...options, learningVersionId: 'learning-b' });
  assert.deepEqual(
    [changed.reason, changed.rerank, changed.reassess, changed.skipAssessment],
    ['scoring-change', true, false, true],
  );
  const same = decideVacancyLifecycle(previous, vacancy, { ...options, learningVersionId: 'learning-a' });
  assert.equal(same.reason, 'unchanged-rejection');
  const unrecorded = decideVacancyLifecycle(
    { ...previous, learningVersionId: undefined }, vacancy, { ...options, learningVersionId: 'learning-b' },
  );
  assert.equal(unrecorded.reason, 'unchanged-rejection');
});

test('lifecycle records give the change and reason for every vacancy with an earlier decision', () => {
  const rejected = {
    ...vacancy, outcome: 'below_threshold', profileId: 'profile-current', learningVersionId: 'learning-a',
  };
  const fresh = { ...vacancy, vacancyId: 'vacancy-2', canonicalUrl: 'https://example.test/two', title: { value: 'Other Role' } };
  const partition = partitionVacanciesForAssessment([vacancy, fresh], [rejected], {
    profileId: 'profile-current', learningVersionId: 'learning-a',
  });

  assert.deepEqual(lifecycleRecords(partition), [
    { vacancyId: 'vacancy-1', change: 'unchanged', reason: 'unchanged-rejection' },
  ]);
});

test('indexed history lookup picks the same earliest matching decision as comparing every record', () => {
  const byUrl = { ...vacancy, vacancyId: 'by-url', employer: { value: 'Different' }, title: { value: 'Different' }, description: '', canonicalUrl: 'https://example.test/job-1' };
  const byProvider = { ...vacancy, vacancyId: 'by-provider', employer: { value: 'Another' }, title: { value: 'Another' }, description: '', sourceReferences: [{ source: 'ats', providerId: 'opening-9', url: '' }] };
  const unmatched = { ...vacancy, vacancyId: 'unmatched', employer: { value: 'Nobody' }, title: { value: 'Nothing' }, description: '' };
  // Each target record carries the fingerprint of the vacancy it should match, so a skip proves the right record was chosen.
  const rejection = (extra) => ({ outcome: 'below_threshold', profileId: 'profile-current', ...extra });
  const history = [
    ...Array.from({ length: 1500 }, (_, index) => rejection({
      vacancyId: `filler-${index}`, company: `Filler ${index}`, role: 'Unrelated Role',
      url: `https://example.test/filler-${index}`,
    })),
    rejection({ vacancyId: 'same-employer-earlier', company: 'Acme', role: 'Platform Engineer', description: vacancy.description, contentFingerprint: vacancyContentFingerprint(vacancy) }),
    rejection({ vacancyId: 'shared-url-later', company: 'Other', role: 'Other', url: 'https://example.test/job-1', contentFingerprint: vacancyContentFingerprint(byUrl) }),
    rejection({ vacancyId: 'shared-provider', company: 'Elsewhere', role: 'Elsewhere', sourceReferences: [{ source: 'ats', providerId: 'opening-9', url: '' }], contentFingerprint: vacancyContentFingerprint(byProvider) }),
  ];
  const candidates = [vacancy, byUrl, byProvider, unmatched];

  const expected = candidates.map((candidate) => history.find((entry) => sameUnderlyingJob(entry, candidate))?.vacancyId ?? null);
  assert.deepEqual(expected, ['same-employer-earlier', 'shared-url-later', 'shared-provider', null]);

  const { skipped, eligible } = partitionVacanciesForAssessment(candidates, history, { profileId: 'profile-current' });
  assert.deepEqual(skipped.map((item) => item.vacancyId), ['vacancy-1', 'by-url', 'by-provider']);
  assert.deepEqual(eligible.map((item) => [item.vacancyId, item.lifecycle.reason]), [['unmatched', 'new-vacancy']]);
});

const oldVersion = { promptVersion: 'assessment-prompt-v1', assessmentSchemaVersion: 2, provider: 'codex', model: 'model-a' };
// Job identity ignores digits and one-letter words, so each job needs its own multi-letter name.
const word = (index) => String.fromCharCode(96 + index).repeat(5);
const job = (index, extra = {}) => ({
  vacancyId: `vacancy-${index}`,
  canonicalUrl: `https://example.test/jobs/${index}`,
  title: { value: `Role ${word(index)}` },
  employer: { value: `Employer ${word(index)}` },
  description: `Own the duties of role ${word(index)}.`,
  preRankScore: index,
  ...extra,
});
const rejection = (index, extra = {}) => ({
  ...job(index), outcome: 'below_threshold', profileId: 'profile-current', assessmentVersion: oldVersion, ...extra,
});
const partition = (indexes, historyExtra, options) => partitionVacanciesForAssessment(
  indexes.map((index) => job(index)), indexes.map((index) => rejection(index, historyExtra)),
  { profileId: 'profile-current', ...options },
);

test('a changed assessment prompt, schema or model re-assesses an earlier rejection, an unchanged one does not', () => {
  assert.deepEqual(assessmentVersionOf({
    promptVersion: 'assessment-prompt-v1', assessmentSchemaVersion: 2, provider: 'codex', model: 'model-a',
  }), oldVersion);
  assert.equal(assessmentVersionOf({ promptVersion: 'assessment-prompt-v1' }), null);

  for (const changed of [{ promptVersion: 'assessment-prompt-v2' }, { assessmentSchemaVersion: 3 }, { provider: 'claude' }, { model: 'model-b' }]) {
    const result = partition([1], undefined, { assessmentVersion: { ...oldVersion, ...changed } });
    assert.deepEqual(result.eligible.map((item) => item.lifecycle.reason), ['assessment-change'], JSON.stringify(changed));
  }
  const same = partition([1], undefined, { assessmentVersion: { ...oldVersion } });
  assert.deepEqual(same.skipped.map((item) => item.lifecycle.reason), ['unchanged-rejection']);
  // A rejection recorded before versions were stored has nothing to compare, so it is not re-assessed for this reason.
  const unrecorded = partition([1], { assessmentVersion: null }, { assessmentVersion: { ...oldVersion, model: 'model-b' } });
  assert.deepEqual(unrecorded.skipped.map((item) => item.lifecycle.reason), ['unchanged-rejection']);
  const unknownNow = partition([1], undefined, {});
  assert.deepEqual(unknownNow.skipped.map((item) => item.lifecycle.reason), ['unchanged-rejection']);
});

test('an assessment change re-assesses only a bounded number of earlier rejections per scan, strongest first', () => {
  const indexes = Array.from({ length: 20 }, (_, index) => index + 1);
  const options = { assessmentVersion: { ...oldVersion, promptVersion: 'assessment-prompt-v2' } };

  const byDefault = partition(indexes, undefined, options);
  assert.equal(byDefault.eligible.length, ASSESSMENT_CHANGE_REASSESS_LIMIT);
  assert.equal(ASSESSMENT_CHANGE_REASSESS_LIMIT, 6);

  const bounded = partition(indexes, undefined, { ...options, assessmentChangeLimit: 3 });
  assert.deepEqual(bounded.eligible.map((item) => [item.vacancyId, item.lifecycle.reason]), [
    ['vacancy-18', 'assessment-change'], ['vacancy-19', 'assessment-change'], ['vacancy-20', 'assessment-change'],
  ]);
  assert.equal(bounded.skipped.length, 17);
  assert.deepEqual(new Set(bounded.skipped.map((item) => item.lifecycle.reason)), new Set(['assessment-change-deferred']));
  assert.deepEqual(
    [bounded.skipped[0].lifecycle.reassess, bounded.skipped[0].lifecycle.skipAssessment],
    [false, true],
  );
  assert.equal(lifecycleRecords(bounded).length, 20);
});

test('the assessment-change limit does not hold back vacancies that are assessed anyway', () => {
  const indexes = [1, 2, 3, 4, 5];
  const options = { assessmentVersion: { ...oldVersion, model: 'model-b' }, assessmentChangeLimit: 1 };

  const kept = partition(indexes, { outcome: 'kept' }, options);
  assert.deepEqual(kept.eligible.map((item) => item.lifecycle.reason), Array(5).fill('assessment-change'));
  const rankedAgain = partitionVacanciesForAssessment(
    indexes.map((index) => job(index, { description: 'The advert was rewritten.' })),
    indexes.map((index) => rejection(index)),
    { profileId: 'profile-current', ...options },
  );
  assert.deepEqual(new Set(rankedAgain.eligible.map((item) => item.lifecycle.reason)), new Set(['material-change']));
  assert.equal(rankedAgain.eligible.length, 5);
});

test('lifecycle accepts both persisted underscore and public hyphen rejection vocabularies', () => {
  for (const outcome of ['below_threshold', 'below-threshold', 'provider_discarded', 'provider-discarded', 'mandatory_unmet', 'mandatory-unmet', 'hard_exclusion', 'hard-exclusion']) {
    const decision = decideVacancyLifecycle({ ...vacancy, outcome, profileId: 'profile-current' }, vacancy, { profileId: 'profile-current' });
    assert.equal(decision.skipAssessment, true, outcome);
    assert.equal(decision.reason, 'unchanged-rejection', outcome);
  }
});
