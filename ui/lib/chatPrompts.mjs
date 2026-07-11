export function slugOf(company) {
  return String(company || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildPrefills(entry, options = {}) {
  const slug = slugOf(entry.company);
  const cvPath = `applications/${slug}/cv.typ`;
  const style = [options.locale, options.tone].filter(Boolean).join(', ') || 'the locale and tone in workspace.json';
  return {
    ask: '',
    cv: `Create a tailored CV for ${entry.company} (${entry.role}) at ${cvPath}, in Typst, `
      + `then compile it: typst compile --root . ${cvPath}. `
      + `Draw only on cv/master-cv.md and the tracker entry for ${entry.id} in data/opportunities.json - invent nothing. `
      + `Use ${style}. Draft only, nothing sent.`,
    coverLetter: `Draft a tailored cover letter for ${entry.company} in applications/${slug}/outreach.md - `
      + `draw only on cv/master-cv.md and the tracker entry for ${entry.id} in data/opportunities.json. `
      + `Use ${style}. Draft only, nothing sent.`,
    tweak: `In ${cvPath}, <your change>, then recompile the PDF (typst compile --root . ${cvPath}). `
      + `Every claim must trace to cv/master-cv.md - invent nothing.`,
  };
}

export const HANDOFF_SUMMARY_PROMPT =
  'Summarise this conversation for a handoff to another assistant - decisions made, '
  + 'files created or edited (repo-relative paths), and what is still outstanding. '
  + 'Be concise and factual.';

export function handoffOpening(summary) {
  return 'You are taking over an in-progress task in this repo from another assistant. '
    + `Here is their handoff summary:\n\n${summary}\n\n`
    + 'Read the files it mentions before making changes. Continue from where they left off.';
}
