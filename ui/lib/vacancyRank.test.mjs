import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankVacancies } from './vacancyRank.mjs';
import { profileRuleId } from './searchProfile.mjs';

function rule(value, strength = 'strong-preference') {
  return { value, strength, provenance: 'explicit' };
}

function profile({
  primaryTitles = [], locations = [], workingPatterns = [], employmentTypes = [],
  responsibilities = [], skills = [], qualifications = [], industries = [], sectors = [],
  eligibility = [], mobility = [], seniority = [], employers = [],
  excludedTitles = [], excludedResponsibilities = [], compensation = {},
  unknownPolicies, selection,
} = {}) {
  return {
    id: 'profile-ranked-fixture', version: 1,
    target: {
      primaryTitles, locations, workingPatterns, employmentTypes, responsibilities,
      skills, qualifications, eligibility, mobility, industries, sectors, seniority, employers,
    },
    negative: { excludedTitles, excludedResponsibilities },
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
      ...compensation,
    },
    ...(unknownPolicies ? { unknownPolicies } : {}),
    ...(selection ? { selection } : {}),
  };
}

function field(value, provenance = 'explicit-source') {
  return { value, provenance };
}

function vacancy({
  vacancyId, title, employer = 'Example Ltd', location = 'London', workingPattern = 'hybrid',
  employmentType = 'permanent', description = '', compensation = null, postedAt = '2026-07-20T00:00:00.000Z',
  responsibilities = null, skills = null, qualifications = null, industry = null, seniority = null,
  firstSeenAt = '2026-07-20T00:00:00.000Z', lastSeenAt = '2026-07-20T00:00:00.000Z',
  semanticEvidence = null,
} = {}) {
  return {
    vacancyId, canonicalUrl: `https://jobs.example/${vacancyId}`, description, postedAt, firstSeenAt, lastSeenAt,
    employer: field(employer), title: field(title), location: field(location),
    workingPattern: field(workingPattern), employmentType: field(employmentType),
    responsibilities: field(responsibilities), skills: field(skills),
    qualifications: field(qualifications), industry: field(industry), seniority: field(seniority),
    compensation: compensation === null ? field(null, 'unknown') : field(compensation),
    ...(semanticEvidence ? { semanticEvidence } : {}),
  };
}

test('ranking exposes and scores every required semantic dimension', () => {
  const result = rankVacancies([vacancy({
    vacancyId: 'complete',
    title: 'Platform Engineer',
    employer: 'Preferred Co',
    location: 'Manchester',
    workingPattern: 'hybrid',
    responsibilities: ['Operate reliable services'],
    skills: ['TypeScript'],
    qualifications: ['Cloud certification'],
    industry: 'Healthcare',
    seniority: 'lead',
    compensation: {
      minimum: 70000, maximum: 80000, currency: 'GBP', period: 'year', rateType: 'salary',
    },
    postedAt: '2026-07-28T00:00:00.000Z',
    lastSeenAt: '2026-07-30T00:00:00.000Z',
  })], profile({
    primaryTitles: [rule('Platform Engineer', 'mandatory')],
    responsibilities: [rule('reliable services')],
    skills: [rule('TypeScript')],
    qualifications: [rule('Cloud certification')],
    industries: [rule('Healthcare')],
    locations: [rule('Manchester')],
    workingPatterns: [rule('hybrid')],
    seniority: [rule('lead')],
    employers: [rule('Preferred Co')],
    compensation: {
      currency: 'GBP', period: 'year', rateType: 'salary', minimum: 65000,
      minimumStrength: 'strong-preference', unknownPolicy: 'include',
    },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0.1 },
  }))[0];

  const required = [
    'title', 'responsibilities', 'skills', 'qualifications', 'industry', 'location',
    'workingPattern', 'compensation', 'seniority', 'employerPreference', 'freshness', 'novelty',
  ];
  assert.deepEqual(result.dimensions.filter(({ name }) => required.includes(name)).map(({ name }) => name), required);
  for (const name of required) {
    const dimension = result.dimensions.find((item) => item.name === name);
    assert.ok(dimension.score > 0, name);
    assert.equal(dimension.confidence, 1, name);
    assert.ok(Array.isArray(dimension.evidence) && dimension.evidence.length > 0, name);
  }
  assert.deepEqual(
    result.dimensions.find(({ name }) => name === 'responsibilities').evidence[0].vacancy,
    { itemCount: 1, matchedValue: 'Operate reliable services' },
  );
});

