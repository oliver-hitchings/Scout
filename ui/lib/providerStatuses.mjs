import { readProviderHealth } from './providerHealth.mjs';
import { publicProviderStatus } from './providerPresentation.mjs';

export function publicProviderStatuses(values, root) {
  return Object.fromEntries(['codex', 'claude', 'local'].filter((provider) => values?.[provider]).map((provider) => {
    let health;
    try { health = readProviderHealth(root, provider); }
    catch { health = { state: 'provider-error', remoteAuthBarrier: true }; }
    return [provider, publicProviderStatus(values[provider], health)];
  }));
}
