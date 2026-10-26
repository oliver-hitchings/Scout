// Both modes use the existing deterministic rank and assessment gates.
export function workspaceModePolicy(config = {}) {
  const mode = config.mode ?? 'background';
  if (!['background', 'active'].includes(mode)) throw new TypeError('workspace mode must be background or active');
  const actionScore = Number(config.triage?.actionScore ?? 70);
  const checkScore = Number(config.triage?.checkScore ?? 55);
  return {
    mode,
    triage: {
      ...config.triage,
      actionScore: mode === 'background' ? Math.max(95, actionScore) : actionScore,
      checkScore: mode === 'background' ? Math.max(85, checkScore) : checkScore,
    },
    resultCap: mode === 'background' ? 6 : 60,
    digestHours: mode === 'active' ? 24 : 0,
  };
}