test('freshness uses persisted observation time and novelty uses only an exact history identity', () => {
  const rankedProfile = profile({
    primaryTitles: [rule('Engineer', 'mandatory')],
    selection: { breadth: 'focused', relevanceThreshold: 45, exploration: 0 },
  });
  const ranked = rankVacancies([
    vacancy({
      vacancyId: 'seen-fresh',
      title: 'Engineer',
      postedAt: '2026-07-29T00:00:00.000Z',
      lastSeenAt: '2026-07-30T00:00:00.000Z',
    }),
    vacancy({
      vacancyId: 'unseen-stale',
      title: 'Engineer',
      postedAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-07-30T00:00:00.000Z',
    }),
  ], rankedProfile, [{
    vacancyId: 'seen-fresh',
    status: 'rejected',
    sourceUrl: 'https://jobs.example/seen-fresh',
  }]);

  const seen = ranked.find(({ vacancyId }) => vacancyId === 'seen-fresh');
  const unseen = ranked.find(({ vacancyId }) => vacancyId === 'unseen-stale');
  const seenNovelty = seen.dimensions.find(({ name }) => name === 'novelty');
  const unseenNovelty = unseen.dimensions.find(({ name }) => name === 'novelty');
  const seenFreshness = seen.dimensions.find(({ name }) => name === 'freshness');
  const staleFreshness = unseen.dimensions.find(({ name }) => name === 'freshness');

  assert.equal(seenNovelty.score, 0);
  assert.equal(seenNovelty.evidence[0].comparison, 'seen-exact');
  assert.ok(unseenNovelty.score > 0);
  assert.equal(unseenNovelty.evidence[0].comparison, 'unseen');
  assert.ok(seenFreshness.score > staleFreshness.score);
  assert.equal(seenFreshness.evidence[0].referenceDate, '2026-07-30T00:00:00.000Z');
  assert.equal(staleFreshness.evidence[0].referenceDate, '2026-07-30T00:00:00.000Z');
});

test('novelty does not collapse distinct provider openings behind one privacy-canonical URL', () => {
  const rankedProfile = profile({
    primaryTitles: [rule('Engineer', 'mandatory')],
    selection: { breadth: 'focused', relevanceThreshold: 45, exploration: 0 },
  });
  const current = vacancy({ vacancyId: 'semantic-engineer', title: 'Engineer' });
  current.canonicalUrl = 'https://jobs.example/apply';
  current.sourceReferences = [{
    source: 'provider-a', providerId: 'opening-2', url: 'https://jobs.example/apply',
  }];
  const [result] = rankVacancies([current], rankedProfile, [{
    vacancyId: 'semantic-engineer',
    company: 'Example Ltd',
    role: 'Engineer',
    url: 'https://jobs.example/apply',
    sourceReferences: [{
      source: 'provider-a', providerId: 'opening-1', url: 'https://jobs.example/apply',
    }],
  }]);
  assert.equal(result.dimensions.find(({ name }) => name === 'novelty').evidence[0].comparison, 'unseen');
});

test('ranking is independent of source response order', () => {
  const rankedProfile = profile({ primaryTitles: [rule('Platform Engineer', 'mandatory')] });
  const weak = vacancy({ vacancyId: 'weak', title: 'Office Administrator' });
  const strong = vacancy({ vacancyId: 'strong', title: 'Platform Engineer' });

  const forward = rankVacancies([weak, strong], rankedProfile);
  const reverse = rankVacancies([strong, weak], rankedProfile);

  assert.deepEqual(forward.map(({ vacancyId }) => vacancyId), reverse.map(({ vacancyId }) => vacancyId));
  assert.equal(forward[0].vacancyId, strong.vacancyId);
});

