import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACTIVATED_FILES = [
  'workspace.json', 'profile/context.md', 'profile/calibration.md',
  'cv/master-cv.md', 'data/search-categories.json',
];

function meaningful(file, minimumBytes) {
  return fs.existsSync(file) && fs.statSync(file).size >= minimumBytes;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Approval binds reviewed evidence and preferences, while these named fields
// record separate operational choices. Every other field, including unknown
// future fields, remains bound. This does not authorize changing an AI model,
// endpoint, search rule, calibration or personal evidence.
export function onboardingApprovalConfigDigest(config) {
  const reviewed = structuredClone(config);
  delete reviewed.mode;
  delete reviewed.schedule;
  delete reviewed._scoutMutation;
  if (reviewed.searchProfile && typeof reviewed.searchProfile === 'object') delete reviewed.searchProfile.publishedId;
  if (reviewed.setup && typeof reviewed.setup === 'object') {
    for (const key of ['completedAt', 'completedSections', 'deferredSections']) delete reviewed.setup[key];
  }
  return crypto.createHash('sha256').update(canonicalJson(reviewed)).digest('hex');
}

function configRemainsApproved(root, marker, currentBytes, expected) {
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const current = JSON.parse(currentBytes.toString('utf8'));
  if (Object.hasOwn(marker, 'configApproval')) {
    const binding = marker.configApproval;
    return binding && Object.keys(binding).sort().join(',') === 'digest,schemaVersion'
      && binding.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(binding.digest || '')
      && onboardingApprovalConfigDigest(current) === binding.digest;
  }
  if (digest(currentBytes) === expected) return true;
  // Older markers can use only their original, hash-verified staged bytes as
  // the approval baseline. Never derive trusted approval from current config.
  const staged = path.join(root, '.scout', 'onboarding', 'workspace.json');
  const stagedHash = marker.stagedHashes?.['workspace.json'];
  if (!/^[a-f0-9]{64}$/.test(stagedHash || '') || !fs.lstatSync(staged).isFile()) return false;
  const stagedBytes = fs.readFileSync(staged);
  return digest(stagedBytes) === stagedHash
    && onboardingApprovalConfigDigest(JSON.parse(stagedBytes.toString('utf8'))) === onboardingApprovalConfigDigest(current);
}

function activatedApproval(root) {
  const file = path.join(root, '.scout', 'onboarding', 'activated.json');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  try {
    return ACTIVATED_FILES.every((relative) => {
      const target = path.join(root, ...relative.split('/'));
      const expected = marker?.activatedHashes?.[relative];
      return typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected)
        && fs.existsSync(target)
        && fs.lstatSync(target).isFile()
        && (relative === 'workspace.json'
          ? configRemainsApproved(root, marker, fs.readFileSync(target), expected)
          : crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === expected);
    });
  } catch {
    return false;
  }
}

export function setupReadiness(root, config, providers, tracker) {
  const opportunities = Array.isArray(tracker?.opportunities) ? tracker.opportunities : [];
  const provider = config.ai?.provider;
  const providerReady = Boolean(provider && providers?.[provider]?.installed && providers?.[provider]?.authenticated
    && providers?.[provider]?.capabilities?.structuredOutput !== false);
  const preferencesReady = Boolean(
    config.profile?.displayName
    && config.search?.roleFamilies?.length
    && config.search?.locations?.length
    && Array.isArray(config.search?.exclusions)
    && Object.hasOwn(config.search || {}, 'salaryMinimum')
  );
  const evidenceReady = meaningful(path.join(root, 'profile', 'context.md'), 150)
    && meaningful(path.join(root, 'profile', 'calibration.md'), 100)
    && meaningful(path.join(root, 'cv', 'master-cv.md'), 500);
  const approved = activatedApproval(root) || (opportunities.length > 0 && evidenceReady);
  const checks = { provider: providerReady, preferences: preferencesReady, evidence: evidenceReady, approved, tracker: Boolean(tracker) };
  return { checks, established: opportunities.length > 0 && evidenceReady, ready: Object.values(checks).every(Boolean) };
}
