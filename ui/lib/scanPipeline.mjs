import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { serializeTracker } from './tracker.mjs';
import { workspacePaths } from './workspace.mjs';
import {
  advertMateriallyChanged, jobIdentity, mergeSourceReferences, sameUnderlyingJob, sourceReferencesOf,
} from './jobIdentity.mjs';

const EMPTY_DISCARDED = Object.freeze({ hard_exclusion: 0, mandatory_unmet: 0, below_threshold: 0, provider_discarded: 0 });

export const SCAN_ASSESSMENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    assessments: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          candidateId: { type: 'string' }, categoryId: { type: ['string', 'null'] }, summary: { type: 'string' },
          hardExclusionMatches: { type: 'array', items: { type: 'string' } },
          mandatoryRequirements: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: {
                requirement: { type: 'string' }, advertEvidence: { type: 'string' },
                advertEvidenceId: { type: 'string' },
                status: { type: 'string', enum: ['met', 'unmet', 'unknown'] }, profileEvidence: { type: ['string', 'null'] },
              }, required: ['requirement', 'advertEvidence', 'advertEvidenceId', 'status', 'profileEvidence'],
            },
          },
          dimensions: {
            type: 'array', minItems: 1, items: {
              type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, score: { type: 'number' }, maximum: { type: 'number' }, evidence: { type: 'string' } },
              required: ['name', 'score', 'maximum', 'evidence'],
            },
          },
          recommendation: { type: 'string', enum: ['keep', 'discard'] },
        }, required: ['candidateId', 'categoryId', 'summary', 'hardExclusionMatches', 'mandatoryRequirements', 'dimensions', 'recommendation'],
      },
    },
  }, required: ['assessments'],
});

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'opportunity';
}

function mandatorySignals(description, requirements) {
  const sourceRequirements = String(requirements || '').split(/(?:\r?\n|;\s*)/)
    .map((text) => text.trim())
    .filter((text) => text && !/\b(?:benefits?|perks?|stock options?|compensation|salary|remote-friendly)\b/i.test(text));
  const explicitLanguage = String(description || '').split(/(?:\r?\n|[.;]\s+)/)
    .map((text) => text.trim()).filter((text) => text && /\b(?:required|essential|must|mandatory|non-negotiable)\b/i.test(text));
  return [...new Set([...sourceRequirements, ...explicitLanguage])]
    .slice(0, 12).map((text, index) => ({ id: `mandatory-${String(index + 1).padStart(2, '0')}`, text: text.slice(0, 300) }));
}

