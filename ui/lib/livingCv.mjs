import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { readHousehold } from './household.mjs';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_VERSIONS = 256;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const local = (root, relative) => validatePhysicalWorkspacePath(root, path.join(root, relative), 'Living CV');
const master = (root) => local(root, 'cv/master-cv.md');
const configFile = (root) => local(root, 'cv/living-cv.json');
const intentFile = (root) => local(root, 'cv/living-cv-approval.json');

export function hasPendingLivingCvApproval(root) {
  return fs.existsSync(path.join(root, 'cv/living-cv-approval.json'));
}

export function assertLivingCvReady(root) {
  if (hasPendingLivingCvApproval(root)) throw new Error('Recover the pending CV approval before using or changing CV evidence.');
}

function readConfig(root) {
  const file = configFile(root);
  if (!fs.existsSync(file)) return { schemaVersion: 1, sourcePath: null, profileReviewPending: false };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schemaVersion !== 1 || (value.sourcePath !== null && typeof value.sourcePath !== 'string')) throw new Error('Living CV configuration is invalid.');
  return value;
}

function sourceFile(root, value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) || !/\.(md|markdown|json)$/i.test(value)) throw new Error('Choose an absolute path to an external Markdown or JSON file.');
  const file = path.resolve(value);
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Choose a regular source file rather than a link, pipe or device.');
  const canonical = fs.realpathSync(file);
  if ([file, canonical].some((candidate) => candidate.split(path.sep).some((component) => component.toLowerCase() === '.scout'))) {
    throw new Error('A Living CV source cannot read private .scout state.');
  }
  const inside = (directory, candidate) => {
    const relative = path.relative(directory, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  for (const instance of readHousehold().instances) {
    // Retain unavailable registry paths as privacy boundaries. Resolve aliases
    // when present without requiring another person's workspace to be healthy.
    const boundaries = [instance.workspace];
    try { boundaries.push(fs.realpathSync(instance.workspace)); } catch {}
    if (boundaries.some((directory) => inside(directory, file) || inside(directory, canonical))) {
      throw new Error('A Living CV source cannot read a registered household workspace.');
    }
  }
  if (inside(fs.realpathSync(root), canonical)) throw new Error('The source must be outside this workspace. Scout only reads the external file.');
  const canonicalStat = fs.lstatSync(canonical, { bigint: true });
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink() || canonicalStat.dev !== stat.dev || canonicalStat.ino !== stat.ino) throw new Error('The source changed while checking its path.');
  return { file: canonical, identity: canonicalStat };
}

function readSource(root, filename) {
  const { file, identity } = sourceFile(root, filename);
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  let raw;
  try {
    const stat = fs.fstatSync(handle, { bigint: true });
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size > BigInt(MAX_BYTES)) throw new Error('The source must be an unchanged regular file of at most 256 KiB.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(handle, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > MAX_BYTES) throw new Error('The source is too large.');
    const after = fs.fstatSync(handle, { bigint: true });
    const selected = sourceFile(root, filename).identity;
    if ([after, selected].some((current) => current.dev !== identity.dev || current.ino !== identity.ino
      || current.size !== identity.size || current.mtimeNs !== identity.mtimeNs || current.ctimeNs !== identity.ctimeNs)) {
      throw new Error('The source changed while reading. Review the current file again.');
    }
    raw = buffer.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(handle); }
  let markdown = raw;
  if (/\.json$/i.test(file)) {
    const envelope = JSON.parse(raw);
    if (!envelope || typeof envelope.markdown !== 'string' || Object.keys(envelope).some((key) => key !== 'markdown')) throw new Error('JSON CV sources must contain only a markdown string.');
    markdown = envelope.markdown;
  }
  if (Buffer.byteLength(markdown.trim(), 'utf8') < 500 || markdown.includes('\0')) throw new Error('The source CV is empty or incomplete; include at least 500 bytes of confirmed CV text.');
  return { markdown, sourceDigest: digest(raw) };
}

