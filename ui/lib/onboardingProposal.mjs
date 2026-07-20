import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { doctor } from './doctor.mjs';
import { loadWorkspaceConfig, validateWorkspaceConfig, workspacePaths } from './workspace.mjs';
import { providerStatus } from './providers.mjs';
import { runStructuredTurn } from './structuredTurn.mjs';

export const ONBOARDING_INPUT_LIMIT = 80_000;
export const ONBOARDING_FILES = Object.freeze([
  'workspace.json', 'profile/context.md', 'profile/calibration.md',
  'cv/master-cv.md', 'data/search-categories.json',
]);

const sourcedText = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' },
    evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
  }, required: ['text', 'evidenceIds'],
};

export const ONBOARDING_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    profile: {
      type: 'object', additionalProperties: false,
      properties: {
        headline: sourcedText,
        priorities: { type: 'array', items: sourcedText },
        evidence: { type: 'array', items: sourcedText },
        exclusions: { type: 'array', items: sourcedText },
        tone: sourcedText,
      }, required: ['headline', 'priorities', 'evidence', 'exclusions', 'tone'],
    },
    calibration: {
      type: 'object', additionalProperties: false,
      properties: {
        dimensions: {
          type: 'array', minItems: 1, items: {
            type: 'object', additionalProperties: false,
            properties: { name: { type: 'string' }, weight: { type: 'number' }, description: { type: 'string' } },
            required: ['name', 'weight', 'description'],
          },
        },
        gates: { type: 'array', items: { type: 'string' } },
        actionScore: { type: 'number' }, checkScore: { type: 'number' },
      }, required: ['dimensions', 'gates', 'actionScore', 'checkScore'],
    },
    searchCategories: {
      type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' },
          priority: { type: 'string', enum: ['primary', 'secondary'] },
          queries: { type: 'array', minItems: 1, items: { type: 'string' } }, keeperRule: { type: 'string' },
        }, required: ['id', 'label', 'description', 'priority', 'queries', 'keeperRule'],
      },
    },
    masterCv: {
      type: 'object', additionalProperties: false,
      properties: {
        title: sourcedText, profile: sourcedText,
        skills: { type: 'array', items: sourcedText },
        experience: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: { heading: sourcedText, bullets: { type: 'array', minItems: 1, items: sourcedText } },
            required: ['heading', 'bullets'],
          },
        },
        education: { type: 'array', items: sourcedText },
        otherEvidence: { type: 'array', items: sourcedText },
      }, required: ['title', 'profile', 'skills', 'experience', 'education', 'otherEvidence'],
    },
  },
  required: ['summary', 'unresolvedQuestions', 'profile', 'calibration', 'searchCategories', 'masterCv'],
});

