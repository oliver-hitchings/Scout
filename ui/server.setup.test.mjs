import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { approveLivingCv, approvedLivingCvEvidence, configureLivingCv, livingCvStatus } from './lib/livingCv.mjs';
import { atomicWriteFile } from './lib/atomicWrite.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-setup-http-'));
const port = 19000 + Math.floor(Math.random() * 10000);
let child;
let controlId = 0;

// Run the production entry point with an IPC-only fixture control. Holding one
// real Git child makes checkpoint overlap reproducible on every host.
async function setupServerFixture() {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const spawnChild = childProcess.spawn;
  let holdRequest = null;
  let heldChild = null;
  childProcess.spawn = (command, args, options) => {
    if (command !== 'git' || holdRequest === null) return spawnChild(command, args, options);
    const id = holdRequest;
    holdRequest = null;
    const script = `
      const { spawnSync } = require('node:child_process');
      process.once('message', () => {
        const result = spawnSync('git', process.argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
        process.exit(result.status ?? 1);
      });
      process.send('ready');
    `;
    heldChild = spawnChild(process.execPath, ['-e', script, ...args], {
      ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    heldChild.once('message', () => process.send({ id, ok: true }));
    return heldChild;
  };
  syncBuiltinESMExports();
  // argv[1] remains the real server path, so its normal startup and shutdown
  // paths execute just as they do when launched directly.
  const server = await import(pathToFileURL(process.argv[1]));
  process.on('message', async ({ id, action }) => {
    try {
      if (action === 'hold-checkpoint') {
        holdRequest = id;
        void server.scheduleCheckpoint('synthetic delayed checkpoint');
        void server.drainScheduledCheckpoints();
        return; // Reply only once the Git child is alive under the fence.
      }
      if (action !== 'drain-checkpoints') throw new Error('unknown fixture control');
      if (heldChild) {
        heldChild.send('continue');
        heldChild = null;
      }
      await server.drainScheduledCheckpoints();
      process.send({ id, ok: true });
    } catch (error) {
      process.send({ id, error: error.message });
    }
  });
}

function serverControl(action) {
  const id = ++controlId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`setup fixture control timed out: ${action}`)); }, 10000);
    const onExit = () => { cleanup(); reject(new Error('setup fixture server exited during control')); };
    const onMessage = (message) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ id, action });
  });
}

function simplePdf(text = '') {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = text ? `BT /F1 12 Tf 50 750 Td (${escaped}) Tj ET` : 'q Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function compressedPdf(text) {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 50 750 Td (${escaped}) Tj ET`));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const value = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(value);
    length += value.length;
  });
  const xref = length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  chunks.push(Buffer.from(offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function blankPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function simpleDocx(text) {
  return storedZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ]);
}

function request({ method = 'GET', route, body, rawBody }) {
  const payload = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: route,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

before(async () => {
  child = spawn(process.execPath, ['--input-type=module', '--eval', `(${setupServerFixture.toString()})();`, path.join(appRoot, 'ui/server.mjs')], {
    cwd: appRoot,
    env: { ...process.env, SCOUT_WORKSPACE: workspace, SCOUT_DEVICE_SETTINGS: path.join(workspace, '.scout', 'device-settings.json'), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('setup test server did not start')), 10000);
    child.once('exit', (code) => reject(new Error(`setup test server exited early (${code})`)));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Scout UI on')) { clearTimeout(timer); resolve(); }
    });
  });
});

