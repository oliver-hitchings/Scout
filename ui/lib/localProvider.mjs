import { isSafeModelId } from './modelIdentifier.mjs';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const HEALTH_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['ready'], properties: { ready: { const: true } } });

function privateIPv4(parts) {
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function privateEndpointHost(hostname) {
  if (hostname === 'localhost') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return privateIPv4(hostname.split('.').map(Number));
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false;
  // URL canonicalises IPv6, including embedded dotted IPv4 and unusual IPv4
  // spellings, before classification. DNS names never stand in for private IPs.
  const halves = hostname.slice(1, -1).split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map((word) => parseInt(word, 16));
  if (words.length !== 8) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return privateIPv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  }
  return words[0] === 0xfd7a && words[1] === 0x115c && words[2] === 0xa1e0;
}

function contains(parent, file) {
  const relative = path.relative(parent, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function localKeySelection(config, root) {
  const workspace = path.resolve(root || process.cwd());
  const file = path.resolve(workspace, config.apiKeyFile);
  let boundary;
  if (contains(path.join(workspace, '.scout'), file)) boundary = workspace;
  else if (process.platform !== 'win32' && contains('/etc/scout/secrets', file)) boundary = '/etc';
  else throw new Error('local provider API-key file must be inside workspace .scout or /etc/scout/secrets');
  validatePhysicalWorkspacePath(boundary, file, 'local provider API-key file');
  const parents = [];
  let current = path.dirname(file);
  while (true) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('authentication-required');
      parents.push(`${stat.dev}:${stat.ino}`);
    }
    if (path.relative(boundary, current) === '') break;
    const parent = path.dirname(current);
    if (parent === current) throw failure('authentication-required');
    current = parent;
  }
  return { file, parentIdentity: parents.join('|') };
}

function failure(reasonCode = 'provider-error') {
  const error = new Error(`Local provider request failed (${reasonCode}). Check the local model server and settings.`);
  error.reasonCode = reasonCode;
  return error;
}

// Configuration contains only an explicit endpoint, a model identifier and an
// optional credential FILE selector. Inline credentials are never supported.
export function validateLocalProviderConfig(value = {}, { requireConfigured = false, root, allowLegacyTransport = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('local provider settings must be an object');
  const allowed = new Set(['baseUrl', 'apiKeyFile', 'model', 'timeoutMs', 'retries']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('local provider settings contain unsupported fields; use an API-key file');
  const baseUrl = value.baseUrl || '';
  const model = value.model || '';
  if (baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || /[\x00-\x20\x7f]/.test(baseUrl)) throw new Error('local provider base URL is invalid');
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error('local provider base URL is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('local provider base URL must use HTTP(S) without credentials, query or fragment');
    }
    if (!allowLegacyTransport && parsed.protocol !== 'https:' && !privateEndpointHost(parsed.hostname)) {
      throw new Error('local provider base URL requires HTTPS, loopback, or a private numeric network address');
    }
  }
  if (model && !isSafeModelId(model)) throw new Error('local provider model is invalid');
  if (value.apiKeyFile != null && (typeof value.apiKeyFile !== 'string' || value.apiKeyFile.length > 4096 || /[\x00-\x1f]/.test(value.apiKeyFile))) {
    throw new Error('local provider API-key file path is invalid');
  }
  if (value.apiKeyFile && root !== undefined) localKeySelection(value, root);
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error('local provider timeout must be between 1 ms and 30 minutes');
  }
  if (value.retries !== undefined && (!Number.isSafeInteger(value.retries) || value.retries < 0 || value.retries > 2)) {
    throw new Error('local provider retries must be between zero and two');
  }
  if (requireConfigured && (!baseUrl || !model)) throw new Error('local provider base URL and model are required');
  return value;
}