export function cvLineDiff(before, after) {
  const previous = before.split(/\r?\n/);
  const next = after.split(/\r?\n/);
  let start = 0;
  while (start < Math.min(previous.length, next.length) && previous[start] === next[start]) start++;
  let end = 0;
  while (end < Math.min(previous.length, next.length) - start && previous.at(-end - 1) === next.at(-end - 1)) end++;
  const lines = [
    ...previous.slice(Math.max(0, start - 2), start).map((text) => ({ kind: 'context', text })),
    ...previous.slice(start, end ? -end : undefined).map((text) => ({ kind: 'removed', text })),
    ...next.slice(start, end ? -end : undefined).map((text) => ({ kind: 'added', text })),
    ...next.slice(next.length - end, next.length - end + 2).map((text) => ({ kind: 'context', text })),
  ];
  // Never offer approval for a silently truncated diff.
  if (lines.length > 4000) throw new Error('This change is too large to review here. Reduce it to fewer than 4,000 changed lines.');
  return lines;
}

function versions(root, { verify = false } = {}) {
  const directory = local(root, 'cv/versions');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.md$/.test(name)).map((name) => {
    const file = local(root, `cv/versions/${name}`);
    if (verify && digest(fs.readFileSync(file)) !== name.slice(0, -3)) throw new Error('An immutable CV version failed its digest check. Existing CV kept.');
    return { id: name.slice(0, -3), savedAt: fs.statSync(file).mtime.toISOString() };
  }).sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id));
}

export function livingCvStatus(root) {
  const config = readConfig(root);
  let reviewed = false;
  const marker = local(root, '.scout/onboarding/activated.json');
  try { reviewed = Boolean(config.approvedMasterDigest && JSON.parse(fs.readFileSync(marker, 'utf8')).livingCvEvidenceDigest === config.approvedMasterDigest); } catch {}
  const result = { ...config, profileReviewPending: Boolean(config.sourcePath && config.profileReviewPending && !reviewed), versions: versions(root), state: 'disconnected', revision: null, diff: [] };
  if (hasPendingLivingCvApproval(root)) return { ...result, state: 'recovery-needed', message: 'An interrupted CV approval needs recovery. Your versions and any later edits are preserved.' };
  if (!config.sourcePath) return result;
  try {
    const current = fs.existsSync(master(root)) ? fs.readFileSync(master(root), 'utf8') : '';
    const source = readSource(root, config.sourcePath);
    const changed = config.approvedSourceDigest ? source.sourceDigest !== config.approvedSourceDigest : current !== source.markdown;
    return {
      ...result,
      state: changed ? 'changed' : 'current',
      revision: digest(JSON.stringify([config, source.sourceDigest, digest(current)])),
      sourceDigest: source.sourceDigest,
      diff: changed ? cvLineDiff(current, source.markdown) : [],
    };
  } catch {
    return { ...result, state: 'unavailable', message: 'The source cannot be read as a complete Markdown CV. Check the path, permissions, size and JSON format. Your saved CV is unchanged.' };
  }
}

export function readLivingCvVersion(root, id) {
  if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid CV version.');
  const content = fs.readFileSync(local(root, `cv/versions/${id}.md`), 'utf8');
  if (digest(content) !== id) throw new Error('CV version failed its digest check.');
  return content;
}

export function approvedLivingCvEvidence(root) {
  assertLivingCvReady(root);
  const config = readConfig(root);
  return config.sourcePath && config.approvedMasterDigest ? readLivingCvVersion(root, config.approvedMasterDigest) : null;
}

export function livingCvEvidenceRevision(root) {
  assertLivingCvReady(root);
  return fs.existsSync(configFile(root)) ? digest(fs.readFileSync(configFile(root))) : null;
}

// Caller holds the shared workspace mutation authority for a successful explicit import.
export function retireLivingCvSource(root) {
  assertLivingCvReady(root);
  if (!fs.existsSync(configFile(root))) return;
  const config = readConfig(root);
  atomicWriteFile(configFile(root), JSON.stringify({ ...config, sourcePath: null, approvedMasterDigest: null, approvedSourceDigest: null, profileReviewPending: false }) + '\n', { mode: 0o600 });
}

export function configureLivingCv(root, sourcePath) {
  return withWorkspaceMutationAuthority(root, { kind: 'living-cv-config', phase: 'configure-source' }, () => {
    assertLivingCvReady(root);
    const config = readConfig(root);
    if (sourcePath !== null) readSource(root, sourcePath);
    atomicWriteFile(configFile(root), JSON.stringify({ ...config, sourcePath: sourcePath === null ? null : path.resolve(sourcePath) }) + '\n', { mode: 0o600 });
    return livingCvStatus(root);
  });
}

