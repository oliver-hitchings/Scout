# Scout scan protocol

This is the provider-neutral contract for manual and scheduled scans.

## Trusted runtime ownership

Every run declares `agent=codex|claude` and `mode=primary|second-pass`. Scout's trusted runtime owns the private workspace lock, source collection, normalisation, deduplication, mandatory gates, score arithmetic, tracker merge, report generation and scan-run record. A live lock stops an overlapping run; stale locks older than two hours may be recovered.

The provider receives only the private scoring configuration, bounded profile/CV evidence and at most 40 normalised candidates with capped descriptions. It returns schema-constrained assessments from one non-resumable, no-tools turn. It never invokes Scout, browses independently, writes workspace files, applies for a role or sends outreach. When sources yield zero candidates, Scout skips the provider entirely and still writes a truthful healthy-empty or degraded run.

Direct developer workflows may inspect or commit workspace changes separately. Git is not part of installed scan health: missing Git, a non-Git workspace or a commit failure cannot make otherwise valid scan artifacts unhealthy.

## Search coverage and health

Scout runs configured ATS, Adzuna and hiring.cafe sources. Missing optional configuration is reported as not configured. A successful empty response is healthy; partial query/portal failure is degraded; a blocked or failed configured source is unavailable. Hiring.cafe retryable network/HTTP failures receive at most three bounded attempts, and Scout refreshes its build ID once after a 404 or endpoint-shape change.

Only healthy completed coverage enables scheduling. A degraded run states that its results are not evidence that no suitable roles exist.

## Mandatory requirements and scoring

Scout applies configured hard exclusions before keeping a result. Employer language such as `required`, `essential`, `must`, `mandatory` and `non-negotiable` receives stable advert-evidence IDs that the provider must assess.

- A hard exclusion or confirmed unmet mandatory requirement discards the candidate.
- An unknown mandatory requirement can appear only in **One check from unlocking** and is capped below the action threshold.
- **Action today** requires advert evidence and supporting profile evidence for every mandatory requirement.

Scout recomputes dimension totals, scores and bands; provider totals are never trusted directly. New tracker entries may store backward-compatible `eligibility` and `mandatoryRequirements` evidence. Existing status, tags, sources, notes, contacts, logs and application history are preserved.

## Runtime artifacts

Scout writes `reports/YYYY-MM-DD.md` with:

1. `## Headline`
2. `## Action today`
3. `## One check from unlocking`
4. `## Follow-ups due`
5. `## Changes since last scan`
6. `## Discarded`
7. `## Verdicts`

It appends one canonical JSON object to `data/scan-runs.jsonl` containing `schemaVersion`, timestamp/start time, agent, mode, `degraded`, `sources_checked`, `queries_checked`, candidate/keeper counts, discarded reasons, errors and `source_health`. Readers remain compatible with beta.9 aliases including nested `degradation`, `checked_sources`, `candidate_count`, `keeper_count` and `discarded_reasons`.

Before reporting success, Scout reads back and validates the tracker, all seven report sections and the matching final run record. The lock is released after completed, healthy-empty, degraded or failed runs.
