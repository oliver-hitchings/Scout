import { withSourceStatus } from './sourceHealth.mjs';

const HOME_URL = 'https://hiring.cafe/';

export const DEFAULT_HIRING_CAFE_QUERIES = [];

export function extractBuildId(html) {
  const m = String(html || '').match(/"buildId":"([^"]+)"/);
  return m ? m[1] : null;
}

export function buildSearchState(query, options = {}) {
  return {
    searchQuery: query,
    locations: options.location && typeof options.location === 'object' ? [options.location] : [],
  };
}

function salaryText(min, max, currency, locale = 'en-GB') {
  const fmt = (n) => Math.round(n).toLocaleString(locale);
  const cur = currency || '';
  if (min && max && min !== max) return `${cur} ${fmt(min)}-${fmt(max)}`.trim();
  if (min) return `${cur} ${fmt(min)}`.trim();
  return null;
}

function normalise(hit, options) {
  const v5 = hit.v5_processed_job_data || {};
  const description = [
    v5.requirements_summary || '', v5.job_category || '', (v5.role_activities || []).join(', '),
    v5.company_tagline || '', v5.company_sector_and_industry || '', (v5.company_activities || []).join(', '),
  ].filter(Boolean).join(' ');
  return {
    title: hit.job_information?.title || '',
    company: v5.company_name || '',
    description,
    url: hit.apply_url || '',
    salary: salaryText(v5.yearly_min_compensation, v5.yearly_max_compensation, v5.listed_compensation_currency, options.locale),
    location: v5.formatted_workplace_location || '',
    workingType: v5.workplace_type || '',
    postedDate: (v5.estimated_publish_date || '').slice(0, 10) || null,
    source: 'hiring_cafe',
    tags: [],
  };
}

export async function fetchHiringCafe(queries = DEFAULT_HIRING_CAFE_QUERIES, fetchImpl = globalThis.fetch, options = {}) {
  const jobs = [];
  const sources = {};
  const errors = [];
  const seen = new Set();
  if (!queries.length) return withSourceStatus({
    jobs, sources, errors, available: false, status: 'unavailable', count: 0,
    reason: 'no hiring.cafe queries configured', note: 'no hiring.cafe queries configured',
  });

  let buildId = null;
  try {
    const home = await fetchImpl(HOME_URL);
    if (!home || !home.ok) throw new Error(`homepage fetch failed ${home?.status || ''}`.trim());
    buildId = extractBuildId(await home.text());
    if (!buildId) throw new Error('buildId not found in homepage (endpoint shape may have changed)');
  } catch (e) {
    return withSourceStatus({
      jobs: [], sources: {}, errors: [`hiring.cafe: ${e.message}`], available: false,
      status: 'unavailable', count: 0, reason: e.message,
    });
  }

  for (const query of queries) {
    try {
      const state = encodeURIComponent(JSON.stringify(buildSearchState(query, options)));
      const response = await fetchImpl(`https://hiring.cafe/_next/data/${buildId}/index.json?searchState=${state}`);
      if (!response || !response.ok) throw new Error(`fetch failed ${response?.status || ''}`.trim());
      const data = await response.json();
      const hits = data?.pageProps?.ssrHits || [];
      let count = 0;
      for (const hit of hits) {
        if (hit.is_expired) continue;
        const job = normalise(hit, options);
        count += 1;
        const key = `${job.company.toLowerCase().trim()}|${job.title.toLowerCase().trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(job);
      }
      sources[query] = count;
    } catch (e) {
      sources[query] = 0;
      errors.push(`hiring.cafe "${query}": ${e.message}`);
    }
  }
  return withSourceStatus({
    jobs, sources, errors, available: true,
    reason: errors.length ? `${errors.length} of ${queries.length} queries failed` : null,
  });
}