function sha256(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function targetPath(root, relative) { return path.join(root, ...relative.split('/')); }
function stagePath(root, relative) { return path.join(root, '.scout', 'onboarding', ...relative.split('/')); }

function configEvidence(config) {
  const fields = [
    ['config-name', 'Preferred name', config.profile?.displayName],
    ['config-tone', 'Writing tone', config.profile?.tone],
    ['config-roles', 'Desired roles', (config.search?.roleFamilies || []).join(', ')],
    ['config-sectors', 'Desired sectors', (config.search?.sectors || []).join(', ')],
    ['config-locations', 'Locations', (config.search?.locations || []).join(', ')],
    ['config-exclusions', 'Hard exclusions', (config.search?.exclusions || []).join(', ')],
    ['config-salary', 'Minimum salary', config.search?.salaryMinimum == null ? 'unknown' : `${config.currency} ${config.search.salaryMinimum}`],
    ['config-commute', 'Commute preference', `${config.commute?.origin || 'unknown'}; ${config.commute?.mode || 'either'}; maximum ${config.commute?.maxMinutes ?? 180} minutes`],
    ['config-locale', 'Locale', config.locale],
  ];
  return fields.filter(([, , value]) => String(value || '').trim()).map(([id, label, text]) => ({ id, label, text: String(text) }));
}

export function buildOnboardingEvidence(root, config, limit = ONBOARDING_INPUT_LIMIT) {
  const evidence = configEvidence(config);
  let importedCharacters = 0;
  const seenImportLines = new Set();
  const imports = workspacePaths(root).imports;
  if (fs.existsSync(imports)) {
    const files = fs.readdirSync(imports).filter((name) => name.toLowerCase().endsWith('.txt')).sort();
    let lineNumber = 0;
    for (const name of files) {
      const lines = fs.readFileSync(path.join(imports, name), 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const text = line.trim();
        if (text && !seenImportLines.has(text)) {
          seenImportLines.add(text);
          importedCharacters += text.length;
          evidence.push({ id: `cv-${String(++lineNumber).padStart(4, '0')}`, label: name, text });
        }
      }
    }
  }
  if (importedCharacters > limit) throw new Error(`imported evidence is ${importedCharacters.toLocaleString()} characters; reduce it below ${limit.toLocaleString()} before AI generation`);
  return { evidence, importedCharacters, characters: evidence.reduce((sum, item) => sum + item.text.length, 0) };
}

function allSourcedText(proposal) {
  return [
    proposal.profile?.headline, ...(proposal.profile?.priorities || []), ...(proposal.profile?.evidence || []),
    ...(proposal.profile?.exclusions || []), proposal.profile?.tone,
    proposal.masterCv?.title, proposal.masterCv?.profile, ...(proposal.masterCv?.skills || []),
    ...(proposal.masterCv?.experience || []).flatMap((item) => [item.heading, ...(item.bullets || [])]),
    ...(proposal.masterCv?.education || []), ...(proposal.masterCv?.otherEvidence || []),
  ].filter(Boolean);
}

export function validateOnboardingProposal(proposal, evidence) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('onboarding proposal must be an object');
  const known = new Set(evidence.map((item) => item.id));
  for (const item of allSourcedText(proposal)) {
    if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('proposal contains empty factual text');
    if (!Array.isArray(item.evidenceIds) || !item.evidenceIds.length) throw new Error(`proposal item lacks evidence: ${item.text}`);
    const missing = item.evidenceIds.filter((id) => !known.has(id));
    if (missing.length) throw new Error(`proposal cites unknown evidence IDs: ${missing.join(', ')}`);
  }
  const dimensions = proposal.calibration?.dimensions || [];
  const total = dimensions.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  if (Math.abs(total - 100) > 0.001) throw new Error(`scoring dimensions must total 100, received ${total}`);
  const actionScore = Number(proposal.calibration?.actionScore);
  const checkScore = Number(proposal.calibration?.checkScore);
  if (!Number.isFinite(actionScore) || !Number.isFinite(checkScore) || checkScore < 0 || actionScore > 100 || checkScore >= actionScore) {
    throw new Error('proposal score bands must satisfy 0 <= checkScore < actionScore <= 100');
  }
  if (!Array.isArray(proposal.searchCategories) || !proposal.searchCategories.length) throw new Error('at least one search category is required');
  const ids = proposal.searchCategories.map((item) => item.id);
  if (ids.some((id) => !/^[a-z0-9-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('search category IDs must be unique lowercase slugs');
  if (proposal.searchCategories.some((item) => !String(item.label || '').trim() || !Array.isArray(item.queries) || !item.queries.some((query) => String(query).trim()))) {
    throw new Error('each search category needs a label and at least one query');
  }
  if (!proposal.masterCv?.title || !proposal.masterCv?.profile || (proposal.masterCv?.skills || []).length < 3
      || !(proposal.masterCv?.experience || []).length || proposal.masterCv.experience.some((item) => !(item.bullets || []).length)) {
    throw new Error('master CV requires a title, profile, at least three skills, and evidenced experience bullets');
  }
  const cvItems = allSourcedText({ masterCv: proposal.masterCv || {} });
  const wordCount = cvItems.reduce((sum, item) => sum + item.text.trim().split(/\s+/).length, 0);
  if (wordCount < 250 || wordCount > 1200) throw new Error(`master CV must contain 250-1200 words, received ${wordCount}`);
  if (/\b(?:TODO|TBC|TBD|FIXME|XX+)\b|<[^>\n]+>/i.test(cvItems.map((item) => item.text).join('\n'))) {
    throw new Error('master CV contains unresolved placeholders');
  }
  return proposal;
}

function evidenceNote(item) { return `<!-- evidence: ${item.evidenceIds.join(', ')} -->`; }
function bullets(items) { return items.map((item) => `- ${item.text}\n  ${evidenceNote(item)}`).join('\n'); }

export function renderOnboardingFiles(config, proposal, activatedAt = null) {
  const nextConfig = JSON.parse(JSON.stringify(config));
  nextConfig.triage = { ...nextConfig.triage, actionScore: proposal.calibration.actionScore, checkScore: proposal.calibration.checkScore };
  nextConfig.schedule = { jobs: [] };
  if (activatedAt) nextConfig.setup = { ...nextConfig.setup, completedAt: activatedAt };
  validateWorkspaceConfig(nextConfig);
  const context = [
    '# Scout profile', '', '## Headline', proposal.profile.headline.text, evidenceNote(proposal.profile.headline),
    '', '## Target opportunities', bullets(proposal.profile.priorities),
    '', '## Evidence and strengths', bullets(proposal.profile.evidence),
    '', '## Hard exclusions', bullets(proposal.profile.exclusions),
    '', '## Communication tone', proposal.profile.tone.text, evidenceNote(proposal.profile.tone), '',
  ].join('\n');
  const calibration = [
    '# Scoring calibration', '', '## Dimensions',
    ...proposal.calibration.dimensions.map((item) => `- **${item.name} (${item.weight})** — ${item.description}`),
    '', '## Mandatory gates', ...proposal.calibration.gates.map((gate) => `- ${gate}`),
    '', `## Bands\n\n- Action: ${proposal.calibration.actionScore}+\n- One check from unlocking: ${proposal.calibration.checkScore}-${proposal.calibration.actionScore - 1}`,
    '', 'Missing or unsupported mandatory requirements never qualify for Action.', '',
  ].join('\n');
  const cv = proposal.masterCv;
  const master = [
    `# ${cv.title.text}`, evidenceNote(cv.title), '', '## Profile', cv.profile.text, evidenceNote(cv.profile),
    '', '## Skills', bullets(cv.skills), '', '## Experience',
    ...cv.experience.flatMap((entry) => [`### ${entry.heading.text}`, evidenceNote(entry.heading), bullets(entry.bullets), '']),
    '## Education and qualifications', bullets(cv.education), '', '## Other evidence', bullets(cv.otherEvidence), '',
  ].join('\n');
  const categories = { _note: 'User-reviewed search lanes generated during Scout onboarding.', categories: proposal.searchCategories };
  return {
    'workspace.json': `${JSON.stringify(nextConfig, null, 2)}\n`,
    'profile/context.md': context,
    'profile/calibration.md': calibration,
    'cv/master-cv.md': master,
    'data/search-categories.json': `${JSON.stringify(categories, null, 2)}\n`,
  };
}

function writeStaged(root, files) {
  const staging = path.join(root, '.scout', 'onboarding');
  const markerFile = path.join(staging, 'activated.json');
  const marker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile) : null;
  fs.rmSync(staging, { recursive: true, force: true });
  if (marker) {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(markerFile, marker);
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = stagePath(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

export async function createOnboardingProposal(root, provider, {
  providerStatusFn = providerStatus, runStructuredTurnFn = runStructuredTurn, now = () => new Date().toISOString(),
} = {}) {
  const config = loadWorkspaceConfig(root);
  const status = providerStatusFn(provider);
  const input = buildOnboardingEvidence(root, config);
  const prompt = [
    'Create one evidence-only Scout onboarding proposal from the JSON input below.',
    'Never invent or infer a fact. Every factual output item must cite one or more supplied evidence IDs.',
    'Create concise UK-English profile and CV content, a 100-point rubric, mandatory gates, and distinct search lanes.',
    'Return only the required schema. Do not access files, run commands, browse, activate changes, apply for jobs, or send outreach.',
    JSON.stringify({ config, evidence: input.evidence }),
  ].join('\n\n');
  const turn = await runStructuredTurnFn({
    provider, status, schema: ONBOARDING_SCHEMA, prompt,
    model: config.ai?.provider === provider ? config.ai?.model : null,
    validate: (value) => validateOnboardingProposal(value, input.evidence), maxInputTokens: 60_000,
  });
  const proposalId = crypto.randomUUID();
  const files = renderOnboardingFiles(config, turn.value);
  writeStaged(root, files);
  const manifest = {
    schemaVersion: 1, proposalId, createdAt: now(), provider, summary: turn.value.summary, valid: true,
    unresolvedQuestions: turn.value.unresolvedQuestions, usage: turn.usage,
    targetHashes: Object.fromEntries(ONBOARDING_FILES.map((relative) => [relative, sha256(targetPath(root, relative))])),
    stagedHashes: Object.fromEntries(ONBOARDING_FILES.map((relative) => [relative, sha256(stagePath(root, relative))])),
  };
  fs.writeFileSync(path.join(root, '.scout', 'onboarding', 'proposal.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { ...manifest, files: ONBOARDING_FILES, valid: true };
}

export function readOnboardingProposal(root) {
  const file = path.join(root, '.scout', 'onboarding', 'proposal.json');
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...manifest,
    files: ONBOARDING_FILES.map((relative) => ({
      path: relative, staged: fs.readFileSync(stagePath(root, relative), 'utf8'),
      active: fs.existsSync(targetPath(root, relative)) ? fs.readFileSync(targetPath(root, relative), 'utf8') : null,
    })),
  };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.scout-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

export function activateOnboardingProposal(root, proposalId, confirmed, {
  doctorFn = doctor, now = () => new Date().toISOString(),
} = {}) {
  if (confirmed !== true) throw new Error('explicit proposal confirmation is required');
  const proposal = readOnboardingProposal(root);
  if (!proposal || proposal.proposalId !== proposalId) throw new Error('onboarding proposal is missing or no longer current');
  if ((proposal.unresolvedQuestions || []).length) throw new Error('resolve the proposal questions before activation');
  for (const relative of ONBOARDING_FILES) {
    if (sha256(targetPath(root, relative)) !== proposal.targetHashes[relative]) throw new Error(`active ${relative} changed after proposal generation; regenerate before activation`);
    if (sha256(stagePath(root, relative)) !== proposal.stagedHashes?.[relative]) throw new Error(`staged ${relative} changed after proposal generation; regenerate before activation`);
  }
  const activatedAt = now();
  const stagedConfig = JSON.parse(fs.readFileSync(stagePath(root, 'workspace.json'), 'utf8'));
  const stagedFiles = Object.fromEntries(ONBOARDING_FILES.map((relative) => [relative, fs.readFileSync(stagePath(root, relative), 'utf8')]));
  stagedConfig.setup = { ...stagedConfig.setup, completedAt: activatedAt };
  validateWorkspaceConfig(stagedConfig);
  stagedFiles['workspace.json'] = `${JSON.stringify(stagedConfig, null, 2)}\n`;
  const previous = Object.fromEntries(ONBOARDING_FILES.map((relative) => {
    const file = targetPath(root, relative);
    return [relative, fs.existsSync(file) ? fs.readFileSync(file) : null];
  }));
  const backupDir = path.join(root, '.scout', 'backups', activatedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  for (const [relative, content] of Object.entries(previous)) {
    if (content != null) {
      const backup = path.join(backupDir, ...relative.split('/'));
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, content);
    }
  }
  try {
    for (const relative of ONBOARDING_FILES) atomicWrite(targetPath(root, relative), stagedFiles[relative]);
    const result = doctorFn(root);
    const activationProvider = result?.checks?.providers?.[proposal.provider];
    const requiredOk = result?.checks?.config?.ok && result?.checks?.tracker?.ok
      && activationProvider?.installed && activationProvider?.authenticated
      && activationProvider?.capabilities?.structuredOutput !== false;
    if (!requiredOk) throw new Error('Scout doctor rejected the activated workspace');
    const marker = { activatedAt, provider: proposal.provider, proposalId };
    fs.writeFileSync(path.join(root, '.scout', 'onboarding', 'activated.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    fs.rmSync(path.join(root, '.scout', 'onboarding', 'proposal.json'), { force: true });
    return { ok: true, activatedAt, backupDir, files: ONBOARDING_FILES };
  } catch (error) {
    for (const [relative, content] of Object.entries(previous)) {
      const target = targetPath(root, relative);
      if (content == null) fs.rmSync(target, { force: true });
      else atomicWrite(target, content);
    }
    throw error;
  }
}

export function discardOnboardingProposal(root) {
  const staging = path.join(root, '.scout', 'onboarding');
  const markerFile = path.join(staging, 'activated.json');
  const marker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile) : null;
  fs.rmSync(staging, { recursive: true, force: true });
  if (marker) {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(markerFile, marker);
  }
  return { ok: true };
}
