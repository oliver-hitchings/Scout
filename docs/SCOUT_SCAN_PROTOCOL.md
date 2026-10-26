# Scout scan protocol

This is the provider-neutral contract for manual and scheduled scans.

## Trusted runtime ownership

Every run declares `agent=codex|claude` and `mode=primary|broadened|second-pass`. Scout's trusted runtime owns the fenced workspace lease, source collection, normalisation, deduplication, mandatory gates, score arithmetic, tracker merge, report generation and scan-run record. Installed scans renew the lease while working. Overlapping compatible requests enter the durable queue; expired, stale or blocked work records an explicit reason. Takeover checks lease expiry, process-start identity and the takeover margin before advancing the fencing generation. Elapsed age alone never authorises a second writer. The compatibility `lock` CLI adapter does not replace the installed scan orchestrator.

The provider receives only the assessment-relevant part of the private configuration, bounded profile/CV evidence and selected candidates with capped descriptions. At most 60 candidates enter the selected set; stable batches contain at most ten jobs and may be smaller when the context budget requires it. Each request uses a non-resumable, no-tools turn with focused schema repair and bounded per-job retry. It never invokes Scout, browses independently, writes workspace files, applies for a role or sends outreach. When sources yield zero candidates, Scout skips the provider entirely and still writes a truthful healthy-empty or degraded run.

Start installed scans through Scout or its `scan` CLI command. A provider or skill must not collect and mutate the tracker independently while the runtime owns that work. Git backup follows successful scan finalisation: a missing remote or failed checkpoint does not erase valid tracker/report results, but pending or attention-required backup remains visible in the run outcome.

Interactive tracker changes use the shared workspace mutation authority and fenced lease coordination used by scans. Each browser response includes a tracker revision; a mutation made from a stale page is rejected before writing, the interface refreshes the current tracker and retries once. Successful UI mutations flush a complete temporary file and atomically replace `data/opportunities.json`. This prevents a scan finishing at the same time as a note, status, contact, category, commute or application-stage edit from silently overwriting either side.

Journal appends retain their full hash chain and fencing while avoiding repeated
whole-file replay during an unchanged writer's run. A private in-process cache
checks file identity, size and nanosecond change/modify timestamps plus the
exact last 64 KiB before every warm append. A changed tail or metadata, reopen,
copied handle or failed write forces full validation; caller-supplied events
and head hashes never authorise an append. A known committed prefix cannot be
replaced or truncated. Recovery and inspection continue to validate every
event, and an incomplete final append remains distinct from corrupt complete
JSON. No cache is persisted or trusted after a process restart.

To measure append cost on a disposable development host, run
`node ui/lib/fixtures/run-journal-append.mjs 500 2500`. It uses genuine fenced
leases, synthetic assessment records and temporary workspaces, then reports
wall/CPU time, journal bytes read and full-validation read counts. It never
opens the configured private workspace. Repeat this on the maintained host
only through its operator-approved development path; local timings do not
establish live-host performance.

## Published search-profile boundary

Ranked discovery uses only a reviewed, immutable published search profile. Raw setup answers and an editable draft are evidence for review; they do not become scan rules until publication. Scout stages that draft during workspace startup, setup review or scan readiness once the legacy preferences and profile evidence exist. An established beta workspace with tracked opportunities may temporarily remain on the explicitly marked legacy discovery path, but a fresh workspace cannot scan until its staged draft is reviewed and published. Explicit or confirmed rules can exclude a vacancy; unconfirmed inferred rules remain non-blocking even if their draft strength says `mandatory`. Multiple mandatory accepted values for one field are alternatives: matching any one satisfies that field. Unknown source facts remain unknown and follow the published profile's configured policy (`include`, `penalise`, or `exclude`).

Before ranked-discovery profile migration changes the workspace, Scout creates
and verifies one beta.22-compatible snapshot under `.scout/backups/`. It
contains the beta.22 private workspace boundaries, including credentials,
tracker, reports, applications, chats, imports, logs and encrypted
`.scout-backup` recovery data, but excludes fenced runtime state and
ranked-profile artifacts. Profile publication reconstructs
the bounded identities of historical tracker and scan-review vacancies,
filters and re-ranks them under the new published profile, and writes an
immutable profile-specific artifact under `profile/search/rankings/`. It does
not edit an old score, status, note, contact, event, report or assessment.
Historical profile or scoring inputs that cannot be reconstructed exactly are
labelled `legacy-unreconstructable`; a rejected vacancy that resurfaces is
re-ranked and may be assessed once under the published profile. Its new
profile-bound decision then prevents unchanged repeats from consuming later
assessment capacity.

