# AI-assisted Setup and Retuning

Scout can use Codex or Claude as a setup assistant. The assistant reads the setup contract, asks for missing information, stages proposed files and waits for approval before activating them.

## Before starting

Create/select a private workspace, install and authenticate one provider, and import a CV if available. Never paste provider login tokens or Adzuna keys into chat. The provider CLI owns its login; source keys belong in the workspace `.env` or setup credential form.

## Setup prompt

Open Codex or Claude in the private workspace and use:

```text
Use the onboard-scout skill to set up my Scout workspace. Read workspace.json,
profile/context.md and profile/calibration.md if present. Interview me only for
missing information. Do not invent facts. Stage the proposed profile, scoring,
search and CV changes, explain them, validate the workspace, and wait for my
explicit approval before activation. Never send applications or outreach.
```

The interview should establish:

- factual experience and evidence;
- desired role families, sectors and locations;
- compensation and commute constraints;
- hard exclusions and useful trade-offs;
- scoring priorities, employer watchlists and writing tone.

Review every staged file. Correct unsupported statements and unclear defaults. Approval applies only to the shown workspace changes; it does not authorise sending anything.

## Retuning prompt

After reviewing real results, use:

```text
Use the onboard-scout skill to retune this workspace from my feedback. Preserve
tracker, application and calibration history. Append dated calibration evidence
instead of rewriting old decisions. Show the proposed changes and wait for my
approval before activation.
```

Give concrete examples: which result was overrated/underrated, why, and whether the lesson is a hard exclusion, search preference or scoring precedent. Avoid broad changes based on one ambiguous advert.

## Validation and recovery

Run `scout doctor` after activation and perform a supervised scan. If the assistant stops midway, do not manually merge uncertain staged material. Reopen it, ask for a summary of staged versus active files, and either approve a complete validated set or discard the staging set. Workspace migrations create configuration backups under `.scout/backups`; see [Upgrades](UPGRADES.md).
