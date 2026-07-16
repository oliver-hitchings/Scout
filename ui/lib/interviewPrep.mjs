import fs from 'node:fs';
import path from 'node:path';
import { slugOf } from './chatPrompts.mjs';

const OPPORTUNITY_ID = /^[a-z0-9][a-z0-9-]*$/;

function checkedEntry(entry) {
  if (!entry || !OPPORTUNITY_ID.test(String(entry.id || ''))) throw new Error('invalid interview prep opportunity');
  if (!String(entry.company || '').trim()) throw new Error('interview prep company is required');
  return entry;
}

export function interviewPrepRelativePath(entry) {
  const selected = checkedEntry(entry);
  const company = slugOf(selected.company);
  if (!company) throw new Error('interview prep company must contain a path-safe character');
  return `applications/${company}/interview-prep/${selected.id}.md`;
}

export function interviewPrepPath(repoRoot, entry) {
  return path.join(repoRoot, ...interviewPrepRelativePath(entry).split('/'));
}

export function readInterviewPrep(repoRoot, entry, maximum = 100_000) {
  const relativePath = interviewPrepRelativePath(entry);
  const file = interviewPrepPath(repoRoot, entry);
  if (!fs.existsSync(file)) return { exists: false, path: relativePath, content: '', updatedAt: null };
  const stat = fs.statSync(file);
  return {
    exists: true,
    path: relativePath,
    content: fs.readFileSync(file, 'utf8').slice(0, maximum),
    updatedAt: stat.mtime.toISOString(),
  };
}

export function interviewPrepPrefills(entry) {
  const selected = checkedEntry(entry);
  const output = interviewPrepRelativePath(selected);
  const stage = (selected.application?.stages || []).find((item) => !item.completed)?.name || '';
  const stageLine = stage
    ? `The recorded current stage is ${stage}. Make the preparation specific to that stage.`
    : 'No interview stage is recorded. Treat predictions as general preparation and ask me for any known stage, format, interviewer, and timing details.';
  return {
    interviewPrep: `Use $interview-prep to prepare me for ${selected.company} (${selected.role}), opportunity ${selected.id}. ${stageLine} Build or update ${output}.`,
    prepRefresh: `Use $interview-prep to refresh the public company and role research for ${selected.company} (${selected.role}) and update ${output}. Preserve my existing My notes section.`,
    prepQuestions: `Use $interview-prep for ${selected.company} (${selected.role}). Focus on likely questions I may be asked, evidence-backed answer outlines, and strong questions for me to ask. Update ${output} without inventing facts.`,
    prepMock: `Use $interview-prep for ${selected.company} (${selected.role}). Run a realistic mock interview one question at a time, wait for each answer, then give concise evidence-led feedback. Keep ${output} current where useful.`,
  };
}

export function interviewPrepAgentPrompt(entry, userRequest) {
  const selected = checkedEntry(entry);
  const output = interviewPrepRelativePath(selected);
  const jobChat = `data/chats/${selected.id}.json`;
  const companyTimeline = `data/companies/${slugOf(selected.company)}.json`;
  return [
    'Act only as Scout\'s dedicated interview-prep agent for the authoritative selected opportunity below.',
    'Use the $interview-prep skill. Never switch to another opportunity, send anything, change tracker status, or commit.',
    `Write durable preparation only to ${output}. The general job chat is ${jobChat}; company relationship context may exist at ${companyTimeline}.`,
    'Opening this chat must not perform work by itself; perform only the explicit user request in this turn.',
    `User request:\n${userRequest}`,
  ].join('\n\n');
}