## Candidate selection, liveness and cost

When a published profile is available, before the provider is asked for detailed assessment, the trusted runtime:

1. **Selects traceable search lanes.** The immutable published profile generates a bounded lane plan without a cross-product. Capacity rotates fairly across core, relevant and exploration bands; the exact selected lane/query contract is retained with collection evidence.
2. **Normalises and deduplicates every returned record.** Source order does not affect the canonical vacancy set. A URL-less vacancy uses a coarse company/title semantic base ID that does not change when provider coverage or optional metadata changes. Complete provider references disambiguate same-scan collisions and distinguish separate openings during lifecycle and novelty matching, while cross-source copies reconcile through semantic and reference evidence. Source/portal errors are counted separately from returned records that fail normalisation, so neither kind of failure can create a negative observation count. A record and its canonical vacancy retain every matching lane ID.
3. **Applies confirmed rules, then ranks the complete eligible pool.** Every successfully normalised unique vacancy is evaluated before the 60-candidate cutoff. Both tracker history and bounded durable reviewed decisions count as seen for novelty and lane `new` accounting. Strong preferences and unknown-value policies influence ranking without becoming unconfirmed hard exclusions. Deterministic discard totals count unique vacancies while the audit retains every matched-rule explanation.
4. **Selects a bounded assessment set above a relevance threshold.** The runtime uses the configured check score as the pre-assessment relevance threshold; a positive profile-boundary fallback prevents zero-score unrelated vacancies from padding direct ranked-discovery calls. Score comes first; soft employer, source, lane, role-family and location limits prevent one cohort from consuming the set when strong alternatives exist. The selection is deterministic for the same observations, profile and run configuration. An advert whose latest assessed decision is a rejection and whose content, profile and learning version are unchanged does not use assessment capacity again: the runtime remembers up to 4,096 such rejections from the whole run log (not only the recent assessed history), so a long-running advert is assessed once until it changes.
5. **Confirms each selected advert is still open.** A `HEAD` request, then a `GET`, classifies each advert as `live`, `gone` or `unverified` under bounded concurrency, a per-host delay and an overall time budget. `gone` means a 404 or 410, a redirect to the board's generic index, or wording such as "no longer accepting applications". Timeouts, DNS failures, blocks, 429s and 5xx remain `unverified` and the candidate is kept, so an offline host can never mass-close a tracker. Closed adverts are counted as `advert_closed` and the next eligible ranked vacancy may backfill the selection.

Only grandfathered established workspaces without a published profile retain the legacy candidate path temporarily. The dashboard shows **Earlier search settings are active** and links to **Settings → Search & profile** for review and publication. Its run record is marked `legacy-discovery`; it does not claim ranked full-pool coverage. Publishing clears the disclosure and makes the reviewed profile authoritative for later scans.

A `second-pass` run is a verification pass, not a repeat of discovery. It re-examines the roles today's primary scan kept, plus those close enough to the threshold that a second opinion could change the outcome, rather than re-scoring every candidate. When there is nothing from today to verify it falls back to the full set, so a standalone second-pass run still does useful work.

Each ranked vacancy is compared with its earlier decision for the same underlying job (shared URL, provider reference or employer and title evidence), and its explanation records one `lifecycle` change and reason. Every existing vacancy is revalidated against the current advert; the reason decides what happens next:

| Reason | When | Re-ranked | Assessed |
| --- | --- | --- | --- |
| `new-vacancy` | No earlier decision | Yes | Yes |
| `reopened-vacancy` | The earlier advert was closed and is open again | Yes | Yes |
| `material-change` | The advert content fingerprint differs (wording-only edits are `minor` and do not count) | Yes | Yes |
| `profile-change`, `legacy-profile-rerank` | The earlier decision used a different or no published profile | Yes | Yes |
| `scoring-change` | The learning version differs from the one recorded with the decision | Yes | Only if the earlier outcome was not a rejection |
| `assessment-change` | The assessment prompt, schema, provider or model recorded with the earlier decision differs from this scan's | Only with a scoring change | Yes. An earlier rejection is re-assessed only within the per-scan limit below |
| `assessment-change-deferred` | As `assessment-change`, for an earlier rejection beyond the per-scan limit | No | No: skipped until a later scan |
| `unchanged-rejection` | Same advert, profile and learning version, and the earlier outcome was `rejected`, `ignore`, `below_threshold`, `provider_discarded`, `mandatory_unmet` or `hard_exclusion` | No | No: skipped, and the capacity is backfilled by the next ranked vacancy |
| `unchanged-prior-assessment` | Same advert, profile and learning version; earlier outcome was not a rejection | No | Yes |

