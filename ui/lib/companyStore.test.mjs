import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { companyTimelinePath, loadCompanyTimeline, saveCompanyTimeline } from './companyStore.mjs';
import { emptyCompanyTimeline } from './companyTimeline.mjs';

test('company timeline storage is private-workspace scoped and round-trips', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-company-'));
  const file = companyTimelinePath(root, 'Acme Aerospace');
  assert.equal(file, path.join(root, 'data', 'companies', 'acme-aerospace.json'));
  assert.equal(loadCompanyTimeline(root, 'Acme Aerospace').communications.length, 0);
  const record = emptyCompanyTimeline('Acme Aerospace');
  record.contacts.push({ id: 'jamie', name: 'Jamie', role: 'Recruiter', linkedin: '' });
  saveCompanyTimeline(root, 'Acme Aerospace', record);
  assert.equal(loadCompanyTimeline(root, 'Acme Aerospace').contacts[0].name, 'Jamie');
});

test('company timeline paths slug traversal-like company names inside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-company-'));
  assert.equal(companyTimelinePath(root, '../outside'), path.join(root, 'data', 'companies', 'outside.json'));
});
