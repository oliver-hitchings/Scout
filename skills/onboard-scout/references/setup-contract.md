# Scout onboarding contract

## Required before activation

- A valid schema-versioned `workspace.json`.
- User-confirmed name or preferred identifier, locale, currency, and timezone.
- At least one desired role family and location/remote preference.
- Compensation preference, explicitly allowing `unknown` when the user has none.
- Hard exclusions and positive priorities.
- An evidence-only master CV. Unknown or incomplete facts remain marked as gaps.
- At least one installed and authenticated AI provider.
- A readable `data/opportunities.json`, which may begin empty.

## Review boundary

Stage changes first. Before activation, show the user the imported facts, unresolved questions, search/scoring rules, sensitive local files, and whether Adzuna and scheduling are enabled. Do not display secrets. Do not activate a schedule until `scout doctor` passes and a supervised scan succeeds.

After explicit approval and successful activation, write `.scout/onboarding/activated.json` containing only the activation timestamp and provider. Scout uses this local marker to distinguish an approved fresh setup from incomplete seeded files.

## Retuning

Base tuning on explicit reactions and outcomes. Append dated calibration precedents, explain which future scores they affect, and preserve previous history.
