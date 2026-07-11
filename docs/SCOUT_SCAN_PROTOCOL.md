# Scout scan protocol

This is the provider-neutral contract for manual and scheduled scans.

## Coordination and context

Every run declares `agent=codex|claude` and `mode=primary|second-pass`. Acquire the private workspace lock with `scout lock acquire <agent> <mode>`, retain its token, and release it in a final step. Stop without writes when a live lock exists; locks older than two hours may be recovered.

Read `workspace.json`, `profile/context.md`, `profile/calibration.md`, the tracker, source configuration, employer list, commute policy, scan-run log, and today's report. Never copy the private workspace into the public application repository or another external service.

## Search coverage

A primary pass:

- runs configured ATS, Adzuna, and hiring.cafe sources with `scout source <name>`;
- treats missing Adzuna credentials and individual source failures as degraded coverage, not total failure;
- runs varied queries from every configured search lane, respecting each lane's priority and keeper rule;
- checks the least-recently-reviewed configured employers, watch entries, and hidden-opportunity sources;
- verifies each advert is current before reporting it.

A second pass reads the primary run and uses different queries, sources, employers, and watch entries. It verifies and merges rather than replaces. With no successful primary result, it becomes a full primary-equivalent fallback.

## Screening, location, and scoring

Apply the user's explicit hard exclusions first. Missing facts are uncertainty, not positive evidence. Use the scoring dimensions, weights, gates, and action bands in the profile; the breakdown must sum to the total. Change an existing score only for a cited fact or a named newer precedent.

For location-sensitive keepers, use the configured origin, travel modes, time boundary, remote preference, and relocation position. Record practical route evidence, destination, checked date, notes, and URLs. Preserve distant historical entries even when they no longer pass the active filter.

## Tracker and report

Make per-entry edits and preserve user-authored status, notes, contacts, events, and application history. Deduplicate by stable ID, company/role, and source URL. New IDs use `company-role-YYYY-MM`.

Write `reports/YYYY-MM-DD.md` with:

1. `## Headline`
2. `## Action today`
3. `## One check from unlocking`
4. `## Follow-ups due`
5. `## Changes since last scan`
6. `## Discarded`
7. `## Verdicts`

Derive score bands and follow-up intervals from the profile/configuration. When today's report exists, preserve richer verified facts and regenerate action sections from current tracker state. State degraded coverage prominently.

If fresh map or directions verification is blocked, preserve the newest previously audited commute value and its checked date. Mark the commute check degraded; never replace a verified value with a guess or erase it merely because the current provider is unavailable.

Append one JSON object to `data/scan-runs.jsonl` containing timestamp, agent, mode, degradation, checked sources and queries, watch/employer coverage, candidate/keeper counts, discarded reasons, errors, and per-source counts. New runs must also include `source_health`, keyed by stable source name, with `{ "status": "healthy|degraded|unavailable", "count": number|null, "reason": string|null }`. A successful empty response is healthy; blocked or failed endpoints are unavailable; partial query or portal failures are degraded.

Commit only files changed by this scan with `scan: YYYY-MM-DD <agent> <mode>`. Never stage unrelated workspace files. Release the lock even after degraded search or commit failure.
