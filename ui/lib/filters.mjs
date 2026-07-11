export const ORIGIN_POSTCODE = '';
export const DEFAULT_COMMUTE_FILTER = Object.freeze({
  mode: 'either',
  maxMinutes: 180,
  includeUnknown: true,
});

export const JOB_CATEGORIES = [
  { id: 'startup', label: 'Priority', description: 'The workspace primary opportunity lane.' },
  { id: 'established', label: 'Explore', description: 'The workspace secondary opportunity lane.' },
];

const CATEGORY_IDS = new Set(JOB_CATEGORIES.map((c) => c.id));
const LEGACY_ESTABLISHED = new Set(['corporate', 'mainstream', 'bigtech', 'big-tech', 'prime', 'standard']);
const LEGACY_STARTUP = new Set(['scaleup', 'hidden', 'speculative']);

export function normaliseCategory(category) {
  const value = String(category || '').trim().toLowerCase();
  if (!value) return 'startup';
  if (LEGACY_STARTUP.has(value)) return 'startup';
  if (LEGACY_ESTABLISHED.has(value)) return 'established';
  if (CATEGORY_IDS.has(value)) return value;
  if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) return value;
  throw new Error(`invalid category: ${category}`);
}

export function categoryOf(entry) {
  if (entry.category || entry.jobCategory) return normaliseCategory(entry.category || entry.jobCategory);
  return 'startup';
}

export function commuteOf(entry) {
  return entry.commute || {};
}

export function minuteValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function commuteMinutes(entry, mode) {
  const commute = commuteOf(entry);
  if (mode === 'car') return minuteValue(commute.carMinutes);
  if (mode === 'public') return minuteValue(commute.publicTransportMinutes ?? commute.trainMinutes);
  return null;
}

function maxValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function normaliseCommuteMode(value) {
  const mode = String(value || DEFAULT_COMMUTE_FILTER.mode).trim().toLowerCase();
  if (['either', 'car', 'public', 'any'].includes(mode)) return mode;
  throw new Error(`invalid commute mode: ${value}`);
}

export function matchesCommute(entry, filter = {}) {
  const includeUnknown = filter.includeUnknown !== false;
  const mode = normaliseCommuteMode(filter.mode);
  if (mode === 'any') return true;
  const max = maxValue(filter.maxMinutes ?? DEFAULT_COMMUTE_FILTER.maxMinutes);
  if (max === null) return true;
  const car = commuteMinutes(entry, 'car');
  const pub = commuteMinutes(entry, 'public');
  if (mode === 'car') return car === null ? includeUnknown : car <= max;
  if (mode === 'public') return pub === null ? includeUnknown : pub <= max;
  const known = [car, pub].filter((minutes) => minutes !== null);
  return known.length ? known.some((minutes) => minutes <= max) : includeUnknown;
}

export function filterOpportunities(entries, { category = 'all', commute = {} } = {}) {
  return (entries || []).filter((entry) => {
    const categoryOk = category === 'all' || categoryOf(entry) === normaliseCategory(category);
    return categoryOk && matchesCommute(entry, commute);
  });
}

export function commuteLabel(entry) {
  const car = commuteMinutes(entry, 'car');
  const pub = commuteMinutes(entry, 'public');
  const bits = [];
  if (car !== null) bits.push(`car ${car}m`);
  if (pub !== null) bits.push(`public ${pub}m`);
  if (!bits.length) return '';
  const checked = entry.commute?.checked ? ` checked ${entry.commute.checked}` : '';
  const origin = entry.commute?.originPostcode || ORIGIN_POSTCODE;
  return `${bits.join(' / ')}${origin ? ` from ${origin}` : ''}${checked}`;
}
