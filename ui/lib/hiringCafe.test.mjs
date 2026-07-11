import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBuildId, buildSearchState, fetchHiringCafe, DEFAULT_HIRING_CAFE_QUERIES } from './hiringCafe.mjs';

const hit = {
  is_expired: false, apply_url: 'https://apply/x', job_information: { title: 'Product Designer' },
  v5_processed_job_data: {
    company_name: 'ExampleCo', requirements_summary: 'Research and prototyping', job_category: 'Design',
    yearly_min_compensation: 60000, yearly_max_compensation: 75000, listed_compensation_currency: 'GBP',
    estimated_publish_date: '2026-07-08T00:00:00Z', formatted_workplace_location: 'Remote', workplace_type: 'Remote',
  },
};
const homepage = (id) => ({ ok: true, text: async () => `<script>{"buildId":"${id}"}</script>` });
const dataResponse = (hits) => ({ ok: true, json: async () => ({ pageProps: { ssrHits: hits } }) });

test('extractBuildId finds the Next.js build id', () => {
  assert.equal(extractBuildId('{"buildId":"abc123"}'), 'abc123');
  assert.equal(extractBuildId('none'), null);
});

test('buildSearchState does not impose a personal location', () => {
  assert.deepEqual(buildSearchState('designer'), { searchQuery: 'designer', locations: [] });
  assert.equal(buildSearchState('designer', { location: { formatted_address: 'Berlin' } }).locations[0].formatted_address, 'Berlin');
});

test('fetchHiringCafe normalises hits and skips expired ones', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['product designer'], async (url) => {
    call += 1;
    if (call === 1) return homepage('bld1');
    assert.match(String(url), /_next\/data\/bld1\/index\.json/);
    return dataResponse([hit, { ...hit, is_expired: true }]);
  });
  assert.equal(result.available, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.count, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].salary, 'GBP 60,000-75,000');
  assert.deepEqual(result.sources, { 'product designer': 1 });
});

test('fetchHiringCafe fails soft when build id or a query fails', async () => {
  const missing = await fetchHiringCafe(['x'], async () => ({ ok: true, text: async () => 'not next.js' }));
  assert.equal(missing.available, false);
  assert.equal(missing.status, 'unavailable');
  let call = 0;
  const partial = await fetchHiringCafe(['a', 'b'], async () => {
    call += 1;
    if (call === 1) return homepage('bld1');
    if (call === 2) throw new Error('boom');
    return dataResponse([hit]);
  });
  assert.equal(partial.jobs.length, 1);
  assert.equal(partial.errors.length, 1);
  assert.equal(partial.status, 'degraded');
  assert.match(partial.reason, /1 of 2/);
});

test('fetchHiringCafe treats a successful empty search as healthy', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['rare role'], async () => {
    call += 1;
    return call === 1 ? homepage('bld1') : dataResponse([]);
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.count, 0);
  assert.deepEqual(result.errors, []);
});

test('default queries are empty until onboarding configures the search', async () => {
  assert.deepEqual(DEFAULT_HIRING_CAFE_QUERIES, []);
  const result = await fetchHiringCafe();
  assert.equal(result.available, false);
});
