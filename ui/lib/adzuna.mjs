import { withSourceStatus } from './sourceHealth.mjs';

const ADZUNA_ORIGIN = 'https://api.adzuna.com/v1/api/jobs';

export const DEFAULT_ADZUNA_QUERIES = [];

// Adzuna returns salary amounts in the queried market's currency. The
// workspace currency is a preference, never evidence about a source amount.
const COUNTRY_CURRENCIES = Object.freeze({
  at: 'EUR', au: 'AUD', be: 'EUR', br: 'BRL', ca: 'CAD', ch: 'CHF',
  de: 'EUR', es: 'EUR', fr: 'EUR', gb: 'GBP', in: 'INR', it: 'EUR',
  mx: 'MXN', nl: 'EUR', nz: 'NZD', pl: 'PLN', sg: 'SGD', us: 'USD', za: 'ZAR',
});

export function adzunaCountryCurrency(country) {
  return COUNTRY_CURRENCIES[country] || null;
}

export const DEFAULT_ADZUNA_OPTIONS = Object.freeze({
  country: null,
  where: '',
  distanceKm: null,
  salaryMin: null,
  resultsPerPage: 50,
  locale: 'en',
  currency: null,
});

export function resolveAdzunaCredentials(env) {
  const appId = String(env.ADZUNA_APP_ID || '').trim();
  const apiKey = String(env.ADZUNA_API_KEY || '').trim();
  return appId && apiKey ? { appId, apiKey } : null;
}

export function adzunaUrl(query, options) {
  const values = { ...DEFAULT_ADZUNA_OPTIONS, ...options };
  if (!/^[a-z]{2}$/.test(values.country)) throw new Error('Adzuna country must be a two-letter code');
  const params = new URLSearchParams({
    app_id: values.appId,
    app_key: values.apiKey,
    what: query,
    results_per_page: String(values.resultsPerPage),
    'content-type': 'application/json',
  });
  if (values.where) params.set('where', values.where);
  if (values.distanceKm !== null && values.distanceKm !== undefined && values.distanceKm !== '') params.set('distance', String(values.distanceKm));
  if (values.salaryMin !== null && values.salaryMin !== undefined && values.salaryMin !== '') params.set('salary_min', String(values.salaryMin));
  return `${ADZUNA_ORIGIN}/${values.country}/search/1?${params}`;
}

function salaryText(min, max, options) {
  const formatter = new Intl.NumberFormat(options.locale || 'en', {
    ...(options.currency ? { style: 'currency', currency: options.currency } : {}),
    maximumFractionDigits: 0,
  });
  const fmt = (n) => `${formatter.format(Math.round(n))}${options.currency ? '' : ' (currency unknown)'}`;
  if (min && max && min !== max) return `${fmt(min)}-${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  if (max) return `up to ${fmt(max)}`;
  return null;
}

function normalise(item, options) {
  return {
    providerId: String(item.id || ''),
    sourceRecordId: String(item.id || ''),
    title: item.title || '',
    company: item.company?.display_name || '',
    description: item.description || '',
    url: item.redirect_url || '',
    salary: salaryText(item.salary_min, item.salary_max, options),
    salaryMin: item.salary_min ?? null,
    salaryMax: item.salary_max ?? null,
    salaryCurrency: options.currency || null,
    salaryCurrencyProvenance: options.currency ? 'queried-country' : 'unknown',
    salaryPeriod: 'year',
    salaryRateType: 'salary',
    location: item.location?.display_name || '',
    workingType: '',
    postedDate: (item.created || '').slice(0, 10) || null,
    source: 'adzuna',
    tags: [],
  };
}

export async function fetchAdzuna(options, fetchImpl = globalThis.fetch) {
  const values = { ...DEFAULT_ADZUNA_OPTIONS, ...options };
  const currency = adzunaCountryCurrency(values.country);
  // There is no implicit FX conversion at the source-query boundary.
  if (!currency || values.currency !== currency) values.salaryMin = null;
  values.currency = currency;
  const { appId, apiKey, queries = DEFAULT_ADZUNA_QUERIES } = values;
  if (!appId || !apiKey) return withSourceStatus({ jobs: [], sources: {}, errors: [], available: false }, { unavailableReason: 'Adzuna credentials are not configured' });
  if (!queries.length) return withSourceStatus({ jobs: [], sources: {}, errors: [], available: false, note: 'no Adzuna queries configured' });
  if (!values.country) return withSourceStatus({ jobs: [], sources: {}, errors: [], available: false }, { unavailableReason: 'Choose an Adzuna search country in Settings before using this source' });

  const jobs = [];
  const sources = {};
  const errors = [];
  const seen = new Set();
  for (const query of queries) {
    try {
      const response = await fetchImpl(adzunaUrl(query, values));
      if (!response || !response.ok) throw new Error(`fetch failed ${response?.status || ''}`.trim());
      const data = await response.json();
      const found = (data.results || []).map((item) => ({
        ...normalise(item, values),
        searchQueries: [query],
      }));
      sources[query] = found.length;
      for (const job of found) {
        const key = job.providerId || job.url || `${job.company.toLowerCase().trim()}|${job.title.toLowerCase().trim()}|${job.location.toLowerCase().trim()}`;
        if (seen.has(key)) {
          const existing = jobs.find((item) => (
            (item.providerId || item.url || `${item.company.toLowerCase().trim()}|${item.title.toLowerCase().trim()}|${item.location.toLowerCase().trim()}`) === key
          ));
          if (existing && !existing.searchQueries.includes(query)) existing.searchQueries.push(query);
          continue;
        }
        seen.add(key);
        jobs.push(job);
      }
    } catch (e) {
      sources[query] = 0;
      errors.push(`adzuna "${query}": ${e.message}`);
    }
  }
  return withSourceStatus({ jobs, sources, errors, available: true });
}
