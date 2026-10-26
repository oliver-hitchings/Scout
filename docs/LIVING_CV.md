# Living CV and application drafts

Living CV connects Scout to one Markdown or JSON file maintained by another local application. Scout only reads that file. Your approved master CV, versions, profile and application drafts stay in the selected private workspace.

## Connect and approve a source

1. Open **CV → Living CV**, enter the absolute path to the source file on the computer running Scout, then choose **Connect source**. On a phone, this is a path on the Scout host, not on the phone.
2. Use Markdown, or a JSON object with exactly one `markdown` string containing the CV text. The file must be a regular file outside the workspace, between 500 bytes and 256 KiB. Choose the original file rather than a symbolic link.
3. Read the diff. Removed lines have a minus sign; added lines have a plus sign. Scout keeps using the saved CV while you review. It will not approve a truncated diff.
4. Check the confirmation and choose **Approve this CV change**. Approval is bound to the exact source and saved CV you reviewed. If either changed, refresh and review again. A running scan may delay the save; retry after it finishes.

While the app is open, Scout checks every 30 seconds and shows a notice on every tab when the source changes or becomes unavailable. Opening the CV library or choosing **Check for changes** also checks it. Changes while Scout is closed are found the next time it opens. Missing, invalid or oversized sources never erase your saved CV.

Both the previous CV and the approved text are saved under `cv/versions/`, identified by their SHA-256 digests. **Saved CV versions** shows them read-only and checks their digests. Scout never edits an existing version. History is bounded to 256 distinct versions; it does not automatically discard old CVs. Keep private backups. If history fills, move older versions into a private archive, retaining the active approved version and a backup of every archived file.

An approval interrupted by a failed write or shutdown keeps a prepared recovery record. On startup, status refresh or the next scan, Scout finishes only the exact approved replacements under the workspace lock. If you edited either file after the interruption, Scout preserves that edit and asks for recovery instead of overwriting it. Scans and profile rebuilding wait until the approval is consistent. See [troubleshooting](TROUBLESHOOTING.md).

Disconnecting stops source checks, retires that source as active profile-rebuild evidence, and keeps the saved CV and history. Importing another CV also disconnects the source so new imported evidence is used. A restored workspace may need the source path reconnected on its new host. External source files themselves are not included in Scout backups; approved copies and workspace history are.

## Rebuild the profile after a CV change

After approval, choose **Rebuild my profile from this CV**, then **Generate proposal**. Scout uses the approved immutable CV version as evidence instead of stale imported CV text. Review the staged changes, activate the proposal and review/publish changed search rules. Generation uses your chosen AI service only when you request it. You can also use **Review my search preferences** to edit the rules yourself.

Profile generation binds the CV, selected evidence source, imported evidence and active file revisions before the provider starts. A newer edit or approval requires regeneration; an older proposal cannot overwrite the newer evidence. Rebuilding keeps existing schedules, enabled flags, providers, models, weekdays and times. The completed activation marker records which approved CV was used, so the rebuild reminder clears only after activation completes. Rephrasing the generated master does not count as a new external source edit.

The approved master CV immediately becomes assessment evidence for future scans. Its changed digest changes the assessment prompt version. Existing assessment history is preserved; the existing cap allows at most six unchanged historical rejections to be reassessed per scan when the prompt version changes. Newly discovered or materially changed jobs keep their normal assessment rules. No new preference becomes a hard exclusion without explicit review and publication.

## Edit and export a job draft

Choose **create custom CV** or **create custom cover letter** on a job, or open **CV → Review CV options** and select the tracked opportunity. Scout drafts material in the private `applications/<opportunity>/` folder. Two roles at the same employer use separate folders; older shared folders remain available with a legacy warning.

Select the draft in **CV**, edit its text, choose **save changes**, then **render PDF**. CVs use the existing Typst and quality-review path. Cover letters use editable `outreach.md`, rendered through the same Typst runtime into a PDF labelled **DRAFT**. The generated Typst source is treated as text, so Markdown cannot inject Typst commands. Changing either source makes its old PDF stale; render it again before download.

Every draft stays under your control. Scout does not send an application, message or attachment. A CV quality result checks its evidence and writing; you still decide whether to use it.

### Reviewed drafts with a local model

The local provider has no file tools. Use **CV → Review CV options → Create reviewed CV draft** or **Create reviewed letter draft**. With a local provider selected, the job's creation controls open the same flow. Choose **Generate draft from confirmed CV facts**. Scout asks the model only to select relevant evidence IDs, then copies those CV passages and their headings verbatim into a draft. The model cannot add qualifications or achievements through this selector.

Edit the preview, confirm the facts and choose **Save reviewed draft**. Generation alone never changes an application file. Save checks that the CV, job, evidence source and existing draft still match the reviewed revisions. A changed input requires regeneration. Previews remain in memory for one hour, at most 16 at a time; restart discards unsaved previews. They are not added to generic operation status or browser storage.

Scout's interface-update control waits while generation or an unsaved preview is open. Save the draft, or choose **Discard unsaved draft**, before refreshing to a newer interface.

Starting another reviewed draft asks before discarding an unsaved preview and
your edits. Cancel keeps the current text. While generation or saving is in
progress, wait for it to finish before switching drafts. Saving temporarily locks
the preview editor and its save/discard controls so later edits cannot be lost
behind the pending save.

Guided CV text is saved as `applications/<opportunity>/draft-cv.md`, with its own `draft-cv.typ` and `draft-cv.pdf` rendering target. Existing `cv.typ`, its PDF and its quality review remain available. Letters use the existing `outreach.md` path. Both guided PDFs are visibly labelled **DRAFT**, and their text stays editable in the library. The draft selector accepts a saved CV of 500 bytes to 96 KiB and up to 128 evidence sections, returns at most 40 selected sections and limits the editable preview to 64 KiB. It does not claim a passed application-CV quality review. Review the current advert and all facts yourself; nothing is sent.

## Feedback and employer notes

**Good fit** and **Poor fit** open a form for the decision, reason and explanation. **This job only** is the default. Choosing similar job titles or the employer creates an inspectable suggestion of plus or minus three ranking points; it does not publish it. Duplicate and already-seen decisions cannot create a fit-ranking suggestion. Other bounded rule and weight proposals remain available in **Settings → Feedback & learning**. You can inspect contributions, undo the active version, or reset all learned ranking changes without deleting feedback, proposals or history. Reset can itself be undone.

In **Settings → Employers**, mark employers as **priority** for the watch list, review their careers URL or supported board, and inspect monitoring health and check history. Priority still respects the check interval and scan capacity; overflow is reported. Generic careers parsing remains off until its terms and robots policy are reviewed and it is enabled. **Private notes** holds up to 4,000 characters per employer and does not change ranking or monitoring permissions. Collection failures preserve your notes and watch decisions.
