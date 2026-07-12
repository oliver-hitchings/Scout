// The desktop host gives Node a per-startup bearer token through its process
// environment. This module deliberately never serialises that token into an
// API response or browser-visible configuration.
export function hostControlConfig(env = process.env) {
  const url = String(env.SCOUT_HOST_CONTROL_URL || '').replace(/\/$/, '');
  const token = String(env.SCOUT_HOST_CONTROL_TOKEN || '');
  return url && token ? { url, token } : null;
}

export async function hostUpdate(path, body = {}, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const config = hostControlConfig(env);
  if (!config) throw new Error('Desktop update host is unavailable');
  if (!/^\/(?:check|install)$/.test(path)) throw new Error('invalid host update route');
  const response = await fetchFn(`${config.url}/v1/updates${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-scout-host-token': config.token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Desktop update host returned ${response.status}`);
  return response.json();
}

export async function hostWindowCommand(path, body = {}, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const config = hostControlConfig(env);
  if (!config) throw new Error('Desktop host is unavailable');
  if (path !== '/quit') throw new Error('invalid host window route');
  const response = await fetchFn(`${config.url}/v1/window${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-scout-host-token': config.token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Desktop host returned ${response.status}`);
  return response.json();
}
