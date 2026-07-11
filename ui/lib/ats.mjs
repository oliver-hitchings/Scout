import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_ATS = ['greenhouse', 'lever', 'ashby'];

function stripHtml(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response || !response.ok) throw new Error(`fetch failed ${response?.status || ''}`.trim());
  return response.json();
}

function normalise(job, portal, fields) {
  return {
    title: fields.title || '',
    company: portal.name,
    description: fields.description || '',
    url: fields.url || '',
    salary: fields.salary || null,
    location: fields.location || '',
    workingType: fields.workingType || '',
    postedDate: fields.postedDate || null,
    source: `ats-${portal.ats}`,
    portal: { name: portal.name, ats: portal.ats, token: portal.token },
    tags: portal.tags || [],
  };
}

export async function fetchGreenhouse(portal, fetchImpl = globalThis.fetch) {
  const data = await getJson(`https://api.greenhouse.io/v1/boards/${encodeURIComponent(portal.token)}/jobs?content=true`, fetchImpl);
  return (data.jobs || []).map((job) => normalise(job, portal, {
    title: job.title,
    description: stripHtml(job.content),
    url: job.absolute_url,
    location: job.location?.name,
    postedDate: (job.updated_at || '').slice(0, 10) || null,
  }));
}

export async function fetchLever(portal, fetchImpl = globalThis.fetch) {
  const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(portal.token)}?mode=json`, fetchImpl);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((job) => normalise(job, portal, {
    title: job.text,
    description: stripHtml(job.descriptionPlain || job.description),
    url: job.hostedUrl,
    location: job.categories?.location,
    workingType: job.categories?.commitment,
  }));
}

export async function fetchAshby(portal, fetchImpl = globalThis.fetch) {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(portal.token)}`, fetchImpl);
  return (data.jobs || []).map((job) => normalise(job, portal, {
    title: job.title,
    description: stripHtml(job.descriptionPlain || job.descriptionHtml),
    url: job.jobUrl,
    location: job.location,
    workingType: job.employmentType,
    postedDate: (job.publishedDate || '').slice(0, 10) || null,
  }));
}

export function parsePortalConfig(text) {
  const parsed = JSON.parse(text);
  const portals = Array.isArray(parsed.portals) ? parsed.portals : [];
  return portals.map((portal) => ({
    name: String(portal.name || '').trim(),
    ats: String(portal.ats || '').trim().toLowerCase(),
    token: String(portal.token || '').trim(),
    careersUrl: portal.careersUrl || '',
    enabled: portal.enabled !== false,
    tags: Array.isArray(portal.tags) ? portal.tags : [],
  })).filter((portal) => portal.name);
}

export function loadPortals(repoRoot, relPath = 'data/ats-portals.json') {
  const file = path.join(repoRoot, relPath);
  if (!fs.existsSync(file)) return [];
  return parsePortalConfig(fs.readFileSync(file, 'utf8'));
}

export async function fetchPortal(portal, fetchImpl = globalThis.fetch) {
  if (!portal.enabled) return [];
  if (!SUPPORTED_ATS.includes(portal.ats)) return [];
  if (!portal.token) throw new Error(`${portal.name}: missing ${portal.ats} token`);
  if (portal.ats === 'greenhouse') return fetchGreenhouse(portal, fetchImpl);
  if (portal.ats === 'lever') return fetchLever(portal, fetchImpl);
  return fetchAshby(portal, fetchImpl);
}

export async function fetchConfiguredPortals(repoRoot, fetchImpl = globalThis.fetch) {
  const portals = loadPortals(repoRoot);
  const jobs = [];
  const sources = {};
  const errors = [];
  for (const portal of portals) {
    if (!portal.enabled || !SUPPORTED_ATS.includes(portal.ats)) continue;
    try {
      const found = await fetchPortal(portal, fetchImpl);
      jobs.push(...found);
      sources[portal.name] = found.length;
    } catch (e) {
      errors.push(`${portal.name}: ${e.message}`);
      sources[portal.name] = 0;
    }
  }
  return { jobs, sources, errors, portalsChecked: Object.keys(sources).length };
}

export function portalSummary(portals) {
  return portals.map((portal) => ({
    name: portal.name,
    ats: portal.ats,
    enabled: portal.enabled,
    careersUrl: portal.careersUrl,
    tags: portal.tags,
    supported: SUPPORTED_ATS.includes(portal.ats),
  }));
}

