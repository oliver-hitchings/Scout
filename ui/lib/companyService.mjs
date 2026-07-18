import {
  addCommunication, buildCompanyTimelineView, companyId, removeCommunication,
} from './companyTimeline.mjs';
import { loadCompanyTimeline, saveCompanyTimeline } from './companyStore.mjs';

function replyJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function parseBody(body) {
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

export function registerCompanyRoutes({
  routes, repoRoot, readTracker, onCheckpoint = () => Promise.resolve(),
}) {
  function context(id) {
    const tracker = readTracker();
    const entry = (tracker.opportunities || []).find((item) => item.id === id);
    if (!entry) throw new Error(`opportunity not found: ${id}`);
    const record = loadCompanyTimeline(repoRoot, entry.company);
    return { tracker, entry, record };
  }

  function viewOf(id, values = null) {
    const { tracker, entry, record } = values || context(id);
    return buildCompanyTimelineView(tracker, id, record);
  }

  routes['GET /api/company'] = (req, res, body, url) => {
    const id = url.searchParams.get('id') || '';
    try { return replyJson(res, 200, viewOf(id)); }
    catch (error) { return replyJson(res, /not found/.test(error.message) ? 404 : 400, { error: error.message }); }
  };

  routes['POST /api/company/communication'] = (req, res, body) => {
    const payload = parseBody(body);
    if (!payload) return replyJson(res, 400, { error: 'bad json' });
    let values;
    try { values = context(payload.id || ''); }
    catch (error) { return replyJson(res, 404, { error: error.message }); }
    try {
      const related = new Set((values.tracker.opportunities || [])
        .filter((item) => companyId(item.company) === companyId(values.entry.company))
        .map((item) => item.id));
      const opportunityIds = payload.communication?.opportunityIds || [];
      for (const opportunityId of opportunityIds) {
        if (!related.has(opportunityId)) throw new Error(`opportunity does not belong to ${values.entry.company}: ${opportunityId}`);
      }
      values.record = addCommunication(values.record, payload.communication || {});
      saveCompanyTimeline(repoRoot, values.entry.company, values.record);
      void onCheckpoint(`company: communication - ${values.entry.company}`);
      return replyJson(res, 200, { ok: true, ...viewOf(payload.id, values) });
    } catch (error) {
      return replyJson(res, 400, { error: error.message });
    }
  };

  routes['POST /api/company/communication/remove'] = (req, res, body) => {
    const payload = parseBody(body);
    if (!payload) return replyJson(res, 400, { error: 'bad json' });
    let values;
    try { values = context(payload.id || ''); }
    catch (error) { return replyJson(res, 404, { error: error.message }); }
    try {
      values.record = removeCommunication(values.record, String(payload.communicationId || ''));
      saveCompanyTimeline(repoRoot, values.entry.company, values.record);
      void onCheckpoint(`company: remove communication - ${values.entry.company}`);
      return replyJson(res, 200, { ok: true, ...viewOf(payload.id, values) });
    } catch (error) {
      return replyJson(res, 400, { error: error.message });
    }
  };
}