test('different profiles rank the same jobs differently', () => {
  const jobs = [
    vacancy({ vacancyId: 'law', title: 'Commercial Solicitor', description: 'Commercial contracts and client advisory work.' }),
    vacancy({ vacancyId: 'bar', title: 'Part-time Bar Supervisor', employmentType: 'permanent', description: 'Lead a hospitality bar team.' }),
  ];
  const solicitorProfile = profile({ primaryTitles: [rule('Commercial Solicitor', 'mandatory')] });
  const hospitalityProfile = profile({ primaryTitles: [rule('Part-time Bar Supervisor', 'mandatory')] });

  assert.equal(rankVacancies(jobs, solicitorProfile)[0].title.value, 'Commercial Solicitor');
  assert.equal(rankVacancies(jobs, hospitalityProfile)[0].title.value, 'Part-time Bar Supervisor');
});

test('ranked vacancies expose weighted dimensions and contribution evidence', () => {
  const result = rankVacancies([vacancy({
    vacancyId: 'explained', title: 'Data Analyst', location: 'Manchester',
    description: 'Analyse public-health data.',
  })], profile({
    primaryTitles: [rule('Data Analyst', 'mandatory')],
    locations: [rule('Manchester', 'strong-preference')],
    sectors: [rule('public health', 'nice-to-have')],
  }))[0];

  assert.equal(result.preRankScore, 100);
  assert.equal(result.preRankConfidence, 100);
  assert.ok(result.dimensions.every(({ name, score, maximum, confidence, evidence, profileRuleIds }) =>
    typeof name === 'string' && Number.isFinite(score) && Number.isFinite(maximum) && Number.isFinite(confidence)
      && Array.isArray(evidence) && Array.isArray(profileRuleIds)));
  assert.ok(result.contributions.some((item) => item.profileRuleId === profileRuleId(
    'target', 'primaryTitles', rule('Data Analyst', 'mandatory'),
  ) && item.score > 0));
  assert.deepEqual(result.stableTieBreak, {
    postedAt: '2026-07-20T00:00:00.000Z', employer: 'example ltd', title: 'data analyst', vacancyId: 'explained',
  });
});

test('unknown evidence lowers confidence and never receives a positive match score', () => {
  const result = rankVacancies([vacancy({ vacancyId: 'unknown', title: 'Data Analyst', location: null })], profile({
    primaryTitles: [rule('Data Analyst', 'strong-preference')], locations: [rule('Manchester', 'strong-preference')],
  }))[0];
  const location = result.dimensions.find((dimension) => dimension.name === 'location');

  assert.equal(location.score, 0);
  assert.equal(location.confidence, 0);
  assert.ok(result.preRankConfidence < 100);
  assert.ok(result.preRankScore < 100);
});

test('unknown location include and penalise policies remain distinct and traceable', () => {
  const job = vacancy({ vacancyId: 'unknown-location-policy', title: 'Data Analyst', location: null });
  const rules = {
    primaryTitles: [rule('Data Analyst', 'strong-preference')],
    locations: [rule('Manchester', 'strong-preference')],
  };
  const included = rankVacancies([job], profile({
    ...rules, unknownPolicies: { location: 'include' },
  }))[0];
  const penalised = rankVacancies([job], profile({
    ...rules, unknownPolicies: { location: 'penalise' },
  }))[0];
  const dimension = penalised.dimensions.find(({ name }) => name === 'location');

  assert.equal(included.dimensions.find(({ name }) => name === 'location').score, 0);
  assert.ok(dimension.score < 0);
  assert.equal(dimension.evidence[0].comparison, 'unknown');
  assert.ok(penalised.preRankScore < included.preRankScore);
});