Each scan that assesses vacancies records its assessment version (prompt, schema, provider and model) in its run record. When the version differs, earlier rejections are re-assessed in the background: at most 6 per scan, the highest-ranked first, so a prompt or model change cannot use up assessment capacity. The rest are reported as `assessment-change-deferred` and are picked up by later scans. A rejection recorded before versions were stored has nothing to compare and is not re-assessed for this reason; it is assessed again when its advert, the profile or the learning version changes.

Persisted rejection outcomes use underscores (`below_threshold`,
`provider_discarded`, `mandatory_unmet`, `hard_exclusion`); readers accept their
hyphenated equivalents too. Lifecycle and public explanation reasons retain
their hyphenated vocabulary. An unassessed `below-relevance-threshold` decision
is not an assessed rejection and cannot suppress a later assessment.

Recent decision history is bounded to 512 records. When both kinds of evidence
are plentiful, 384 places hold assessed decisions and 128 hold pre-assessment
decisions; unused places are backfilled. The separate rejection reader retains
up to 4,096 latest assessed rejections, including their assessment versions, so
crossing that 384-record mixed-history horizon does not lose rejection memory
or prevent version-triggered reassessment. These are bounded policies, not an
unlimited historical search.

Soft diversity caps apply whenever at least two groups exist in a dimension,
including small pools. Caps use the smaller of the assessment budget and the
eligible pool. Scout tries diversity first, then relaxes lane, source,
role-family, location and employer limits in that order only when no permitted
candidate remains. The recorded `constraintsRelaxed` explains each relaxation.
Every above-threshold vacancy in a small pool can therefore fill spare capacity;
diversity never creates a guarantee for a below-threshold vacancy.

Duplicate grouping and durable ID reconciliation use shared URL, provider
reference and employer/title-token indexes before the unchanged complete
identity predicate. They preserve first-compatible-group order and all-member
agreement, rather than treating a chain of partial matches as one vacancy.
The synthetic scale fixture can be rerun on a disposable development host with
`node ui/lib/fixtures/canonical-scale.mjs 2500` or `10000`; it prints timings and
whether reversed input plus prior identities produces the same result. These
measurements do not establish live-host performance.
The 5,000-vacancy regression calibrates process CPU against 1,000 vacancies on
that same runner. A fivefold input increase has a fifteenfold calibrated CPU
ceiling (with a two-second noise floor), plus a 30-second total wall deadline.
Both passes include durable reconciliation. This measures growth across the
supported native CPUs rather than assuming identical hardware speed. The
original quadratic implementation must still fail this regression; changes to
this budget require explicit RED/GREEN evidence.

## Search coverage and health

Scout runs configured ATS, Adzuna and hiring.cafe sources. Missing optional configuration is reported as not configured. A successful empty response is healthy; partial query/portal failure is degraded; a blocked or failed configured source is unavailable. Sources may omit, delay, duplicate or ambiguously format salary, location, working pattern and advert status; Scout preserves that uncertainty instead of guessing. Hiring.cafe retryable network/HTTP failures receive at most three bounded attempts, and Scout refreshes its build ID once after a 404 or endpoint-shape change.

Only healthy completed coverage enables scheduling. A degraded run states that its results are not evidence that no suitable roles exist.

Every ranked run keeps one stage explanation for every unique vacancy, including vacancies rejected before ranking and ranked vacancies that did not enter detailed assessment. The explanation records whether the vacancy was found, ranked, selected, deterministically excluded and assessed; its three strongest positive and negative score contributions, each with its score, ranking dimension and a one-line evidence note (for example `title` 1, `matched: Data Analyst`), so a report can say why the vacancy ranked where it did; and one stable reason such as `below-relevance-threshold`, `diversity-limit`, `assessment-capacity`, `exploration-replacement`, `advert-closed`, `verification-scope` or a lifecycle skip. Multiple confirmed rules may exclude one vacancy, so the vacancy remains one funnel item while retaining every matched exclusion code.

The total funnel and every configured-source funnel reconcile exactly across returned, failed, normalised, duplicate, unique, excluded, eligible, ranked, above-threshold, selected, assessed and assessment-failed counts. Scout retains the configured collection-source identity separately from a vacancy vendor so an ATS record cannot be attributed to another source merely because the vendor label differs. Coverage rollups show the same vacancy stages by source, employer, lane, role family, location, provider, run and date, plus bounded failure-reason counts. The latest-scan dialog exposes source coverage and explains why a promising role missed detailed assessment. Keeper results distinguish added, updated and unchanged persisted job content. Verification dates and ranking history still advance for an unchanged keeper; these metadata refreshes do not count as an updated opportunity. Public queue views label a scheduled discovery truthfully even when a historical durable request retains `manual-discovery` as its compatibility purpose; request identity and deduplication do not change.

