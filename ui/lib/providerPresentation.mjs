const PUBLIC_PROVIDER_HEALTH_STATES = new Set([
  'checking', 'ready', 'credentials-present-unverified', 'sign-in-required',
  'login-in-progress', 'network-unavailable', 'rate-limited', 'cli-update-required',
  'provider-error',
]);

export function publicProviderStatus(value, health = null) {
  const healthStateIsValid = health === null || PUBLIC_PROVIDER_HEALTH_STATES.has(health?.state);
  const healthState = health === null ? null
    : healthStateIsValid ? health.state : 'provider-error';
  const authenticationBlocked = !healthStateIsValid
    || (healthState !== null && !['ready', 'credentials-present-unverified'].includes(healthState))
    || health?.remoteAuthBarrier === true
    || healthState === 'sign-in-required';
  return {
    installed: value?.installed === true,
    authenticated: value?.authenticated === true && !authenticationBlocked,
    capabilities: {
      structuredOutput: value?.capabilities?.structuredOutput === true,
    },
    ...(healthState === null ? {} : { healthState }),
  };
}
export function providerCardPresentation(provider = {}) {
  if (provider.installed !== true) {
    return {
      available: false,
      label: 'Not installed',
      help: 'Install this provider CLI from its official guide, then refresh provider status.',
    };
  }
  const blocked = {
    checking: {
      label: 'Installed; checking provider status',
      help: 'Wait for the bounded provider check to finish, then refresh if needed.',
    },
    'sign-in-required': {
      label: 'Installed; sign-in required',
      help: 'Sign in with Scout or use the manual provider command, then refresh.',
    },
    'login-in-progress': {
      label: 'Installed; sign-in in progress',
      help: 'Wait for the current sign-in flow to finish before selecting this provider.',
    },
    'network-unavailable': {
      label: 'Installed; network unavailable',
      help: 'Restore provider network access, then refresh. Scout will not replay blocked work automatically.',
    },
    'rate-limited': {
      label: 'Installed; provider rate limited',
      help: 'Wait for the provider rate limit to clear, then retry explicitly.',
    },
    'cli-update-required': {
      label: 'Installed; CLI update required',
      help: 'Update this CLI from its official installation guide, then refresh.',
    },
    'provider-error': {
      label: 'Installed; provider error',
      help: 'Resolve the provider error and refresh status before selecting it.',
    },
  };
  if (Object.hasOwn(blocked, provider.healthState)) {
    return { available: false, ...blocked[provider.healthState] };
  }
  if (!['ready', 'credentials-present-unverified'].includes(provider.healthState)) {
    return {
      available: false,
      label: 'Installed; provider status unavailable',
      help: 'Refresh provider status. Scout will keep this provider disabled until its state is known.',
    };
  }
  if (provider.authenticated !== true) return { available: false, ...blocked['sign-in-required'] };
  if (provider.capabilities?.structuredOutput === false) {
    return { available: false, ...blocked['cli-update-required'] };
  }
  return {
    available: true,
    label: provider.healthState === 'credentials-present-unverified'
      ? 'Installed; sign-in found but not yet verified'
      : 'Installed, signed in and compatible',
    help: '',
  };
}
