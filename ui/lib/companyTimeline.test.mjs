import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCommunication, buildCompanyTimelineView, companyId, emptyCompanyTimeline,
  removeCommunication,
} from './companyTimeline.mjs';

test('companyId produces a stable company key', () => {
  assert.equal(companyId('Helsing'), 'helsing');
  assert.equal(companyId('Marks & Spencer'), 'marks-and-spencer');
  assert.throws(() => companyId('---'), /company name/i);
});

test('communications preserve verbatim text and reuse a contact across roles', () => {
  let record = emptyCompanyTimeline('Acme Aerospace');
  record = addCommunication(record, {
    date: '2026-07-14', kind: 'message', direction: 'inbound', channel: 'linkedin',
    contact: { name: 'Jamie Recruiter', role: 'Talent Partner' },
    opportunityIds: ['acme-hardware-2026-07'], text: ' Would you like to have a chat?\nSecond line.\n',
  }, { idFactory: () => 'message-1', now: () => '2026-07-14T10:00:00.000Z' });
  record = addCommunication(record, {
    date: '2026-07-15', kind: 'message', direction: 'outbound', channel: 'linkedin',
    contact: { name: 'jamie recruiter', linkedin: 'https://www.linkedin.com/in/jamie/' },
    opportunityIds: ['acme-electronics-2026-07'], text: 'Yes, Monday works.',
  }, { idFactory: () => 'message-2', now: () => '2026-07-15T10:00:00.000Z' });

  assert.equal(record.contacts.length, 1);
  assert.equal(record.contacts[0].role, 'Talent Partner');
  assert.equal(record.contacts[0].linkedin, 'https://www.linkedin.com/in/jamie/');
  assert.equal(record.communications[0].text, ' Would you like to have a chat?\nSecond line.\n');
  assert.equal(record.communications[0].contactId, record.communications[1].contactId);
});

test('company view groups related roles and derives existing tracker history', () => {
  const tracker = { opportunities: [
    {
      id: 'acme-hardware-2026-07', company: 'Acme', role: 'Hardware Engineer', location: 'Oxford', status: 'applied',
      contacts: [{ name: 'Jamie Recruiter', role: 'Talent Partner', linkedin: '' }],
      log: [{ date: '2026-07-10', event: 'outreach-sent', note: 'Application submitted.' }],
      application: { appliedDate: '2026-07-10', stages: [{ name: 'Applied', completed: true, date: '2026-07-10' }] },
    },
    {
      id: 'acme-electronics-2026-07', company: 'ACME', role: 'Electronics Engineer', location: 'Oxford', status: 'new',
      contacts: [], log: [],
    },
    { id: 'other-role-2026-07', company: 'Other', role: 'Engineer', status: 'new', contacts: [], log: [] },
  ] };
  const record = addCommunication(emptyCompanyTimeline('Acme'), {
    date: '2026-07-14', kind: 'message', direction: 'inbound', channel: 'linkedin',
    contact: { name: 'Jamie Recruiter' }, opportunityIds: ['acme-electronics-2026-07'], text: 'Hello.',
  }, { idFactory: () => 'message-1', now: () => '2026-07-14T10:00:00.000Z' });

  const view = buildCompanyTimelineView(tracker, 'acme-electronics-2026-07', record);
  assert.equal(view.companyId, 'acme');
  assert.deepEqual(view.opportunities.map((entry) => entry.id), ['acme-hardware-2026-07', 'acme-electronics-2026-07']);
  assert.equal(view.contacts.length, 1);
  assert.equal(view.timeline[0].id, 'message-1');
  assert.ok(view.timeline.some((item) => item.source === 'tracker' && item.text.includes('Application submitted')));
});

test('invalid communications are rejected and manual items can be removed', () => {
  const record = emptyCompanyTimeline('Acme');
  assert.throws(() => addCommunication(record, { date: '14/07/2026', text: 'hello' }), /YYYY-MM-DD/);
  assert.throws(() => addCommunication(record, { date: '2026-07-14', channel: 'carrier-pigeon', text: 'hello' }), /channel/);
  const withItem = addCommunication(record, { date: '2026-07-14', text: 'hello' }, { idFactory: () => 'one' });
  assert.equal(removeCommunication(withItem, 'one').communications.length, 0);
  assert.throws(() => removeCommunication(withItem, 'missing'), /not found/);
});
