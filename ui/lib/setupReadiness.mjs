import fs from 'node:fs';
import path from 'node:path';

function meaningful(file, minimumBytes) {
  return fs.existsSync(file) && fs.statSync(file).size >= minimumBytes;
}

export function setupReadiness(root, config, providers, tracker) {
  const opportunities = Array.isArray(tracker?.opportunities) ? tracker.opportunities : [];
  const provider = config.ai?.provider;
  const providerReady = Boolean(provider && providers?.[provider]?.installed && providers?.[provider]?.authenticated);
  const preferencesReady = Boolean(
    config.profile?.displayName
    && config.search?.roleFamilies?.length
    && config.search?.locations?.length
    && Array.isArray(config.search?.exclusions)
    && Object.hasOwn(config.search || {}, 'salaryMinimum')
  );
  const evidenceReady = meaningful(path.join(root, 'profile', 'context.md'), 500)
    && meaningful(path.join(root, 'profile', 'calibration.md'), 100)
    && meaningful(path.join(root, 'cv', 'master-cv.md'), 500);
  const approvalMarker = path.join(root, '.scout', 'onboarding', 'activated.json');
  const approved = fs.existsSync(approvalMarker) || (opportunities.length > 0 && evidenceReady);
  const checks = { provider: providerReady, preferences: preferencesReady, evidence: evidenceReady, approved, tracker: Boolean(tracker) };
  return { checks, established: opportunities.length > 0 && evidenceReady, ready: Object.values(checks).every(Boolean) };
}