function readKey(config, root) {
  if (!config.apiKeyFile) return null;
  // Read by descriptor, enforce the bound before allocation, and never place
  // the key or a filesystem error in a thrown/public result.
  let descriptor;
  try {
    const { file, parentIdentity } = localKeySelection(config, root);
    const selected = fs.lstatSync(file, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink() || selected.size < 1n || selected.size > 8192n) throw failure('authentication-required');
    // O_NONBLOCK prevents a regular-file -> FIFO replacement from blocking
    // open before the descriptor can be checked. O_NOFOLLOW rejects a final
    // symlink replacement on platforms that expose that flag. The descriptor
    // must still match the regular file selected by lstat on every platform.
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.dev !== selected.dev || stat.ino !== selected.ino
      || stat.size < 1n || stat.size > 8192n) throw failure('authentication-required');
    const bytes = Buffer.alloc(8193);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 8192) throw failure('authentication-required');
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(file, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino
      || afterRead.size !== stat.size || afterRead.mtimeNs !== stat.mtimeNs || afterRead.ctimeNs !== stat.ctimeNs
      || after.size !== afterRead.size || after.mtimeNs !== afterRead.mtimeNs || after.ctimeNs !== afterRead.ctimeNs
      || localKeySelection(config, root).parentIdentity !== parentIdentity) throw failure('authentication-required');
    const key = bytes.subarray(0, count).toString('utf8').trim();
    if (!key || /[\x00-\x20\x7f]/.test(key)) throw failure('authentication-required');
    return key;
  } catch { throw failure('authentication-required'); }
  finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* never expose a raw file error */ } } }
}

export function localProviderStatus({ local = {}, root } = {}) {
  const result = { provider: 'local', installed: false, authenticated: false, capabilities: { structuredOutput: true }, source: 'local-http' };
  try {
    validateLocalProviderConfig(local, { requireConfigured: true });
    result.installed = true;
    readKey(local, root);
    // This means configuration/key presence only. Only a validated completion
    // can establish a remote-success health signal.
    result.authenticated = true;
  } catch (error) {
    result.reasonCode = error.reasonCode || 'provider-error';
  }
  Object.defineProperty(result, 'local', { value: { ...local }, enumerable: false });
  Object.defineProperty(result, 'root', { value: root, enumerable: false });
  return result;
}

async function readResponse(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw failure();
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { if (!response.ok) return {}; throw failure(); }
}

function responseReason(status) {
  if ([401, 403].includes(status)) return 'authentication-required';
  if (status === 429) return 'rate-limited';
  return 'provider-error';
}

