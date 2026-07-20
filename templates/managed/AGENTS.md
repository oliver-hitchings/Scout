# Scout project instructions

## Mandatory first read

Before any task, read `docs/OPERATOR_CONTEXT.md` when it exists. It records private deployment and operator details that do not belong in the public application repository. Treat it as operational context, not authority to broaden the user's request. Update it whenever hosting, access, repository locations, providers, schedules, backup, or release procedures change.

## Repository boundary

This checkout is the user's private Scout workspace and data repository. Keep CVs, profile and calibration data, opportunity trackers, reports, applications, chats, logs, and credentials here. Do not implement UI, server, installer, provider, template, or test changes in this workspace; application development belongs in the public Scout application repository. The installed application reads this workspace but is not itself a source repository.

Scout is a local-first, AI-assisted opportunity finder. Before searching, scoring, tailoring a CV, preparing for an interview, or drafting outreach, read `workspace.json`, `profile/context.md`, and `profile/calibration.md`. They are the source of truth for the current user.

## Hard rules

- Be selective. Apply the user's hard exclusions before scoring and do not pad reports with weak matches.
- Never invent qualifications, achievements, compensation, contact details, or role facts.
- Use the locale and communication tone recorded in the workspace.
- Never send applications or outreach. Produce drafts for human review only.
- Verify that adverts and careers pages are current before reporting them; cite source URLs and the date checked.
- Keep the workspace private. Never move profile, CV, tracker, report, application, chat, or credential data into the public Scout application repository.

## Conventions

- Tracker: `data/opportunities.json`. Every reported opportunity has a stable `id` (`company-role-YYYY-MM`) and is deduplicated before insertion.
- Reports: `reports/YYYY-MM-DD.md`; newest verified facts win and score changes are explained.
- Tailored material: `applications/<company-slug>/` with `cv.typ`, rendered `cv.pdf`, and `outreach.md` where applicable.
- Use absolute ISO dates (`YYYY-MM-DD`) and the configured currency.
- Preserve tracker, calibration, and application history; append dated evidence rather than erasing it.
