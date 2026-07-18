import { randomUUID } from 'node:crypto';

export const COMPANY_TIMELINE_VERSION = 1;
export const COMMUNICATION_KINDS = ['message', 'call', 'meeting', 'interview', 'application', 'note'];
export const COMMUNICATION_DIRECTIONS = ['inbound', 'outbound', 'note'];
export const COMMUNICATION_CHANNELS = ['linkedin', 'email', 'phone', 'video', 'in-person', 'other'];

const OPPORTUNITY_ID = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function companyId(name) {
  const id = String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id) throw new Error('company name is required');
  return id;
}

export function emptyCompanyTimeline(company) {
  const name = String(company || '').trim();
  if (!name) throw new Error('company name is required');
  return {
    schemaVersion: COMPANY_TIMELINE_VERSION,
    company: name,
    contacts: [],
    communications: [],
  };
}

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('contact link must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('contact link must use http or https');
  return url.href;
}

function contactKey(name) { return String(name || '').trim().toLowerCase(); }

function cleanContact(contact, fallbackId = '') {
  const name = String(contact?.name || '').trim();
  if (!name) throw new Error('contact name is required');
  return {
    id: String(contact?.id || fallbackId || companyId(name)),
    name,
    role: String(contact?.role || '').trim(),
    linkedin: cleanUrl(contact?.linkedin),
  };
}

export function normalizeCompanyTimeline(raw, company) {
  if (!raw) return emptyCompanyTimeline(company);
  const version = Number(raw.schemaVersion || 1);
  if (version > COMPANY_TIMELINE_VERSION) throw new Error(`unsupported company timeline version: ${version}`);
  const clean = emptyCompanyTimeline(raw.company || company);
  clean.contacts = (Array.isArray(raw.contacts) ? raw.contacts : []).map((contact) => cleanContact(contact));
  clean.communications = (Array.isArray(raw.communications) ? raw.communications : []).map((item) => ({ ...item }));
  return clean;
}

function uniqueContactId(record, seed) {
  const base = companyId(seed);
  const used = new Set((record.contacts || []).map((contact) => contact.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function upsertContact(record, contact) {
  const next = structuredClone(record);
  const name = String(contact?.name || '').trim();
  if (!name) return { record: next, contactId: null };
  const index = next.contacts.findIndex((item) => contactKey(item.name) === contactKey(name));
  if (index >= 0) {
    const current = next.contacts[index];
    next.contacts[index] = cleanContact({
      ...current,
      name,
      role: String(contact?.role || '').trim() || current.role,
      linkedin: String(contact?.linkedin || '').trim() || current.linkedin,
    }, current.id);
    return { record: next, contactId: current.id };
  }
  const clean = cleanContact(contact, uniqueContactId(next, name));
  next.contacts.push(clean);
  return { record: next, contactId: clean.id };
}

function cleanOpportunityIds(ids) {
  const values = Array.isArray(ids) ? ids : [];
  const unique = [...new Set(values.map((id) => String(id || '').trim()).filter(Boolean))];
  for (const id of unique) if (!OPPORTUNITY_ID.test(id)) throw new Error(`invalid opportunity id: ${id}`);
  return unique;
}

export function addCommunication(record, input, {
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  const text = String(input?.text || '');
  if (!text.trim()) throw new Error('communication text is required');
  const date = String(input?.date || '').trim();
  if (!DATE.test(date)) throw new Error('communication date must be YYYY-MM-DD');
  const kind = String(input?.kind || 'message');
  const direction = String(input?.direction || 'note');
  const channel = String(input?.channel || 'other');
  if (!COMMUNICATION_KINDS.includes(kind)) throw new Error(`invalid communication kind: ${kind}`);
  if (!COMMUNICATION_DIRECTIONS.includes(direction)) throw new Error(`invalid communication direction: ${direction}`);
  if (!COMMUNICATION_CHANNELS.includes(channel)) throw new Error(`invalid communication channel: ${channel}`);

  const contactResult = upsertContact(record, input?.contact || {});
  const next = contactResult.record;
  const item = {
    id: String(idFactory()),
    date,
    kind,
    direction,
    channel,
    contactId: contactResult.contactId,
    opportunityIds: cleanOpportunityIds(input?.opportunityIds),
    text,
    createdAt: String(now()),
  };
  next.communications.push(item);
  return next;
}

export function removeCommunication(record, id) {
  const next = structuredClone(record);
  const index = next.communications.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`communication not found: ${id}`);
  next.communications.splice(index, 1);
  return next;
}

function currentStage(entry) {
  const stages = Array.isArray(entry.application?.stages) ? entry.application.stages : [];
  return stages.find((stage) => !stage.completed)?.name || null;
}

function relatedOpportunities(tracker, company) {
  const wanted = companyId(company);
  return (tracker.opportunities || [])
    .filter((entry) => companyId(entry.company) === wanted)
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      location: entry.location || '',
      status: entry.status || '',
      appliedDate: entry.application?.appliedDate || null,
      currentStage: currentStage(entry),
    }));
}

function mergedContacts(record, entries) {
  const contacts = structuredClone(record.contacts || []);
  const seen = new Set(contacts.map((contact) => contactKey(contact.name)));
  for (const entry of entries) {
    for (const contact of entry.contacts || []) {
      const key = contactKey(contact.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      contacts.push({
        id: `tracker-${entry.id}-${companyId(contact.name)}`,
        name: String(contact.name || '').trim(),
        role: String(contact.role || '').trim(),
        linkedin: String(contact.linkedin || '').trim(),
        source: 'tracker',
      });
    }
  }
  return contacts;
}

function trackerTimeline(entries) {
  const items = [];
  for (const entry of entries) {
    for (const [index, event] of (entry.log || []).entries()) {
      items.push({
        id: `tracker-log-${entry.id}-${index}`,
        date: event.date || '',
        kind: 'application',
        direction: 'note',
        channel: 'other',
        contactId: null,
        opportunityIds: [entry.id],
        text: `${event.event}${event.note ? `: ${event.note}` : ''}`,
        source: 'tracker',
      });
    }
    for (const [index, stage] of (entry.application?.stages || []).entries()) {
      if (!stage.date) continue;
      items.push({
        id: `tracker-stage-${entry.id}-${index}`,
        date: stage.date,
        kind: /interview|screen|call|assessment/i.test(stage.name) ? 'interview' : 'application',
        direction: 'note',
        channel: 'other',
        contactId: null,
        opportunityIds: [entry.id],
        text: `${stage.name}${stage.completed ? ' completed' : ' scheduled'}`,
        source: 'tracker',
      });
    }
  }
  return items;
}

export function buildCompanyTimelineView(tracker, opportunityId, record) {
  const selected = (tracker.opportunities || []).find((entry) => entry.id === opportunityId);
  if (!selected) throw new Error(`opportunity not found: ${opportunityId}`);
  const opportunities = relatedOpportunities(tracker, selected.company);
  const ids = new Set(opportunities.map((entry) => entry.id));
  const entries = (tracker.opportunities || []).filter((entry) => ids.has(entry.id));
  const timeline = [
    ...(record.communications || []).map((item) => ({ ...item, source: 'company' })),
    ...trackerTimeline(entries),
  ].sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''));
    if (byDate) return byDate;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return {
    companyId: companyId(selected.company),
    company: selected.company,
    selectedOpportunityId: opportunityId,
    opportunities,
    contacts: mergedContacts(record, entries),
    timeline,
  };
}
