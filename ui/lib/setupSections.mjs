export const WORKSPACE_SETUP_SECTIONS = Object.freeze({
  welcome: 1, provider: 1, search: 1, adzuna: 1, cv: 1, 'ai-handoff': 1, 'first-scan': 1,
});

// completedAt predates section versions. Treat it as version 1 only, so a
// future section bump to version 2 still prompts users who skipped releases.
export function completedWorkspaceSections(setup = {}) {
  if (setup.completedSections && Object.keys(setup.completedSections).length) return { ...setup.completedSections };
  if (setup.completedAt) return Object.fromEntries(Object.keys(WORKSPACE_SETUP_SECTIONS).map((id) => [id, 1]));
  return {};
}

export function pendingWorkspaceSections(setup = {}) {
  const completed = completedWorkspaceSections(setup);
  return Object.entries(WORKSPACE_SETUP_SECTIONS)
    .filter(([id, version]) => Number(completed[id] || 0) < version)
    .map(([id, version]) => ({ id, version, scope: 'workspace', blocking: false, title: id }));
}