export function compactCandidates(sources, maximum = 40) {
  const candidates = [];
  for (const source of Object.values(sources || {})) {
    for (const job of source?.jobs || []) {
      const company = String(job?.company || '').trim();
      const role = String(job?.title || job?.role || '').trim();
      const url = String(job?.url || '').trim();
      if (!company || !role || !/^https?:\/\//i.test(url)) continue;
      const incoming = {
        company, role, url, location: String(job?.location || ''), salary: job?.salary || null,
        workingType: String(job?.workingType || ''), postedDate: job?.postedDate || null,
        source: String(job?.source || ''), providerId: String(job?.providerId || ''),
        description: String(job?.description || ''), requirements: String(job?.requirements || ''),
        tags: Array.isArray(job?.tags) ? job.tags : [], sourceReferences: sourceReferencesOf(job), duplicateCount: 1,
      };
      const duplicate = candidates.find((candidate) => sameUnderlyingJob(candidate, incoming));
      if (duplicate) {
        duplicate.sourceReferences = mergeSourceReferences(duplicate, incoming);
        duplicate.duplicateCount += 1;
        duplicate.tags = [...new Set([...duplicate.tags, ...incoming.tags])];
        if (incoming.description.length > duplicate.description.length) duplicate.description = incoming.description;
        if (!duplicate.salary && incoming.salary) duplicate.salary = incoming.salary;
        continue;
      }
      if (candidates.length < maximum) candidates.push(incoming);
    }
  }
  return candidates.map((candidate, index) => ({
    ...candidate,
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    description: candidate.description.slice(0, 1200),
    sources: [...new Set(candidate.sourceReferences.map((reference) => reference.url).filter(Boolean))],
    mandatorySignals: mandatorySignals(candidate.description, candidate.requirements),
  }));
}

export function validateAssessments(value, candidates) {
  if (!value || !Array.isArray(value.assessments)) throw new Error('scan assessment must contain an assessments array');
  const known = new Set(candidates.map((item) => item.candidateId));
  const seen = new Set();
  for (const item of value.assessments) {
    if (!known.has(item.candidateId) || seen.has(item.candidateId)) throw new Error(`invalid or duplicate candidate assessment: ${item.candidateId}`);
    seen.add(item.candidateId);
    if (!Array.isArray(item.dimensions) || !item.dimensions.length) throw new Error(`assessment lacks score dimensions: ${item.candidateId}`);
    const maximum = item.dimensions.reduce((sum, dimension) => sum + Number(dimension.maximum), 0);
    if (Math.abs(maximum - 100) > 0.001) throw new Error(`assessment dimensions must total 100: ${item.candidateId}`);
    for (const dimension of item.dimensions) {
      if (!Number.isFinite(dimension.score) || !Number.isFinite(dimension.maximum)
          || dimension.score < 0 || dimension.score > dimension.maximum) throw new Error(`invalid score dimension: ${item.candidateId}`);
    }
    const candidate = candidates.find((entry) => entry.candidateId === item.candidateId);
    const knownSignals = new Set((candidate?.mandatorySignals || []).map((signal) => signal.id));
    for (const requirement of item.mandatoryRequirements || []) {
      if (!requirement.requirement || !requirement.advertEvidence || !requirement.advertEvidenceId) throw new Error(`mandatory requirement lacks advert evidence: ${item.candidateId}`);
      if (!knownSignals.has(requirement.advertEvidenceId) && !/^provider-[a-z0-9-]+$/i.test(requirement.advertEvidenceId)) {
        throw new Error(`mandatory requirement cites unknown advert evidence: ${item.candidateId}`);
      }
      if (requirement.status === 'met' && !String(requirement.profileEvidence || '').trim()) throw new Error(`met requirement lacks profile evidence: ${item.candidateId}`);
    }
    const coveredSignals = new Set((item.mandatoryRequirements || []).map((requirement) => requirement.advertEvidenceId));
    const missingSignals = [...knownSignals].filter((id) => !coveredSignals.has(id));
    if (missingSignals.length) throw new Error(`assessment omitted mandatory advert evidence ${missingSignals.join(', ')}: ${item.candidateId}`);
  }
  if (seen.size !== candidates.length) throw new Error(`scan assessment covered ${seen.size} of ${candidates.length} candidates`);
  return value;
}

export function gateAssessment(assessment, policy) {
  const actionScore = Number(policy?.actionScore ?? 70);
  const checkScore = Number(policy?.checkScore ?? 55);
  const total = Math.round(assessment.dimensions.reduce((sum, item) => sum + Number(item.score), 0) * 100) / 100;
  const unmet = (assessment.mandatoryRequirements || []).filter((item) => item.status === 'unmet');
  const unknown = (assessment.mandatoryRequirements || []).filter((item) => item.status === 'unknown');
  const excluded = (assessment.hardExclusionMatches || []).length > 0;
  if (assessment.recommendation === 'discard' || excluded || unmet.length) {
    return { eligibility: 'ineligible', score: Math.min(total, checkScore - 1), keep: false, reasons: [...assessment.hardExclusionMatches, ...unmet.map((item) => item.requirement)] };
  }
  if (unknown.length) {
    return { eligibility: 'check', score: Math.min(total, actionScore - 1), keep: total >= checkScore, reasons: unknown.map((item) => item.requirement) };
  }
  return { eligibility: total >= actionScore ? 'eligible' : total >= checkScore ? 'check' : 'below-threshold', score: total, keep: total >= checkScore, reasons: [] };
}

function sourceHealth(sources) {
  return Object.fromEntries(Object.entries(sources || {}).map(([name, value]) => [name, {
    status: value.status || 'unavailable', count: Number.isFinite(Number(value.count)) ? Number(value.count) : null,
    reason: value.reason || null, configured: value.configured !== false,
  }]));
}

function mergeTracker(existing, candidates, assessments, policy, date) {
  const byId = new Map(existing.opportunities.map((entry) => [entry.id, entry]));
  const discarded = { ...EMPTY_DISCARDED };
  let keepersAdded = 0;
  let keepersUpdated = 0;
  for (const assessment of assessments) {
    const candidate = candidates.find((item) => item.candidateId === assessment.candidateId);
    if (!candidate) continue;
    const gate = gateAssessment(assessment, policy);
    if (!gate.keep) {
      if ((assessment.hardExclusionMatches || []).length) discarded.hard_exclusion += 1;
      else if ((assessment.mandatoryRequirements || []).some((item) => item.status === 'unmet')) discarded.mandatory_unmet += 1;
      else if (assessment.recommendation === 'discard') discarded.provider_discarded += 1;
      else discarded.below_threshold += 1;
      continue;
    }
    const baseId = `${slug(candidate.company)}-${slug(candidate.role)}-${date.slice(0, 7)}`;
    const previous = existing.opportunities.find((entry) => sameUnderlyingJob(entry, candidate));
    let id = previous?.id || baseId;
    for (let suffix = 2; !previous && byId.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    const changedAdvert = Boolean(previous && advertMateriallyChanged(previous, candidate));
    const references = mergeSourceReferences(previous || {}, candidate);
    const urls = references.map((reference) => reference.url).filter(Boolean);
    const generated = {
      id, company: candidate.company, role: candidate.role, location: candidate.location || previous?.location || '', score: gate.score,
      scoreBreakdown: Object.fromEntries(assessment.dimensions.map((item) => [item.name, item.score])),
      eligibility: { status: gate.eligibility, reasons: gate.reasons },
      mandatoryRequirements: assessment.mandatoryRequirements,
      status: previous?.status || 'new', category: assessment.categoryId || previous?.category || null,
      tags: [...new Set([...(previous?.tags || []), ...(candidate.tags || []), ...(gate.eligibility === 'check' ? ['Check mandatory requirement'] : []), ...(changedAdvert ? ['Updated advert — review'] : [])])],
      sources: [...new Set([...(previous?.sources || []), ...urls])], sourceReferences: references,
      jobIdentity: jobIdentity(candidate),
      notes: previous && Object.hasOwn(previous, 'notes') ? previous.notes : assessment.summary,
      lastChecked: date, foundVia: candidate.source, contacts: previous?.contacts || [], log: previous?.log || [],
      ...(changedAdvert ? { advertUpdate: { detectedAt: date, previousFingerprint: previous.jobIdentity?.advertFingerprint || '', currentFingerprint: jobIdentity(candidate).advertFingerprint } } : {}),
    };
    if (previous) { Object.assign(previous, generated); keepersUpdated += 1; }
    else { existing.opportunities.push(generated); byId.set(generated.id, generated); keepersAdded += 1; }
  }
  existing.updated = date;
  return { tracker: existing, keepersAdded, keepersUpdated, discarded };
}

function applyTrustedExclusions(candidates, assessmentResult, exclusions = []) {
  if (!assessmentResult) return null;
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const terms = exclusions.map((term) => String(term || '').trim()).filter(Boolean);
  return {
    ...assessmentResult,
    assessments: assessmentResult.assessments.map((assessment) => {
      const candidate = byId.get(assessment.candidateId);
      const haystack = `${candidate?.company || ''}\n${candidate?.role || ''}\n${candidate?.description || ''}`.toLowerCase();
      const matches = terms.filter((term) => haystack.includes(term.toLowerCase()));
      return { ...assessment, hardExclusionMatches: [...new Set([...(assessment.hardExclusionMatches || []), ...matches])] };
    }),
  };
}

function reportText({ date, degraded, source_health, kept, discarded, errors }) {
  const coverage = Object.entries(source_health).map(([name, value]) => `- ${name}: ${value.configured === false ? 'not configured' : value.status} (${value.count ?? 'unknown'})${value.reason ? ` — ${value.reason}` : ''}`).join('\n');
  const actions = kept.filter((item) => item.eligibility?.status === 'eligible').map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${item.sources?.[0] || ''}`).join('\n') || '- None.';
  const checks = kept.filter((item) => item.eligibility?.status === 'check').map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${(item.eligibility.reasons || []).join('; ')}`).join('\n') || '- None.';
  return `# Scout report — ${date}\n\n## Headline\n\n${degraded ? 'Coverage was degraded; this is not evidence that no suitable roles exist.' : 'Configured sources completed successfully.'}\n\n${coverage}\n\n## Action today\n\n${actions}\n\n## One check from unlocking\n\n${checks}\n\n## Follow-ups due\n\n- Review existing tracker follow-ups in Scout.\n\n## Changes since last scan\n\n- ${kept.length} current keeper(s) in the tracker.\n\n## Discarded\n\n${Object.entries(discarded).map(([name, count]) => `- ${name}: ${count}`).join('\n')}\n\n## Verdicts\n\n${errors.length ? errors.map((error) => `- Error: ${error}`).join('\n') : '- No applications or outreach were sent.'}\n`;
}

function atomicWrite(file, content) {
  atomicWriteFile(file, content);
}

export function validateWrittenScanArtifacts(root, expectedRun) {
  const paths = workspacePaths(root);
  const tracker = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  if (!Array.isArray(tracker.opportunities)) throw new Error('scan tracker artifact is invalid');
  const report = fs.readFileSync(path.join(paths.reports, `${expectedRun.timestamp.slice(0, 10)}.md`), 'utf8');
  for (const heading of ['Headline', 'Action today', 'One check from unlocking', 'Follow-ups due', 'Changes since last scan', 'Discarded', 'Verdicts']) {
    if (!report.includes(`## ${heading}`)) throw new Error(`scan report is missing ${heading}`);
  }
  const lines = fs.readFileSync(paths.scanRuns, 'utf8').trim().split(/\r?\n/);
  const run = JSON.parse(lines.at(-1));
  for (const field of ['schemaVersion', 'timestamp', 'agent', 'mode', 'degraded', 'sources_checked', 'candidates_found', 'keepers_added', 'discarded', 'errors', 'source_health']) {
    if (!Object.hasOwn(run, field)) throw new Error(`scan run is missing ${field}`);
  }
  if (run.timestamp !== expectedRun.timestamp || run.agent !== expectedRun.agent || run.mode !== expectedRun.mode) throw new Error('scan run record does not match the completed request');
  return { tracker, report, run };
}

export function writeScanArtifacts(root, { provider, mode, sources, queries = [], candidates, assessmentResult, policy, exclusions = [], startedAt, error = null, skipped = false }) {
  const paths = workspacePaths(root);
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10);
  const health = sourceHealth(sources);
  const configuredSources = Object.values(health).filter((item) => item.configured !== false);
  const configuredFailures = Object.values(health).filter((item) => item.configured !== false && item.status !== 'healthy');
  const errors = [...(error ? [error] : []), ...(configuredSources.length ? [] : ['no job sources are configured'])];
  const degraded = configuredFailures.length > 0 || errors.length > 0;
  const existing = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  const trustedAssessments = applyTrustedExclusions(candidates, assessmentResult, exclusions);
  const merged = trustedAssessments
    ? mergeTracker(existing, candidates, trustedAssessments.assessments, policy, date)
    : { tracker: existing, keepersAdded: 0, keepersUpdated: 0, discarded: { ...EMPTY_DISCARDED } };
  const run = {
    schemaVersion: 2, timestamp, started_at: startedAt, agent: provider, mode, degraded, skipped,
    sources_checked: Object.entries(health).filter(([, item]) => item.configured !== false).map(([name]) => name),
    queries_checked: [...queries], candidates_found: candidates.length, keepers_added: merged.keepersAdded,
    duplicates_collapsed: candidates.reduce((total, candidate) => total + Math.max(0, Number(candidate.duplicateCount || 1) - 1), 0),
    keepers_updated: merged.keepersUpdated,
    discarded: merged.discarded, errors, source_health: health,
  };
  const earlierRuns = fs.existsSync(paths.scanRuns)
    ? fs.readFileSync(paths.scanRuns, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((item) => item?.timestamp?.startsWith(date))
    : [];
  const dayRuns = [...earlierRuns, run];
  const dayErrors = [...new Set(dayRuns.flatMap((item) => item.errors || []))];
  const baseReport = reportText({
    date,
    degraded: dayRuns.some((item) => item.degraded),
    source_health: health,
    kept: merged.tracker.opportunities,
    discarded: merged.discarded,
    errors: dayErrors,
  });
  const runLines = dayRuns.map((item) => {
    const sourcesSummary = Object.entries(item.source_health || {}).map(([name, value]) => `${name}: ${value.status}`).join(', ') || 'no sources';
    return `- **${item.agent} ${item.mode}** at ${String(item.timestamp || '').slice(11, 16) || 'unknown time'} UTC - ${item.skipped ? 'skipped because another scan was running' : item.degraded ? 'degraded' : 'healthy'}; ${item.candidates_found || 0} candidate(s), ${item.keepers_added || 0} added, ${item.keepers_updated || 0} updated; ${sourcesSummary}.`;
  }).join('\n');
  const report = baseReport.replace('## Action today', `## Scan runs\n\n${runLines}\n\n## Action today`);
  if (!error) atomicWrite(paths.tracker, serializeTracker(merged.tracker));
  atomicWrite(path.join(paths.reports, `${date}.md`), report);
  fs.mkdirSync(path.dirname(paths.scanRuns), { recursive: true });
  fs.appendFileSync(paths.scanRuns, `${JSON.stringify(run)}\n`, 'utf8');
  validateWrittenScanArtifacts(root, run);
  return { run, tracker: merged.tracker, report: path.join(paths.reports, `${date}.md`) };
}