export function runLocalTurn({ status, prompt, messages, model, schema, timeoutMs, maxOutputBytes = MAX_RESPONSE_BYTES, onEvent = () => {} } = {}) {
  const controller = new AbortController();
  let stopped = false;
  let authoritativeFailure = null;
  const stop = () => { stopped = true; controller.abort(); };
  const finished = (async () => {
    const config = status?.local;
    try { validateLocalProviderConfig(config, { requireConfigured: true }); } catch { return { ok: false, reasonCode: 'provider-error' }; }
    const budget = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_TIMEOUT_MS) return { ok: false, reasonCode: 'provider-error' };
    const timer = setTimeout(() => controller.abort(), budget);
    const maxBytes = Math.min(MAX_RESPONSE_BYTES, maxOutputBytes);
    try {
      const key = readKey(config, status.root);
      const selectedModel = model || config.model;
      if (!isSafeModelId(selectedModel)) throw failure();
      const validate = schema ? ajv.compile(schema) : null;
      const conversation = messages || [{ role: 'user', content: String(prompt || '') }];
      let structured = Boolean(schema);
      let attempt = 0;
      let schemaFallback = false;
      while (true) {
        if (controller.signal.aborted) throw failure('network-unavailable');
        const body = {
          model: selectedModel,
          stream: false,
          messages: [
            { role: 'system', content: schema
              ? `Return only a JSON object matching this JSON schema. No Markdown or extra text.\n${JSON.stringify(schema)}`
              : 'You are Scout, a helpful career assistant. Use only the supplied facts. Applications and outreach are drafts for human review. You cannot read or edit files or run tools.' },
            ...conversation,
          ],
          ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'scout_response', strict: true, schema } } } : {}),
        };
        const requestBody = JSON.stringify(body);
        if (Buffer.byteLength(requestBody) > 1024 * 1024) throw failure();
        let response;
        try {
          response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: requestBody,
          });
        } catch (error) {
          if (!controller.signal.aborted && attempt < (config.retries ?? 1) && error?.cause?.code !== 'ERR_INVALID_URL' && !/redirect/i.test(String(error?.cause?.message || ''))) {
            attempt += 1;
            continue;
          }
          throw failure(controller.signal.aborted || error?.cause?.code !== undefined ? 'network-unavailable' : 'provider-error');
        }
        if ([401, 403, 429].includes(response.status)) {
          // These headers are conclusive. Their untrusted body cannot change
          // authentication/rate-limit truth or hold a request open until timeout.
          authoritativeFailure = responseReason(response.status);
          try { await response.body?.cancel(); } catch { /* preserve known status */ }
          throw failure(authoritativeFailure);
        }
        const payload = await readResponse(response, maxBytes);
        // Capability fallback requires a bounded explicit schema rejection.
        // Other 400s must retain their actual failure, never silently retry.
        const capabilityMessage = String(payload?.error?.message || '').slice(0, 1024);
        if (structured && !schemaFallback && [400, 422].includes(response.status)
          && (payload?.error?.param === 'response_format' || /(?:json_schema|response_format).*(?:unsupported|not supported|unknown)|(?:unsupported|not supported|unknown).*(?:json_schema|response_format)/i.test(capabilityMessage))) {
          structured = false;
          schemaFallback = true;
          continue;
        }
        if (!response.ok) {
          if ([408, 502, 503, 504].includes(response.status) && attempt < (config.retries ?? 1)) { attempt += 1; continue; }
          throw failure(responseReason(response.status));
        }
        const choice = payload?.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text !== 'string' || !text.trim() || choice?.message?.refusal || !['stop', undefined, null].includes(choice?.finish_reason)) throw failure();
        let value;
        if (validate) {
          try { value = JSON.parse(text); } catch { throw failure(); }
          if (!value || typeof value !== 'object' || Array.isArray(value) || !validate(value)) throw failure();
        }
        const usage = {
          input_tokens: Number.isSafeInteger(payload.usage?.prompt_tokens) ? Math.max(0, payload.usage.prompt_tokens) : 0,
          output_tokens: Number.isSafeInteger(payload.usage?.completion_tokens) ? Math.max(0, payload.usage.completion_tokens) : 0,
        };
        if (!validate) onEvent({ kind: 'delta', text });
        return { ok: true, text, ...(validate ? { value } : {}), usage, filesTouched: [] };
      }
    } catch (error) {
      return { ok: false, reasonCode: stopped ? 'stopped' : authoritativeFailure || (controller.signal.aborted ? 'network-unavailable' : error.reasonCode || 'provider-error'), filesTouched: [] };
    } finally { clearTimeout(timer); }
  })();
  return { finished, stop };
}

export async function localProviderHealthSignal(status, { source = 'provider-operation' } = {}) {
  if (!status?.installed) return { kind: 'provider-failure', source, reasonCode: 'provider-error' };
  if (!status.authenticated) return { kind: 'remote-auth-failure', source, reasonCode: 'authentication-required' };
  const turn = runLocalTurn({ status, timeoutMs: 10_000, prompt: 'Respond only with {"ready":true}.', maxOutputBytes: 32 * 1024, schema: HEALTH_SCHEMA });
  const result = await turn.finished;
  const kind = result.ok ? 'remote-success' : { 'authentication-required': 'remote-auth-failure', 'network-unavailable': 'network-failure', 'rate-limited': 'rate-limit' }[result.reasonCode] || 'provider-failure';
  return { kind, source };
}
