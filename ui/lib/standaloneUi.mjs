const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function livingCvHtml(status = {}) {
  const labels = { disconnected: 'No external source connected', current: 'No new changes in the source', changed: 'Source changed — review before using it', unavailable: 'Source needs attention', 'recovery-needed': 'Interrupted approval needs recovery — later edits are preserved' };
  const diff = (status.diff || []).map(({ kind, text }) => `<div class="cv-diff-${esc(kind)}"><span aria-label="${esc(kind)}">${kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}</span> ${esc(text)}</div>`).join('');
  return `<details id="living-cv"><summary>Living CV — keep a notes file connected</summary>
    <p>Scout only reads the file you choose. Changes wait here for your approval; the external file is never edited.</p>
    <label class="setup-field">Source file on the computer running Scout<input id="living-cv-source" value="${esc(status.sourcePath || '')}" placeholder="Absolute path to your Markdown or JSON file" autocomplete="off"></label>
    <p><button class="act" data-action="living-cv-connect">Connect source</button> <button class="act" data-action="living-cv-refresh">Check for changes</button>${status.sourcePath ? ' <button class="act" data-action="living-cv-disconnect">Disconnect source</button>' : ''}</p>
    <p role="status">${esc(labels[status.state] || 'Checking source…')}${status.message ? ` — ${esc(status.message)}` : ''}</p>
    ${status.state === 'changed' ? `<p>Removed lines have a − sign; added lines have a + sign. Approving keeps both CV versions and changes the evidence used by future scans. Existing assessments retain their history; at most six older rejections are reassessed per scan.</p><div class="cv-diff" aria-label="CV changes">${diff}</div><label><input id="living-cv-confirm" type="checkbox"> I reviewed this exact change and confirm the CV facts</label><p><button class="act primary" data-action="living-cv-approve">Approve this CV change</button></p>` : ''}
    ${status.profileReviewPending ? '<p>The new CV is saved. <button class="act" data-action="living-cv-reprofile">Rebuild my profile from this CV</button> to generate a reviewable proposal, or <button class="act" data-action="living-cv-profile">Review my search preferences</button> to edit search rules. Scout never publishes new preferences automatically.</p>' : ''}
    <details><summary>Saved CV versions (${status.versions?.length || 0})</summary><ul>${(status.versions || []).map((version) => `<li><button class="act" data-action="living-cv-version" data-version="${esc(version.id)}">${esc(version.savedAt)} · ${esc(version.id.slice(0, 12))}</button></li>`).join('')}</ul><pre id="living-cv-version-text" class="cv-version-text" aria-label="Saved CV version"></pre></details>
    <p class="meta">Use a Markdown file or JSON with one field: <code>{"markdown":"your CV text"}</code>. Files must be 500 bytes to 256 KiB. The path is local to this workspace; copying the workspace to another computer may require reconnecting it.</p>
  </details>`;
}

export function jobFeedbackHtml(opportunityId, preset = 'promising') {
  const decisions = [['promising', 'Good fit'], ['not-interested', 'Not for me'], ['saved', 'Saved'], ['applied', 'Applied'], ['interview', 'Interview'], ['rejected', 'Rejected'], ['duplicate', 'Duplicate'], ['already-seen', 'Already seen']];
  return `<section class="job-feedback" data-feedback-form="${esc(opportunityId)}" aria-label="Job feedback">
    <h3>What makes this a good or poor fit?</h3>
    <label>My decision<select data-feedback-decision>${decisions.map(([value, label]) => `<option value="${value}"${preset === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>Reason<select data-feedback-reason>${['positive', 'location', 'salary', 'seniority', 'responsibilities', 'employer', 'role-family', 'other', 'duplicate', 'already-seen'].map((reason) => `<option${(preset === 'promising' ? 'positive' : 'other') === reason ? ' selected' : ''}>${reason}</option>`).join('')}</select></label>
    <label>What should Scout know?<textarea data-feedback-explanation maxlength="1000" rows="3"></textarea></label>
    <label>Use this feedback for<select data-feedback-scope><option value="job">This job only</option><option value="title">Suggest a ranking change for similar job titles</option><option value="employer">Suggest a ranking change for this employer</option></select></label>
    <p class="meta">Suggestions wait in Settings for your review. One thumbs down never hides other jobs or creates a hard exclusion.</p>
    <p><button class="act primary" data-action="save-feedback" data-id="${esc(opportunityId)}">Save feedback</button> <button class="act" data-action="cancel-feedback">Cancel</button></p><p data-feedback-status role="status"></p>
  </section>`;
}