function finishApproval(root, intent, writeFile = atomicWriteFile, renew = () => {}) {
  const hex = (value) => /^[a-f0-9]{64}$/.test(value || '');
  if (intent?.schemaVersion !== 1 || !['beforeMaster', 'afterMaster', 'beforeConfig', 'afterConfig'].every((key) => hex(intent[key])) || typeof intent.configText !== 'string' || digest(intent.configText) !== intent.afterConfig || JSON.parse(intent.configText).approvedMasterDigest !== intent.afterMaster) throw new Error('CV approval recovery intent is invalid.');
  const previous = readLivingCvVersion(root, intent.beforeMaster);
  const updated = readLivingCvVersion(root, intent.afterMaster);
  const masterHash = fs.existsSync(master(root)) ? digest(fs.readFileSync(master(root))) : digest('');
  const configHash = digest(fs.readFileSync(configFile(root)));
  if (![intent.beforeMaster, intent.afterMaster].includes(masterHash) || ![intent.beforeConfig, intent.afterConfig].includes(configHash)) throw new Error('CV approval recovery conflict. Later edits were preserved; restore or review the conflicting files.');
  if (masterHash !== intent.afterMaster) { renew(); writeFile(master(root), updated, { mode: 0o600 }); }
  if (configHash !== intent.afterConfig) { renew(); writeFile(configFile(root), intent.configText, { mode: 0o600 }); }
  if (digest(fs.readFileSync(master(root))) !== intent.afterMaster || digest(fs.readFileSync(configFile(root))) !== intent.afterConfig) throw new Error('CV approval recovery could not verify its replacements.');
  // Retain both versions even after the intent is complete.
  if (digest(previous) !== intent.beforeMaster) throw new Error('CV version failed its digest check.');
  renew();
  fs.rmSync(intentFile(root));
}

export function recoverLivingCvApproval(root) {
  if (!hasPendingLivingCvApproval(root)) return livingCvStatus(root);
  return withWorkspaceMutationAuthority(root, { kind: 'living-cv-recovery', phase: 'recover-approval' }, ({ renew }) => {
    if (hasPendingLivingCvApproval(root)) finishApproval(root, JSON.parse(fs.readFileSync(intentFile(root), 'utf8')), atomicWriteFile, renew);
    return livingCvStatus(root);
  });
}

export function approveLivingCv(root, { revision, confirmed } = {}, { writeFile = atomicWriteFile } = {}) {
  if (confirmed !== true) throw new Error('Confirm the exact CV diff before approval.');
  return withWorkspaceMutationAuthority(root, { kind: 'living-cv-approval', phase: 'approve-source' }, ({ renew }) => {
    const status = livingCvStatus(root);
    if (status.state !== 'changed' || !revision || revision !== status.revision) throw new Error('The source or master CV changed. Review the new diff before approval.');
    const config = readConfig(root);
    const source = readSource(root, config.sourcePath);
    const previous = fs.existsSync(master(root)) ? fs.readFileSync(master(root), 'utf8') : '';
    // Bind a second source read to what the person actually reviewed.
    if (digest(JSON.stringify([config, source.sourceDigest, digest(previous)])) !== revision) throw new Error('The source or CV changed. Review it again.');
    const history = versions(root, { verify: true });
    const values = [...new Set([previous, source.markdown])];
    const additions = values.filter((text) => !history.some(({ id }) => id === digest(text)));
    if (history.length + additions.length > MAX_VERSIONS) throw new Error('CV version history is full. Archive it before approving another change.');
    for (const content of additions) { renew(); writeFile(local(root, `cv/versions/${digest(content)}.md`), content, { mode: 0o600 }); }
    const configText = JSON.stringify({ ...config, approvedMasterDigest: digest(source.markdown), approvedSourceDigest: source.sourceDigest, profileReviewPending: true }) + '\n';
    const intent = { schemaVersion: 1, beforeMaster: digest(previous), afterMaster: digest(source.markdown), beforeConfig: digest(fs.readFileSync(configFile(root))), afterConfig: digest(configText), configText };
    renew();
    writeFile(intentFile(root), JSON.stringify(intent) + '\n', { mode: 0o600 });
    finishApproval(root, intent, writeFile, renew);
    return livingCvStatus(root);
  });
}