test('the published employer unknown policy applies to the employer-preference dimension', () => {
  const job = vacancy({ vacancyId: 'unknown-employer-policy', title: 'Data Analyst', employer: null });
  const rules = {
    primaryTitles: [rule('Data Analyst', 'strong-preference')],
    employers: [rule('Acme', 'strong-preference')],
  };
  const included = rankVacancies([job], profile({
    ...rules, unknownPolicies: { employer: 'include' },
  }))[0];
  const penalised = rankVacancies([job], profile({
    ...rules, unknownPolicies: { employer: 'penalise' },
  }))[0];
  const dimension = penalised.dimensions.find(({ name }) => name === 'employerPreference');
  assert.equal(dimension.evidence[0].comparison, 'unknown');
  assert.ok(dimension.score < 0);
  assert.ok(penalised.preRankScore < included.preRankScore);
});

test('compensation only matches comparable currency, period and rate types', () => {
  const rankedProfile = profile({ compensation: {
    currency: 'GBP', period: 'year', rateType: 'salary', minimum: 60000,
    amountType: 'base', certainty: 'exact',
    minimumStrength: 'strong-preference', unknownPolicy: 'include',
  } });
  const jobs = [
    vacancy({ vacancyId: 'match', title: 'Engineer', compensation: { minimum: 65000, maximum: 70000, currency: 'GBP', period: 'year', rateType: 'salary' } }),
    vacancy({ vacancyId: 'foreign', title: 'Engineer', compensation: { minimum: 80000, maximum: 90000, currency: 'USD', period: 'year', rateType: 'salary' } }),
    vacancy({ vacancyId: 'hourly', title: 'Engineer', compensation: { minimum: 40, maximum: 45, currency: 'GBP', period: 'hour', rateType: 'salary' } }),
    vacancy({ vacancyId: 'total', title: 'Engineer', compensation: {
      minimum: 90000, maximum: 100000, currency: 'GBP', period: 'year', rateType: 'salary',
      amountType: 'total', certainty: 'exact',
    } }),
  ];
  const ranked = rankVacancies(jobs, rankedProfile);

  assert.equal(ranked[0].vacancyId, 'match');
  for (const vacancyResult of ranked.filter(({ vacancyId }) => vacancyId !== 'match')) {
    const compensation = vacancyResult.dimensions.find((dimension) => dimension.name === 'compensation');
    assert.equal(compensation.score, 0);
    assert.equal(compensation.confidence, 0);
    assert.equal(compensation.evidence[0].comparison, 'unknown');
  }
});

test('ties use confidence, posted date, employer/title, then vacancy id deterministically', () => {
  const noPreference = profile();
  const ranked = rankVacancies([
    vacancy({ vacancyId: 'z', title: 'Same', employer: 'Beta', postedAt: '2026-07-19T00:00:00.000Z' }),
    vacancy({ vacancyId: 'b', title: 'Same', employer: 'Alpha', postedAt: '2026-07-20T00:00:00.000Z' }),
    vacancy({ vacancyId: 'a', title: 'Same', employer: 'Alpha', postedAt: '2026-07-20T00:00:00.000Z' }),
  ], noPreference);

  assert.deepEqual(ranked.map(({ vacancyId }) => vacancyId), ['a', 'b', 'z']);
});

test('normalized observations without a canonical URL still have an order-independent tie break', () => {
  const first = vacancy({ vacancyId: undefined, title: 'Engineer', employer: 'Acme', postedAt: null });
  const second = vacancy({ vacancyId: undefined, title: 'Engineer', employer: 'Acme', postedAt: null });
  first.canonicalUrl = null;
  second.canonicalUrl = null;
  first.observationId = 'observation-b';
  second.observationId = 'observation-a';

  const forward = rankVacancies([first, second], profile());
  const reverse = rankVacancies([second, first], profile());

  assert.deepEqual(forward.map(({ stableTieBreak }) => stableTieBreak.vacancyId), ['observation-a', 'observation-b']);
  assert.deepEqual(forward.map(({ stableTieBreak }) => stableTieBreak.vacancyId), reverse.map(({ stableTieBreak }) => stableTieBreak.vacancyId));
});

