import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { providerStatus, providerLocalHealthSignal } from './providers.mjs';
import { runStructuredTurn } from './structuredTurn.mjs';
import { mergeWorkspaceDefaults, validateWorkspaceConfig, modelForProvider } from './workspace.mjs';
import { localProviderHealthSignal, runLocalTurn } from './localProvider.mjs';
import { readProviderHealth, recordProviderHealth } from './providerHealth.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['ready'], properties: { ready: { const: true } } };
const completion = (content = '{"ready":true}') => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });

async function fixture(t, handle) {
  const requests = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-local-http-'));
  const key = randomBytes(24).toString('hex');
  const apiKeyFile = path.join(root, 'credential');
  fs.writeFileSync(apiKeyFile, `${key}\n`, { mode: 0o600 });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    requests.push(request);
    await handle(req, res, request, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const local = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyFile, model: 'synthetic/model-27b', timeoutMs: 2000, retries: 0 };
  return { local, key, requests, root };
}
function respond(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function run(local, options = {}) {
  return runStructuredTurn({ provider: 'local', status: providerStatus('local', { local }), schema, prompt: 'Synthetic readiness check.', ...options });
}

test('local provider executes validated structured HTTP without any CLI and keeps key/path private', async (t) => {
  const f = await fixture(t, (_req, res) => respond(res, 200, completion()));
  const status = providerStatus('local', { local: f.local, spawn: () => assert.fail('local provider must not spawn') });
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(providerLocalHealthSignal(status).kind, 'local-credentials-present');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${f.key}|${f.root}`));
  const result = await run(f.local);
  assert.deepEqual(result.value, { ready: true });
  assert.equal(f.requests[0].url, '/v1/chat/completions');
  assert.equal(f.requests[0].headers.authorization, `Bearer ${f.key}`);
  assert.equal(f.requests[0].body.model, f.local.model);
  assert.equal(f.requests[0].body.response_format.type, 'json_schema');
  assert.equal(f.requests[0].body.response_format.json_schema.strict, true);
});

test('schema capability rejection falls back once to strict JSON with local schema validation', async (t) => {
  const f = await fixture(t, (_req, res, _request, count) => respond(res, count === 1 ? 400 : 200,
    count === 1 ? { error: { param: 'response_format', message: 'json_schema unsupported' } } : completion()));
  assert.deepEqual((await run(f.local)).value, { ready: true });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body.response_format, undefined);
  assert.match(f.requests[1].body.messages[0].content, /JSON/);
});

for (const [name, output] of [['schema-invalid', '{"ready":false}'], ['extra-property', '{"ready":true,"other":1}'], ['markdown', '```json\n{"ready":true}\n```']]) {
  test(`local ${name} response fails after HTTP success without exposing content`, async (t) => {
    const f = await fixture(t, (_req, res, _request, count) => respond(res, count === 1 ? 400 : 200,
      count === 1 ? { error: { param: 'response_format', message: 'json_schema unsupported' } } : completion(output)));
    await assert.rejects(run(f.local), (error) => error.reasonCode === 'provider-error' && !error.message.includes(output));
    assert.equal(f.requests.length, 2);
  });
}

for (const [status, reason] of [[401, 'authentication-required'], [429, 'rate-limited'], [503, 'provider-error']]) {
  test(`local HTTP ${status} has an honest bounded failure state`, async (t) => {
    const f = await fixture(t, (_req, res) => respond(res, status, { error: 'synthetic private response' }));
    await assert.rejects(run(f.local), (error) => error.reasonCode === reason && !error.message.includes('private response'));
    assert.equal(f.requests.length, 1);
  });
}

for (const [status, reason] of [[401, 'authentication-required'], [403, 'authentication-required'], [429, 'rate-limited']]) {
  for (const body of ['oversized', 'stalled']) {
    test(`local HTTP ${status} stays authoritative with ${body} error content`, async (t) => {
      let responseClosed;
      const closed = new Promise((resolve) => { responseClosed = resolve; });
      const f = await fixture(t, (_req, res) => {
        res.once('close', responseClosed);
        res.writeHead(status, { 'content-type': 'text/plain' });
        if (body === 'oversized') res.end('synthetic private error '.repeat(100_000));
        else { res.flushHeaders(); res.write('synthetic private error'); }
      });
      const selected = providerStatus('local', { local: { ...f.local, retries: 2, timeoutMs: 300 } });
      const result = await runLocalTurn({ status: selected, prompt: 'Synthetic request.' }).finished;
      assert.equal(result.reasonCode, reason, 'known HTTP status must survive the unneeded error-body boundary');
      assert.equal(f.requests.length, 1, 'authentication and rate limits must never retry');
      assert.doesNotMatch(JSON.stringify(result), /synthetic private error/);
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('response body was not cancelled')), 1500);
        })]);
      } finally { clearTimeout(timer); }
    });
  }
}

test('an oversized local authentication response establishes a durable barrier until real success', async (t) => {
  let healthy = false;
  const f = await fixture(t, (_req, res) => {
    if (healthy) respond(res, 200, completion());
    else { res.writeHead(401); res.end('synthetic private error '.repeat(100_000)); }
  });
  const status = providerStatus('local', { local: f.local });
  const failed = await localProviderHealthSignal(status, { source: 'manual-preflight' });
  const blocked = recordProviderHealth(f.root, 'local', failed, { purpose: 'manual-run' });
  assert.equal(blocked.state, 'sign-in-required');
  assert.equal(blocked.remoteAuthBarrier, true);
  const localOnly = recordProviderHealth(f.root, 'local', { kind: 'local-credentials-present', source: 'startup' }, { purpose: 'startup' });
  assert.equal(localOnly.remoteAuthBarrier, true);
  assert.equal(localOnly.state, 'sign-in-required');
  assert.doesNotMatch(JSON.stringify(readProviderHealth(f.root, 'local')), /synthetic private error/);
  healthy = true;
  const recovered = recordProviderHealth(f.root, 'local', await localProviderHealthSignal(status, { source: 'manual-preflight' }), { purpose: 'manual-run' });
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.remoteAuthBarrier, false);
});

test('local retries only bounded transient HTTP errors and never auth failures', async (t) => {
  const f = await fixture(t, (_req, res, _request, count) => respond(res, count < 3 ? 503 : 200, completion()));
  assert.deepEqual((await run({ ...f.local, retries: 2 })).value, { ready: true });
  assert.equal(f.requests.length, 3);
});

test('local deadline aborts a hung HTTP request and closes before returning', async (t) => {
  const f = await fixture(t, () => {});
  const began = Date.now();
  await assert.rejects(run({ ...f.local, timeoutMs: 100, retries: 0 }), (error) => error.reasonCode === 'network-unavailable');
  assert.ok(Date.now() - began < 1500);
});

test('local refuses credential forwarding through redirects', async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { location: '/redirected' }); res.end(); });
  await assert.rejects(run(f.local), (error) => error.reasonCode === 'provider-error');
  assert.equal(f.requests.length, 1);
});

test('missing local API-key files fail as authentication-required before any HTTP request', async (t) => {
  const f = await fixture(t, (_req, res) => respond(res, 200, completion()));
  fs.unlinkSync(f.local.apiKeyFile);
  const status = providerStatus('local', { local: f.local });
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  await assert.rejects(run(f.local), (error) => error.reasonCode === 'authentication-required');
  assert.equal(f.requests.length, 0);
});

test('local response envelopes are byte-bounded before JSON parsing', async (t) => {
  const f = await fixture(t, (_req, res) => respond(res, 200, completion('x'.repeat(8192))));
  await assert.rejects(run(f.local, { maxOutputBytes: 128 }), (error) => error.reasonCode === 'provider-error');
  assert.equal(f.requests.length, 1);
});

for (const substitution of [false, true]) {
  test(`local API-key ${substitution ? 'FIFO substitution' : 'FIFO'} cannot block provider detection`, { skip: process.platform === 'win32' }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-local-key-file-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const keyFile = path.join(root, 'key-file');
    if (substitution) fs.writeFileSync(keyFile, randomBytes(24).toString('hex'));
    else assert.equal(spawnSync('mkfifo', [keyFile]).status, 0);
    // This runs in its own bounded process: the pre-fix blocking open must
    // never hang the suite, nor consume a live provider or real credential.
    const script = `
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { providerStatus } from ${JSON.stringify(new URL('./providers.mjs', import.meta.url).href)};
      const file = ${JSON.stringify(keyFile)};
      if (${substitution}) {
        const original = fs.openSync;
        fs.openSync = (value, ...args) => {
          if (value === file) {
            fs.unlinkSync(file);
            if (spawnSync('mkfifo', [file]).status !== 0) process.exit(3);
          }
          return original(value, ...args);
        };
      }
      const status = providerStatus('local', { local: { baseUrl: 'http://localhost:8000/v1', model: 'synthetic-model', apiKeyFile: file } });
      process.stdout.write(JSON.stringify({ authenticated: status.authenticated, reasonCode: status.reasonCode }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
    assert.equal(child.status, 0, `provider detection must settle; child error: ${child.error?.code || 'none'}`);
    assert.deepEqual(JSON.parse(child.stdout), { authenticated: false, reasonCode: 'authentication-required' });
    assert.doesNotMatch(child.stdout + child.stderr, new RegExp(root));
  });
}

test('local API-key selectors reject final symlinks without reading their target', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t, (_req, res) => respond(res, 200, completion()));
  const link = path.join(f.root, 'key-link');
  fs.symlinkSync(f.local.apiKeyFile, link);
  const status = providerStatus('local', { local: { ...f.local, apiKeyFile: link } });
  assert.equal(status.authenticated, false);
  assert.equal(status.reasonCode, 'authentication-required');
  assert.equal(f.requests.length, 0);
});

test('local workspace configuration and schedules accept exact local model names', () => {
  const config = mergeWorkspaceDefaults({ ai: { provider: 'local', local: { baseUrl: 'http://localhost:8000/v1', model: 'synthetic/model-27b' } }, schedule: { jobs: [{ id: 'local-primary', provider: 'local', mode: 'primary', enabled: true, time: '07:30' }] } });
  assert.equal(validateWorkspaceConfig(config), config);
  assert.equal(modelForProvider(config, 'local'), 'synthetic/model-27b');
});

test('local settings reject inline keys, URL credentials, and unbounded transport limits', () => {
  for (const local of [
    { baseUrl: 'http://user:password@localhost:8000/v1', model: 'm' },
    { baseUrl: 'http://localhost:8000/v1?token=private', model: 'm' },
    { baseUrl: 'http://localhost:8000/v1', model: 'm', apiKey: 'inline' },
    { baseUrl: 'http://localhost:8000/v1', model: 'm', retries: 100 },
    { baseUrl: 'http://localhost:8000/v1', model: 'm', timeoutMs: 0 },
  ]) {
    assert.throws(() => validateWorkspaceConfig(mergeWorkspaceDefaults({ ai: { local } })), /local/i);
  }
});
