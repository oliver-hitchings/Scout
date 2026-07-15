import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCompanyRoutes } from './companyService.mjs';

class MockResponse {
  constructor() { this.statusCode = null; this.headers = {}; this.body = ''; }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; }
  end(value = '') { this.body += value; }
  json() { return JSON.parse(this.body || '{}'); }
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-company-service-'));
  const tracker = { opportunities: [
    { id: 'acme-hardware-2026-07', company: 'Acme', role: 'Hardware Engineer', status: 'applied', contacts: [], log: [] },
    { id: 'acme-electronics-2026-07', company: 'ACME', role: 'Electronics Engineer', status: 'new', contacts: [], log: [] },
    { id: 'other-role-2026-07', company: 'Other', role: 'Engineer', status: 'new', contacts: [], log: [] },
  ] };
  const routes = {};
  const checkpoints = [];
  registerCompanyRoutes({
    routes, repoRoot, readTracker: () => tracker,
    onCheckpoint: (reason) => { checkpoints.push(reason); return Promise.resolve(); },
  });
  return { repoRoot, routes, checkpoints };
}

test('company routes save correspondence and expose it from another company role', () => {
  const { routes, checkpoints } = fixture();
  const save = new MockResponse();
  routes['POST /api/company/communication']({}, save, JSON.stringify({
    id: 'acme-hardware-2026-07',
    communication: {
      date: '2026-07-14', kind: 'message', direction: 'inbound', channel: 'linkedin',
      contact: { name: 'Jamie', role: 'Recruiter' },
      opportunityIds: ['acme-electronics-2026-07'], text: 'Can we arrange a call?',
    },
  }));
  assert.equal(save.statusCode, 200);
  assert.equal(save.json().timeline[0].text, 'Can we arrange a call?');
  assert.match(checkpoints[0], /Acme/);

  const read = new MockResponse();
  routes['GET /api/company']({}, read, '', new URL('http://127.0.0.1/api/company?id=acme-electronics-2026-07'));
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().timeline[0].text, 'Can we arrange a call?');
  assert.equal(read.json().opportunities.length, 2);
});

test('company routes prevent cross-company links and remove manual updates', () => {
  const { routes } = fixture();
  const bad = new MockResponse();
  routes['POST /api/company/communication']({}, bad, JSON.stringify({
    id: 'acme-hardware-2026-07',
    communication: { date: '2026-07-14', opportunityIds: ['other-role-2026-07'], text: 'Wrong company.' },
  }));
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /does not belong/);

  const save = new MockResponse();
  routes['POST /api/company/communication']({}, save, JSON.stringify({
    id: 'acme-hardware-2026-07', communication: { date: '2026-07-14', text: 'Temporary note.' },
  }));
  const manual = save.json().timeline.find((item) => item.source === 'company');
  const remove = new MockResponse();
  routes['POST /api/company/communication/remove']({}, remove, JSON.stringify({
    id: 'acme-hardware-2026-07', communicationId: manual.id,
  }));
  assert.equal(remove.statusCode, 200);
  assert.equal(remove.json().timeline.filter((item) => item.source === 'company').length, 0);
});

test('company route reports unknown opportunities', () => {
  const { routes } = fixture();
  const read = new MockResponse();
  routes['GET /api/company']({}, read, '', new URL('http://127.0.0.1/api/company?id=missing'));
  assert.equal(read.statusCode, 404);
});
