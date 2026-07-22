# Scout scan protocol

This is the provider-neutral contract for manual and scheduled scans.

## Trusted runtime ownership

Every run declares `agent=codex|claude` and `mode=primary|broadened|second-pass`. Scout's trusted runtime owns the private workspace lock, source collection, normalisation, deduplication, mandatory gates, score arithmetic, tracker merge, report generation and scan-run record. A live lock stops an overlapping run; the blocked run is recorded as skipped instead of running concurrently. Stale locks older than two hours may be recovered.

The provider receives only the private scoring configuration, bounded profile/CV evidence and at most 40 normalised candidates with capped descriptions. It returns schema-constrained assessments from one non-resumable, no-tools turn. It never invokes Scout, browses independently, writes workspace files, applies for a role or sends outreach. When sources yield zero candidates, Scout skips the provider entirely and still writes a truthful healthy-empty or degraded run.

Direct developer workflows may inspect or commit workspace changes separately. Git is not part of installed scan health: missing Git, a non-Git workspace or a commit failure cannot make otherwise valid scan artifacts unhealthy.

Interactive tracker changes use the same workspace lock as scans. Each browser response includes a tracker revision; a mutation made from a stale page is rejected before writing, the interface refreshes the current tracker and retries once. Successful UI mutations flush a complete temporary file and atomically replace `data/opportunities.json`. This prevents a scan finishing at the same time as a note, status, contact, category, commute or application-stage edit from silently overwriting either side.

## Search coverage and health

Scout runs configured ATS, Adzuna and hiring.cafe sources. Missing optional configuration is reported as not configured. A successful empty response is healthy; partial query/portal failure is degraded; a blocked or failed configured source is unavailable. Hiring.cafe retryable network/HTTP failures receive at most three bounded attempts, and Scout refreshes its build ID once after a 404 or endpoint-shape change.

Only healthy completed coverage enables scheduling. A degraded run states that its results are not evidence that no suitable roles exist.

If a supervised first/manual primary scan keeps no candidates, Scout automatically performs one broader discovery pass. It adds adjacent role aliases and broader role/sector/location query combinations, and removes the source-level location restriction where supported. It does not change the approved minimum salary, hard exclusions, location/commute policy, mandatory evidence or score gates. Scheduled scans and explicit second passes do not recursively broaden.

Manual operations show phase, elapsed time and an approximate remaining range. The range comes from up to ten healthy, non-skipped runs using the same provider and mode; without history Scout displays a conservative 5–10 minute range. An overrun remains visibly active rather than becoming a false zero countdown.

## Mandatory requirements and scoring

Scout applies configured hard exclusions before keeping a result. Employer language such as `required`, `essential`, `must`, `mandatory` and `non-negotiable` receives stable advert-evidence IDs that the provider must assess.

- A hard exclusion or confirmed unmet mandatory requirement discards the candidate.
- An unknown mandatory requirement can appear only in **One check from unlocking** and is capped below the action threshold.
- **Action today** requires advert evidence and supporting profile evidence for every mandatory requirement.

Scout recomputes dimension totals, scores and bands; provider totals are never trusted directly. New tracker entries may store backward-compatible `eligibility` and `mandatoryRequirements` evidence. Existing status, tags, sources, notes, contacts, logs and application history are preserved.

## Runtime artifacts

Scout writes `reports/YYYY-MM-DD.md` with:

1. `## Headline`
2. `## Scan runs`
3. `## Action today`
4. `## One check from unlocking`
5. `## Follow-ups due`
6. `## Changes since last scan`
7. `## Discarded`
8. `## Verdicts`

It appends one canonical schema-version-3 JSON object to `data/scan-runs.jsonl` containing timestamp/start time, agent, mode, `degraded`, `sources_checked`, `queries_checked`, candidate/keeper counts, discarded reasons, errors, `source_health` and a bounded `reviewed` audit. Audit entries contain only company, role, source link, category, outcome, score and up to three concise reasons; they never contain prompts, profile evidence, provider transcripts or full advert descriptions. Readers remain compatible with older records and beta.9 aliases including nested `degradation`, `checked_sources`, `candidate_count`, `keeper_count` and `discarded_reasons`.

Multiple runs on the same date are combined into one report with separate provider/mode summaries; the later run never erases the earlier run's presence. Before reporting success, Scout reads back and validates the tracker, required report sections and the matching final run record. The lock is released after completed, healthy-empty, degraded or failed runs.