test('unknown negative-rule evidence lowers confidence without receiving a penalty', () => {
  const result = rankVacancies([vacancy({ vacancyId: 'unknown-negative', title: null })], profile({
    excludedResponsibilities: [rule('coding', 'strong-negative')],
  }))[0];
  const negative = result.dimensions.find((dimension) => dimension.name === 'responsibilities');

  assert.equal(negative.score, 0);
  assert.equal(negative.confidence, 0);
  assert.ok(result.preRankConfidence < 100);
});

test('a semantic artifact with no description preserves unknown ranking evidence', () => {
  const result = rankVacancies([vacancy({
    vacancyId: 'semantic-description-missing',
    title: 'Data Analyst',
    description: '',
    semanticEvidence: {
      descriptionPresent: false,
      descriptionDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      descriptionLength: 0,
      profileRuleMatches: [],
      mandatorySignals: [],
    },
  })], profile({
    sectors: [rule('public health', 'strong-preference')],
  }))[0];
  const sector = result.dimensions.find((dimension) => dimension.name === 'industry');

  assert.equal(sector.score, 0);
  assert.equal(sector.confidence, 0);
  assert.ok(result.preRankConfidence < 100);
});

test('semantic ranking uses per-rule matches and keeps unevidenced description rules unknown', () => {
  const semanticRules = [
    ['target', 'responsibilities', 'design services', 'unknown'],
    ['target', 'skills', 'typescript', 'matched'],
    ['target', 'qualifications', 'cloud certification', 'unknown'],
    ['target', 'sectors', 'public health', 'matched'],
    ['target', 'eligibility', 'work authorisation', 'unknown'],
    ['target', 'mobility', 'regional travel', 'matched'],
  ].map(([section, field, fact, status]) => ({
    id: profileRuleId(section, field, rule(fact)),
    fact, status,
    evidence: [{
      source: 'fixture',
      providerId: 'semantic-1',
      descriptionDigest: 'a'.repeat(64),
      provenance: 'deterministic-extraction',
    }],
  }));
  const result = rankVacancies([vacancy({
    vacancyId: 'semantic-per-rule',
    title: 'Platform Engineer',
    location: null,
    description: '',
    semanticEvidence: {
      descriptionPresent: true,
      descriptionDigest: 'a'.repeat(64),
      descriptionLength: 120,
      profileRuleEvidence: semanticRules,
      profileRuleMatches: semanticRules.filter(({ status }) => status === 'matched'),
      mandatorySignals: [],
    },
  })], profile({
    responsibilities: [rule('design services')],
    skills: [rule('TypeScript')],
    qualifications: [rule('cloud certification')],
    sectors: [rule('public health')],
    eligibility: [rule('work authorisation')],
    mobility: [rule('regional travel')],
  }))[0];

  for (const name of ['skills', 'industry', 'mobility']) {
    const dimension = result.dimensions.find((item) => item.name === name);
    assert.ok(dimension.score > 0, name);
    assert.equal(dimension.confidence, 1, name);
  }
  for (const name of ['responsibilities', 'qualifications', 'eligibility']) {
    const dimension = result.dimensions.find((item) => item.name === name);
    assert.equal(dimension.score, 0, name);
    assert.equal(dimension.confidence, 0, name);
    assert.equal(dimension.evidence[0].comparison, 'unknown', name);
  }
});

