# AI-assisted Setup and Retuning

Scout uses Codex or Claude for one bounded, schema-constrained proposal. The provider receives only validated setup fields and imported evidence, has no file-writing tools, cannot continue a prior session, and does not activate anything. Scout's trusted runtime validates evidence references and renders the five staged files itself.

## Before starting

Create or select a private workspace, install and authenticate a compatible provider CLI, and import a CV if available. Never paste provider login tokens or Adzuna keys into chat. Provider login remains in the official CLI; source keys belong in the workspace `.env` or setup credential form.

Imported evidence is not silently truncated. If extracted evidence exceeds 80,000 characters, Scout retains the import and asks you to provide a smaller source before spending an AI operation.

## Generate and review

Answer Scout's setup questions for:

- factual experience and supplied evidence;
- desired roles, sectors and locations;
- compensation and commute constraints;
- hard exclusions and writing tone.

Choose **Generate proposal**. Scout gives every supplied field and imported CV line a stable evidence ID. Every factual CV item, skill, qualification and achievement must cite one of those IDs. The provider proposes content, a 100-point rubric and search lanes; Scout validates them and stages:

1. `workspace.json`
2. `profile/context.md`
3. `profile/calibration.md`
4. `cv/master-cv.md`
5. `data/search-categories.json`

Review the staged-versus-active changes. Use **Discard** or **Regenerate** when anything is unsupported or unclear. **Approve and activate** is a trusted local operation and consumes no additional AI usage. It requires explicit confirmation, rejects stale or modified staging, backs up the active files, applies the set atomically and runs Scout doctor. Any failure restores all five prior files.

## Retuning

Update the setup preferences with concrete feedback, then generate and review a replacement proposal. Tracker entries, reports, chats, application history and prior scan records are outside the five-file activation set and remain unchanged. Avoid broad changes based on one ambiguous advert.

## Recovery

An interrupted proposal never changes active data. Reopen setup to review the current proposal, or discard it and generate another. Activation backups are under `.scout/backups`; see [Upgrades](UPGRADES.md).
