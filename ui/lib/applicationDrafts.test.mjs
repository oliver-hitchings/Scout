import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createApplicationDraft, saveApplicationDraft } from './applicationDrafts.mjs';
import { mergeWorkspaceDefaults, writeWorkspaceConfig } from './workspace.mjs';
import { cvPdfPath, renderCvTarget } from './cv.mjs';

async function fixture(t, choose = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-reviewed-draft-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push(value);
    const prompt = value.messages.find(({ role }) => role === 'user')?.content || '';
    const selection = prompt.includes('INPUT_JSON\n') ? (choose?.() || { evidenceIds: [JSON.parse(prompt.split('INPUT_JSON\n')[1]).evidence[0].id] }) : { ready: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(selection) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  writeWorkspaceConfig(root, mergeWorkspaceDefaults({ ai: { provider: 'local', local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'synthetic/model', retries: 0, timeoutMs: 2000 } } }));
  fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cv/master-cv.md'), '# Synthetic CV\n\n## Confirmed experience\n' + '- Supported a team using confirmed evidence only.\n'.repeat(20));
  fs.writeFileSync(path.join(root, 'data/opportunities.json'), JSON.stringify({ opportunities: [{ id: 'synthetic-role', company: 'Example Cooperative', role: 'Coordinator', description: 'Coordinate a team.' }] }));
  return { root, requests };
}

function fakeTypst(root) {
  return (_command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { fs.writeFileSync(path.join(root, args.at(-1)), '%PDF-1.7\nSynthetic reviewed draft PDF'); child.emit('close', 0); });
    return child;
  };
}

for (const kind of ['cv', 'cover-letter']) {
  test(`a local HTTP model creates an editable ${kind} draft only after review, then exports through Typst`, async (t) => {
    const { root, requests } = await fixture(t);
    const draft = await createApplicationDraft(root, { opportunityId: 'synthetic-role', kind });
    assert.match(draft.markdown, /DRAFT/);
    assert.match(draft.markdown, /Supported a team using confirmed evidence only/);
    assert.equal(fs.existsSync(path.join(root, 'applications')), false);
    assert.throws(() => saveApplicationDraft(root, { ...draft, confirmed: false }), /confirm/i);
    const saved = saveApplicationDraft(root, { ...draft, markdown: draft.markdown + '\nA human-reviewed edit.\n', confirmed: true });
    assert.match(fs.readFileSync(path.join(root, saved.path), 'utf8'), /human-reviewed edit/);
    assert.ok(requests.some((request) => request.response_format?.type === 'json_schema'));
    await renderCvTarget(root, { target: saved.target, slug: saved.slug }, { runtimeResolver: () => ({ available: true, command: 'synthetic-typst' }), spawnImpl: fakeTypst(root) });
    assert.match(fs.readFileSync(cvPdfPath(root, { target: saved.target, slug: saved.slug }), 'utf8'), /Synthetic reviewed draft PDF/);
    assert.equal(fs.existsSync(path.join(root, 'applications/synthetic-role/cv.typ')), false, 'the guided draft never replaces an existing application CV');
  });
}

test('a changed CV, job or existing draft invalidates approval; pending CV recovery prevents provider work', async (t) => {
  const { root, requests } = await fixture(t);
  const draft = await createApplicationDraft(root, { opportunityId: 'synthetic-role', kind: 'cv' });
  fs.appendFileSync(path.join(root, 'cv/master-cv.md'), '\nA newer approved fact.');
  assert.throws(() => saveApplicationDraft(root, { ...draft, confirmed: true }), /changed|regenerate/i);
  fs.writeFileSync(path.join(root, 'cv/living-cv-approval.json'), '{}');
  const before = requests.length;
  await assert.rejects(createApplicationDraft(root, { opportunityId: 'synthetic-role', kind: 'cv' }), /recover/i);
  assert.equal(requests.length, before);
});

test('local model cannot add unsupported evidence IDs or invented prose to the trusted draft', async (t) => {
  const { root } = await fixture(t, () => ({ evidenceIds: ['unit-999'], markdown: 'An invented qualification.' }));
  await assert.rejects(createApplicationDraft(root, { opportunityId: 'synthetic-role', kind: 'cv' }), (error) => !/invented qualification/.test(error.message));
  assert.equal(fs.existsSync(path.join(root, 'applications')), false);
});

for (const changed of ['job', 'draft']) {
  test(`a changed ${changed} cannot be overwritten by an older generated draft`, async (t) => {
    const { root } = await fixture(t);
    const draft = await createApplicationDraft(root, { opportunityId: 'synthetic-role', kind: 'cv' });
    if (changed === 'job') {
      fs.writeFileSync(path.join(root, 'data/opportunities.json'), JSON.stringify({ opportunities: [{ id: 'synthetic-role', role: 'Newly changed role', company: 'Example Cooperative' }] }));
    } else {
      fs.mkdirSync(path.join(root, 'applications/synthetic-role'), { recursive: true });
      fs.writeFileSync(path.join(root, 'applications/synthetic-role/draft-cv.md'), 'A newer human edit.');
    }
    assert.throws(() => saveApplicationDraft(root, { ...draft, confirmed: true }), /changed|regenerate/i);
    if (changed === 'draft') assert.equal(fs.readFileSync(path.join(root, 'applications/synthetic-role/draft-cv.md'), 'utf8'), 'A newer human edit.');
  });
}