test('the generic ranker gives six distinct profile fixtures their matching vacancy first', () => {
  const jobs = [
    vacancy({ vacancyId: 'developer', title: 'Software Developer' }),
    vacancy({ vacancyId: 'administrator', title: 'Hospital Administrator' }),
    vacancy({ vacancyId: 'hospitality', title: 'Hospitality Worker' }),
    vacancy({ vacancyId: 'solicitor', title: 'Commercial Solicitor' }),
    vacancy({ vacancyId: 'graduate', title: 'Mechanical Engineering Graduate' }),
    vacancy({ vacancyId: 'retail', title: 'Retail Manager' }),
  ];
  const cases = [
    ['developer', 'Software Developer'], ['administrator', 'Hospital Administrator'],
    ['hospitality', 'Hospitality Worker'], ['solicitor', 'Commercial Solicitor'],
    ['graduate', 'Mechanical Engineering Graduate'], ['retail', 'Retail Manager'],
  ];

  for (const [expected, title] of cases) {
    assert.equal(rankVacancies(jobs, profile({ primaryTitles: [rule(title, 'mandatory')] }))[0].vacancyId, expected);
  }
});

test('published learning adjusts ranking transparently without changing base profile evidence', () => {
  const jobs = [
    vacancy({ vacancyId: 'london', title: 'Engineer', location: 'London' }),
    vacancy({ vacancyId: 'manchester', title: 'Engineer', location: 'Manchester' }),
  ];
  const ranked = rankVacancies(jobs, profile(), [], {
    learningPolicy: {
      id: 'learning-v1',
      changes: [{
        kind: 'rank-adjustment',
        field: 'location',
        value: 'Manchester',
        weight: 8,
        scope: 'profile-wide',
        proposalId: 'proposal-v1',
      }],
    },
  });

  assert.equal(ranked[0].vacancyId, 'manchester');
  assert.equal(ranked[0].preRankScore, Math.min(100, ranked[0].basePreRankScore + 8));
  assert.equal(ranked[0].learningVersionId, 'learning-v1');
  assert.equal(ranked[0].learningContributions[0].proposalId, 'proposal-v1');
});

test('every dimension score is fully accounted for by explainable contributions', () => {
  const result = rankVacancies([vacancy({
    vacancyId: 'fully-explained',
    title: 'Weekend Support Engineer',
    employer: 'Preferred Co',
    location: null,
    responsibilities: ['Operate reliable services'],
    skills: ['TypeScript'],
    compensation: {
      minimum: 70000, maximum: 80000, currency: 'GBP', period: 'year', rateType: 'salary',
    },
    postedAt: '2026-07-28T00:00:00.000Z',
    lastSeenAt: '2026-07-30T00:00:00.000Z',
  })], profile({
    primaryTitles: [rule('Engineer', 'mandatory')],
    excludedTitles: [rule('weekend', 'strong-negative')],
    locations: [rule('London', 'strong-preference')],
    responsibilities: [rule('reliable services', 'nice-to-have')],
    skills: [rule('TypeScript', 'strong-preference')],
    employers: [rule('Preferred Co', 'nice-to-have')],
    compensation: {
      currency: 'GBP', period: 'year', rateType: 'salary', minimum: 65000,
      minimumStrength: 'strong-preference', unknownPolicy: 'include',
    },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0.1 },
    unknownPolicies: { location: 'penalise' },
  }))[0];

  for (const contribution of result.contributions) {
    assert.ok(typeof contribution.name === 'string' && contribution.name, 'contribution name');
    assert.ok(typeof contribution.profileRuleId === 'string' && contribution.profileRuleId, 'contribution profileRuleId');
    assert.ok(Number.isFinite(contribution.score), 'contribution score');
    assert.ok(contribution.evidence && typeof contribution.evidence === 'object', 'contribution evidence');
  }
  assert.ok(result.contributions.some(({ score }) => score > 0));
  assert.ok(result.contributions.some(({ score }) => score < 0));

  const dimensionNames = new Set(result.dimensions.map(({ name }) => name));
  const grouped = new Map();
  for (const contribution of result.contributions) {
    assert.ok(dimensionNames.has(contribution.name), `contribution names dimension ${contribution.name}`);
    grouped.set(contribution.name, [...(grouped.get(contribution.name) || []), contribution]);
  }
  for (const dimension of result.dimensions) {
    const total = (grouped.get(dimension.name) || []).reduce((sum, item) => sum + item.score, 0);
    assert.ok(Math.abs(total - dimension.score) <= 1e-9,
      `${dimension.name} contributions ${total} must account for score ${dimension.score}`);
  }
});