For each selected search lane, the final fenced mutation also reconciles exact
query returns, valid parsed records, exact unseen vacancies, deterministic
eligibility, detailed-assessment selection and promising kept/check outcomes.
The tracker, report, run log and lane plan therefore recover together after an
interruption. Failed runs record bounded failure evidence and never advance
the repeated-unproductive counter. Retirement remains an explicit user action
after three completed unproductive runs, and restoration preserves history.

If a supervised first/manual primary scan keeps no candidates, Scout automatically performs one broader discovery pass. It adds adjacent role aliases and broader role/sector/location query combinations, and removes the source-level location restriction where supported. It does not change the approved minimum salary, hard exclusions, published location rules, mandatory evidence or score gates. Commute preferences guide assessment context and dashboard filtering; they are not a ranked-discovery filter. Scheduled scans and explicit second passes do not recursively broaden.

Manual operations show phase, elapsed time and an approximate remaining range. The range comes from up to ten healthy, non-skipped runs using the same provider and mode; without history Scout displays a conservative 5-10 minute range. An overrun remains visibly active rather than becoming a false zero countdown.

## Mandatory requirements and scoring

Scout applies configured hard exclusions before keeping a result. Employer language such as `required`, `essential`, `must`, `mandatory` and `non-negotiable` receives stable advert-evidence IDs that the provider must assess.

- A hard exclusion or confirmed unmet mandatory requirement discards the candidate.
- An unknown mandatory requirement can appear only in **One check from unlocking** and is capped below the action threshold.
- **Action today** requires advert evidence and supporting profile evidence for every mandatory requirement.

Scout owns score dimensions, arithmetic, relevance thresholds, bands, categories and deterministic exclusions. The provider-neutral assessment schema accepts only responsibility fit, mandatory-requirement evidence, transferable experience, uncertainties, evidence-backed strengths and concerns, and a `keep`, `check` or `discard` recommendation. It cannot supply a numeric score, category or hard exclusion. Each committed assessment records provider, model, prompt, assessment-schema, profile and pipeline provenance; a provenance change restarts only incompatible assessment work. New tracker entries may store backward-compatible `eligibility` and `mandatoryRequirements` evidence. Existing status, tags, sources, notes, contacts, logs and application history are preserved.

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

It appends one canonical schema-version-5 JSON object to `data/scan-runs.jsonl` containing timestamp/start time, agent, mode, `degraded`, `sources_checked`, `queries_checked`, candidate/keeper counts, discarded reasons, errors, `source_health` and a bounded `reviewed` audit. Ranked runs also record the profile ID, discovery engine, mathematically reconciled total/per-source funnel, selection summary, complete bounded per-vacancy explanations and coverage rollups. Reviewed assessments and pre-assessment explanations both contribute bounded durable decision history, so recurring deterministic exclusions and unselected vacancies are not counted as newly discovered on every run. Scan-health presents these as **Source records returned**, **Unique vacancies after deduplication**, **Excluded by confirmed rules**, **Eligible and ranked**, **Selected for detailed assessment**, **Successfully assessed**, and **Assessment failed**. It never implies that every discovered vacancy received a detailed provider assessment. Audit entries contain only bounded company, role, dimensions, canonical source link and provider-reference identities, stage flags, deterministic score contributions, reason codes and assessment outcomes; they never contain prompts, profile evidence, provider transcripts, raw observation caches, URL query/fragment data or full advert descriptions. A run fails closed rather than silently truncating an audit above the 10,000-vacancy artifact capacity. Readers remain compatible with older records and beta.9 aliases including nested `degradation`, `checked_sources`, `candidate_count`, `keeper_count` and `discarded_reasons`.

Ranked discovery retains employers from selected canonical adverts as
normal-priority review evidence and can monitor explicitly reviewed public
careers sources. Job feedback is a separate versioned event and cannot change
ranking itself. Only an explicitly reviewed learned-preference proposal enters
the deterministic rank compatibility fingerprint. Its bounded contribution is
shown separately from base profile evidence; confirmed exact rule
reconsideration retains the original exclusion evidence. Undo appends a new
version restoring the prior published behavior, while historical decisions
retain their original profile and learning versions.

Multiple runs on the same date are combined into one report with separate provider/mode summaries; the later run never erases the earlier run's presence. Before reporting success, Scout reads back and validates the tracker, required report sections and the matching final run record. The lock is released after completed, healthy-empty, degraded or failed runs.