after(async () => {
  let drainError = null;
  if (child && child.exitCode === null) {
    try {
      const drained = await request({
        method: 'POST',
        route: '/api/sync/backup',
        body: { reason: 'setup test cleanup' },
      });
      assert.equal(drained.status, 200, drained.text);
      await serverControl('drain-checkpoints');
    } catch (error) {
      drainError = error;
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  fs.rmSync(workspace, { recursive: true, force: true });
  if (drainError) throw drainError;
});

test('fresh setup waits for an explicit local create or restore choice', async () => {
  const status = await request({ route: '/api/setup/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json.bootstrap, true);
  assert.equal(status.json.trackerExists, false);
  const created = await request({ method: 'POST', route: '/api/workspace/create', body: {} });
  assert.equal(created.status, 200, created.text);
  assert.equal(fs.existsSync(path.join(workspace, 'workspace.json')), true);
  assert.equal(fs.existsSync(path.join(workspace, 'data', 'opportunities.json')), true);
});

test('setup status never echoes saved credentials', async () => {
  const saved = await request({ method: 'POST', route: '/api/setup/credentials', body: { appId: 'synthetic-id', apiKey: ['synthetic', 'secret'].join('-') } });
  assert.deepEqual(saved.json, { ok: true, configured: true });
  assert.doesNotMatch(saved.text, /synthetic-(?:id|secret)/);

  const status = await request({ route: '/api/setup/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json.adzunaConfigured, true);
  assert.equal(typeof status.json.schedule.enabled, 'boolean');
  assert.equal(status.json.schedule.lastResult, 'never');
  assert.doesNotMatch(status.text, /synthetic-(?:id|secret)/);
  assert.match(fs.readFileSync(path.join(workspace, '.env'), 'utf8'), /ADZUNA_API_KEY=synthetic-secret/);
});

test('a fresh server can serve opportunities before setup status is requested', async () => {
  const response = await request({ route: '/api/opportunities' });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.opportunities));
  assert.equal(typeof response.json.schedule.configured, 'boolean');
});

test('saving setup config seeds a fresh generic workspace', async () => {
  const response = await request({
    method: 'POST', route: '/api/setup/config',
    body: { profile: { displayName: 'Example Person' }, search: { roleFamilies: ['Product design'] } },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.config.profile.displayName, 'Example Person');
  assert.deepEqual(response.json.config.search.roleFamilies, ['Product design']);
  for (const relative of ['workspace.json', 'data/opportunities.json', 'profile/context.md', 'profile/calibration.md', 'AGENTS.md']) {
    assert.equal(fs.existsSync(path.join(workspace, relative)), true, `${relative} should be seeded`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(workspace, 'profile', 'context.md'), 'utf8'), /Oliver|hardware|electronics/i);
});

test('master CV saves reject an empty replacement without changing the active file', async () => {
  const file = path.join(workspace, 'cv', 'master-cv.md');
  const before = fs.readFileSync(file, 'utf8');
  const response = await request({ method: 'POST', route: '/api/cv/save', body: { path: 'cv/master-cv.md', content: '' } });
  assert.equal(response.status, 409);
  assert.match(response.json.error, /empty or incomplete/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('Living CV API requires exact review, rejects stale approval and preserves local history', async () => {
  const source = path.join(os.tmpdir(), `scout-synthetic-cv-${process.pid}.md`);
  const file = path.join(workspace, 'cv/master-cv.md');
  const previous = fs.readFileSync(file, 'utf8');
  const text = '# Synthetic CV\n' + 'Confirmed experience. '.repeat(40);
  fs.writeFileSync(source, text);
  try {
    const configured = await request({ method: 'POST', route: '/api/cv/living/source', body: { sourcePath: source } });
    assert.equal(configured.status, 200);
    assert.equal(configured.json.state, 'changed');
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
    const unconfirmed = await request({ method: 'POST', route: '/api/cv/living/approve', body: { revision: configured.json.revision } });
    assert.equal(unconfirmed.status, 409);
    fs.appendFileSync(source, '\nA later edit.');
    const stale = await request({ method: 'POST', route: '/api/cv/living/approve', body: { revision: configured.json.revision, confirmed: true } });
    assert.equal(stale.status, 409);
    const status = await request({ route: '/api/cv/living' });
    const accepted = await request({ method: 'POST', route: '/api/cv/living/approve', body: { revision: status.json.revision, confirmed: true } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.state, 'current');
    assert.equal(accepted.json.versions.length, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), text + '\nA later edit.');
  } finally {
    fs.rmSync(source, { force: true });
    fs.writeFileSync(file, previous);
  }
});

test('the CV status API reconciles an interrupted approval before showing it as current', async () => {
  const source = path.join(os.tmpdir(), `scout-synthetic-recovery-cv-${process.pid}.md`);
  const content = '# Synthetic reviewed CV\n' + 'Current confirmed evidence. '.repeat(35);
  fs.writeFileSync(source, content);
  try {
    await request({ method: 'POST', route: '/api/sync/backup', body: { reason: 'synthetic approval recovery' } });
    await serverControl('hold-checkpoint');
    // A manual backup response does not drain the coalesced automatic batch.
    // Wait for this server's actual scheduled and active checkpoint work.
    await serverControl('drain-checkpoints');
    configureLivingCv(workspace, source);
    assert.throws(() => approveLivingCv(workspace, { revision: livingCvStatus(workspace).revision, confirmed: true }, {
      writeFile(file, value, options) { if (file.endsWith('living-cv.json')) throw new Error('synthetic interruption'); atomicWriteFile(file, value, options); },
    }), /interruption/);
    assert.equal(livingCvStatus(workspace).state, 'recovery-needed');
    const status = await request({ route: '/api/cv/living' });
    assert.equal(status.status, 200);
    assert.equal(status.json.state, 'current');
    assert.equal(approvedLivingCvEvidence(workspace), content);
    assert.ok(!fs.existsSync(path.join(workspace, 'cv/living-cv-approval.json')));
  } finally {
    await serverControl('drain-checkpoints');
    fs.rmSync(source, { force: true });
  }
});

test('fresh setup cannot be marked complete before trusted proposal activation', async () => {
  await serverControl('hold-checkpoint');
  try {
    await serverControl('drain-checkpoints');
    const completed = await request({ method: 'POST', route: '/api/setup/complete', body: {} });
    assert.equal(completed.status, 409);
    assert.match(completed.json.error, /activate a complete onboarding proposal/);

    const status = await request({ route: '/api/setup/status' });
    assert.equal(status.json.setupComplete, false);
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'workspace.json'), 'utf8'));
    assert.equal(saved.setup.completedAt, null);
  } finally {
    await serverControl('drain-checkpoints');
  }
});

test('sync status is local-only by default and restore refuses an established workspace', async () => {
  const status = await request({ route: '/api/sync/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json.enabled, false);
  const restore = await request({
    method: 'POST', route: '/api/workspace/restore',
    body: {
      remoteUrl: 'https://github.com/example/scout-workspace',
      [['sec', 'ret'].join('')]: ['synthetic', 'recovery', 'secret'].join(' '),
    },
  });
  assert.equal(restore.status, 409);
  assert.match(restore.json.error, /only before a workspace is created/);
});

test('configured categories and triage thresholds flow through the opportunities API', async () => {
  const configured = await request({
    method: 'POST', route: '/api/setup/config',
    body: { mode: 'active', triage: { actionScore: 82, checkScore: 64 } },
  });
  assert.equal(configured.status, 200);
  fs.writeFileSync(path.join(workspace, 'data', 'search-categories.json'), JSON.stringify({
    categories: [
      { id: 'priority', label: 'Best fit' },
      { id: 'explore', label: 'Worth exploring' },
    ],
  }));
  fs.writeFileSync(path.join(workspace, 'data', 'opportunities.json'), JSON.stringify({
    updated: '2026-01-01',
    opportunities: [
      { id: 'example-action-2026-01', company: 'Example', role: 'Action', status: 'new', score: 82, category: 'priority', tags: [], log: [] },
      { id: 'example-check-2026-01', company: 'Example', role: 'Check', status: 'new', score: 64, category: 'explore', tags: ['Check detail'], log: [] },
      { id: 'example-low-2026-01', company: 'Example', role: 'Low', status: 'new', score: 63, category: 'priority', tags: [], log: [] },
    ],
  }));

  const response = await request({ route: '/api/opportunities' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.categories.map(({ id, label }) => ({ id, label })), [
    { id: 'priority', label: 'Best fit' },
    { id: 'explore', label: 'Worth exploring' },
  ]);
  assert.deepEqual(response.json.triage.action.map((entry) => entry.id), ['example-action-2026-01']);
  assert.deepEqual(response.json.triage.unlock.map((entry) => entry.id), ['example-check-2026-01']);
  assert.equal(response.json.workspaceConfig.triage.actionScore, 82);

  const saved = await request({
    method: 'POST', route: '/api/note',
    body: { id: 'example-action-2026-01', text: 'Synthetic note' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.savedLocally, true);
  assert.equal(saved.json.syncQueued, true);
  assert.equal(Object.hasOwn(saved.json, 'committed'), false);
});

test('setup rejects inverted triage thresholds', async () => {
  const response = await request({
    method: 'POST', route: '/api/setup/config',
    body: { triage: { actionScore: 50, checkScore: 60 } },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.json, {
    error: 'Check score cannot exceed action score.',
    reasonCode: 'invalid-triage-thresholds',
  });
});

test('CV import rejects malformed base64', async () => {
  const response = await request({ method: 'POST', route: '/api/setup/import-cv', body: { name: 'cv.txt', base64: '%%%not-base64%%%' } });
  assert.equal(response.status, 400);
  assert.deepEqual(response.json, { error: 'invalid base64' });
});

test('CV import extracts representative text and Markdown files', async () => {
  for (const [name, content] of [['cv.txt', 'Synthetic CV\nExperience: product design'], ['cv.md', '# Synthetic CV\n\nExperience: operations']]) {
    const response = await request({ method: 'POST', route: '/api/setup/import-cv', body: { name, base64: Buffer.from(content).toString('base64') } });
    assert.equal(response.status, 200);
    assert.equal(response.json.text, content);
    assert.equal(fs.readFileSync(path.join(workspace, response.json.extracted), 'utf8'), `${content}\n`);
  }
});

test('CV import extracts a representative selectable-text PDF', async () => {
  const content = 'Synthetic candidate experience in product design and operations leadership';
  const response = await request({
    method: 'POST', route: '/api/setup/import-cv',
    body: { name: 'cv.pdf', base64: simplePdf(content).toString('base64') },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.match(response.json.text, /Synthetic candidate experience/);
});

test('CV import extracts a compressed selectable-text PDF on Node 24', async () => {
  const content = 'Synthetic candidate experience in firmware, software, and product delivery';
  const response = await request({
    method: 'POST', route: '/api/setup/import-cv',
    body: { name: 'compressed-cv.pdf', base64: compressedPdf(content).toString('base64') },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.match(response.json.text, /firmware, software, and product delivery/);
});

test('CV import extracts a representative DOCX file', async () => {
  const content = 'Synthetic DOCX candidate experience';
  const response = await request({
    method: 'POST', route: '/api/setup/import-cv',
    body: { name: 'cv.docx', base64: simpleDocx(content).toString('base64') },
  });
  assert.equal(response.status, 200);
  assert.match(response.json.text, /Synthetic DOCX candidate experience/);
});

test('CV import identifies image-only or text-empty PDFs as needing OCR', async () => {
  const response = await request({
    method: 'POST', route: '/api/setup/import-cv',
    body: { name: 'scanned.pdf', base64: blankPdf().toString('base64') },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.json, {
    error: 'This PDF contains little or no selectable text. Scanned PDFs need OCR before import.',
    reasonCode: 'pdf-needs-ocr',
  });
  assert.equal(fs.existsSync(path.join(workspace, 'imports', 'scanned.pdf')), false);
});

test('CV import reports an unreadable PDF clearly', async () => {
  const response = await request({
    method: 'POST', route: '/api/setup/import-cv',
    body: { name: 'malformed.pdf', base64: Buffer.from('%PDF-1.7\nnot a readable document').toString('base64') },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.json, {
    error: 'PDF could not be read. Export it again or choose another PDF.',
    reasonCode: 'pdf-unreadable',
  });
  assert.equal(fs.existsSync(path.join(workspace, 'imports', 'malformed.pdf')), false);
});

test('CV import request body has a bounded JSON allowance', async () => {
  const response = await request({ method: 'POST', route: '/api/setup/import-cv', rawBody: `{"padding":"${'a'.repeat(14 * 1024 * 1024)}"}` });
  assert.equal(response.status, 413);
  assert.deepEqual(response.json, { error: 'request body too large' });
});