test('each contribution traces to a profile rule or a documented policy with match evidence', () => {
  const excludedWeekend = rule('weekend', 'strong-negative');
  const result = rankVacancies([vacancy({
    vacancyId: 'traceable',
    title: 'Weekend Support Engineer',
    location: null,
    skills: ['TypeScript'],
    compensation: {
      minimum: 70000, maximum: 80000, currency: 'GBP', period: 'year', rateType: 'salary',
    },
    postedAt: '2026-07-28T00:00:00.000Z',
    lastSeenAt: '2026-07-30T00:00:00.000Z',
  })], profile({
    primaryTitles: [rule('Engineer', 'mandatory')],
    excludedTitles: [excludedWeekend],
    locations: [rule('London', 'strong-preference')],
    skills: [rule('TypeScript', 'strong-preference')],
    compensation: {
      currency: 'GBP', period: 'year', rateType: 'salary', minimum: 65000,
      minimumStrength: 'strong-preference', unknownPolicy: 'include',
    },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0.1 },
    unknownPolicies: { location: 'penalise' },
  }))[0];

  const dimensions = new Map(result.dimensions.map((dimension) => [dimension.name, dimension]));
  for (const contribution of result.contributions) {
    const dimension = dimensions.get(contribution.name);
    assert.ok(dimension.profileRuleIds.includes(contribution.profileRuleId)
      || contribution.profileRuleId === `policy-${dimension.name}-unknown`,
    `${contribution.name} contribution ${contribution.profileRuleId} must trace to dimension rules or its unknown policy`);
  }

  const positiveTitle = result.contributions.find(({ profileRuleId: id }) => id
    === profileRuleId('target', 'primaryTitles', rule('Engineer', 'mandatory')));
  assert.equal(positiveTitle.score, 1);
  assert.equal(positiveTitle.evidence.matched, true);
  assert.equal(positiveTitle.evidence.rule, 'Engineer');
  assert.equal(positiveTitle.evidence.vacancy, 'Weekend Support Engineer');

  const negativeTitle = result.contributions.find(({ profileRuleId: id }) => id
    === profileRuleId('negative', 'excludedTitles', excludedWeekend));
  assert.equal(negativeTitle.score, -0.7);
  assert.equal(negativeTitle.evidence.matched, true);
  assert.equal(negativeTitle.evidence.rule, 'weekend');
  assert.equal(negativeTitle.evidence.vacancy, 'Weekend Support Engineer');

  const skills = result.contributions.find(({ name }) => name === 'skills');
  assert.equal(skills.evidence.matched, true);
  assert.deepEqual(skills.evidence.vacancy, { itemCount: 1, matchedValue: 'TypeScript' });
  assert.equal(skills.evidence.rule, 'TypeScript');

  const penalty = result.contributions.find(({ profileRuleId: id }) => id === 'policy-location-unknown');
  assert.ok(penalty.score < 0);
  assert.equal(penalty.evidence.comparison, 'unknown');
  assert.equal(penalty.evidence.rule, 'unknown location policy: penalise');
  assert.equal(penalty.evidence.vacancy, null);

  const compensation = result.contributions.find(({ profileRuleId: id }) => id === 'policy-compensation-minimum');
  assert.equal(compensation.score, 0.8);
  assert.equal(compensation.evidence.comparison, 'meets-minimum');
  assert.equal(compensation.evidence.rule, 65000);
  assert.deepEqual(compensation.evidence.vacancy, {
    minimum: 70000, maximum: 80000, currency: 'GBP', period: 'year', rateType: 'salary',
  });

  const freshness = result.contributions.find(({ name }) => name === 'freshness');
  assert.equal(freshness.profileRuleId, 'search-breadth-balanced-freshness');
  assert.equal(freshness.score, 0.7822);
  assert.equal(freshness.evidence.comparison, 'within-horizon');
  assert.equal(freshness.evidence.observedDate, '2026-07-28T00:00:00.000Z');
  assert.equal(freshness.evidence.referenceDate, '2026-07-30T00:00:00.000Z');
  assert.equal(freshness.evidence.ageDays, 2);
  assert.equal(freshness.evidence.horizonDays, 90);
  assert.equal(freshness.evidence.breadth, 'balanced');
  assert.equal(freshness.evidence.rule, 'balanced freshness');

  const novelty = result.contributions.find(({ name }) => name === 'novelty');
  assert.equal(novelty.profileRuleId, 'search-breadth-balanced-novelty');
  assert.equal(novelty.score, 0.8);
  assert.equal(novelty.evidence.comparison, 'unseen');
  assert.equal(novelty.evidence.identity, 'stable-identity');
  assert.equal(novelty.evidence.breadth, 'balanced');
});

test('equal inputs produce identical explanations across repeated runs and input order', () => {
  const rankedProfile = profile({
    primaryTitles: [rule('Platform Engineer', 'mandatory')],
    locations: [rule('London', 'strong-preference')],
    selection: { breadth: 'focused', relevanceThreshold: 45, exploration: 0 },
    unknownPolicies: { location: 'penalise' },
  });
  const jobs = [
    vacancy({ vacancyId: 'seen-other', title: 'Office Administrator', postedAt: '2026-07-20T00:00:00.000Z' }),
    vacancy({ vacancyId: 'unknown-location', title: 'Platform Engineer', location: null, postedAt: '2026-07-28T00:00:00.000Z' }),
    vacancy({ vacancyId: 'london-fresh', title: 'Platform Engineer', location: 'London', postedAt: '2026-07-29T00:00:00.000Z' }),
  ];
  const history = [{ vacancyId: 'seen-other', status: 'rejected', sourceUrl: 'https://jobs.example/seen-other' }];

  const first = rankVacancies(jobs, rankedProfile, history);
  const second = rankVacancies(jobs, rankedProfile, history);
  const reversed = rankVacancies([...jobs].reverse(), rankedProfile, history);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ vacancyId }) => vacancyId), reversed.map(({ vacancyId }) => vacancyId));
  assert.equal(first[0].vacancyId, 'london-fresh');
  for (const result of reversed) {
    const reference = first.find(({ vacancyId }) => vacancyId === result.vacancyId);
    assert.deepEqual(result.dimensions, reference.dimensions, result.vacancyId);
    assert.deepEqual(result.contributions, reference.contributions, result.vacancyId);
    assert.equal(result.preRankScore, reference.preRankScore);
    assert.equal(result.preRankConfidence, reference.preRankConfidence);
  }
});

test('identical vacancies with different ids receive equal scores and equal contributions', () => {
  const shared = {
    title: 'Platform Engineer',
    employer: 'Twin Ltd',
    location: 'London',
    skills: ['TypeScript'],
    responsibilities: ['Operate reliable platforms'],
    compensation: { minimum: 70000, maximum: 90000, currency: 'GBP', period: 'year', rateType: 'salary' },
    postedAt: '2026-07-28T00:00:00.000Z',
    lastSeenAt: '2026-07-30T00:00:00.000Z',
  };
  const ranked = rankVacancies([
    vacancy({ vacancyId: 'twin-b', ...shared }),
    vacancy({ vacancyId: 'twin-a', ...shared }),
  ], profile({
    primaryTitles: [rule('Platform Engineer', 'mandatory')],
    skills: [rule('TypeScript', 'strong-preference')],
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0.1 },
  }));

  assert.deepEqual(ranked.map(({ vacancyId }) => vacancyId), ['twin-a', 'twin-b']);
  const [first, second] = ranked;
  assert.ok(first.contributions.length > 0);
  assert.equal(first.preRankScore, second.preRankScore);
  assert.equal(first.preRankConfidence, second.preRankConfidence);
  assert.deepEqual(first.dimensions, second.dimensions);
  assert.deepEqual(first.contributions, second.contributions);
});
