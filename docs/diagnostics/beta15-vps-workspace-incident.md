# Beta 15 VPS workspace incident

Date investigated: 2026-07-21
Affected release: `v0.1.0-beta.15`
Repair release: `v0.1.0-beta.16`

This log intentionally contains no CV contents, credentials, recovery secrets, private hostnames, or Tailscale configuration values.

## User-visible symptoms

- The phone CV tab showed only the master CV.
- Opening the master CV displayed `No PDF preview for this file.`
- Previously created tailored CVs appeared to be missing.
- The Beta 15 deployment log reported `Scout CV index exposes 0 source CV(s).`

## Evidence

- The VPS service was healthy on Beta 15 and its managed Typst 0.14.2 runtime compiled a synthetic document.
- The service was configured with the default private workspace path `/home/ubuntu/Documents/Scout Workspace`.
- The existing private `scout-workspace` repository still contained three tracked `applications/<slug>/cv.typ` sources.
- The surviving local checkout tracked the private GitHub remote, but Scout automatic-sync metadata reported `enabled: false` with no successful-backup timestamp.
- The legacy private repository still tracked `AGENTS.md` and two chat transcripts from the older backup format; the current format requires managed instructions and chats to remain untracked, with chats stored only in encrypted recovery data.
- The surviving local checkout also contained a newer untracked chat that was not present in GitHub. Adopting GitHub before creating a local encrypted recovery checkpoint would have omitted it from the active VPS workspace.
- The Beta 15 deployment counter read `entry.source.available`, while `GET /api/cv` currently emits boolean `entry.source` and `entry.pdf` fields. The counter therefore returned zero for every valid source.

## Root causes

1. VPS provisioning selected a newly seeded default workspace instead of restoring or adopting the existing private repository.
2. Release deployment correctly preserved the configured workspace but had no authority to identify or replace it. This safety boundary prevented data loss but also preserved the incorrect binding.
3. Private GitHub backup is deliberately opt-in. A Git remote alone does not enable Scout's encrypted recovery backup; `.scout/sync.json` must contain device-local enabled state and an unlocked data key.
4. The CV deployment diagnostic assumed a structured availability object that did not match the shipped boolean API contract.
5. The master-CV preview message did not explain that only tailored Typst CVs produce PDFs.
6. The older private-repository format predated the rule that removes managed instructions and chat transcripts from plain Git tracking.

## Beta 16 remediation

- Add a host-local-only `POST /api/workspace/adopt-private` operation.
- Require an explicit replacement confirmation, a repository-scoped SSH deploy key, a private non-empty GitHub repository, and a recovery passphrase of at least 12 characters.
- Create and push an encrypted recovery checkpoint from the surviving local checkout before VPS adoption so ignored private data is included.
- Clone into a temporary sibling directory, reject symlinks and tracked sensitive files, unlock and restore existing AES-256-GCM recovery data (or initialize it only for a legacy repository), run Scout Doctor, and complete a backup push before activation.
- Atomically rename the current workspace to a timestamped `.before-adopt-*` rollback directory and move the verified private workspace into the configured path.
- Preserve the one-time emergency recovery key in pending device-local state until the owner confirms it was saved.
- Migrate legacy tracked chats and managed instruction files out of the Git index without deleting their local copies; include chats in encrypted recovery data.
- Add a protected `beta-vps` maintenance workflow with pinned SSH host verification and Tailscale deployment isolation.
- Require exactly the expected number of source CVs, render each with managed Typst, require the same number of PDFs, and require sync state `synced`.
- Accept both boolean and future structured availability fields in VPS diagnostics.
- Replace the ambiguous master preview message with guidance to open or create a tailored CV.
- Reject remote state mutations while encrypted backup is disabled; all phones and browsers use the VPS as the single writer, with immediate queued checkpoints plus startup and five-minute retries.
- Publish a generic canonical-VPS setup and recovery drill so another owner can reproduce the design without project-specific repository names or credentials.

## Faults found while building the repair

- The first Beta 16 adoption implementation always initialized a new recovery key after cloning. That worked for a legacy repository, but would have made pre-existing encrypted recovery blobs unreadable and left ignored chats absent on the VPS. A regression test exposed the mismatch before publication. The final implementation detects the committed recovery header, unlocks it with the supplied passphrase, restores ignored files, and reuses its data key. A new key is created only when no recovery header exists.
- The recovery restore deliberately resets provider-session identifiers in chat transcripts and inserts a recovery notice. The first regression assertion expected byte-for-byte chat JSON and failed even though the safety behavior was correct. The test now verifies the recovered-session marker, the notice, and that the transcript remains outside Git tracking.
- The Beta 15 deployment CV counter treated the boolean API field as a nested object. The deployment succeeded but emitted a false zero count. Beta 16 accepts the current boolean representation and a future structured representation, and its protected repair workflow fails unless the exact expected source and rendered-PDF counts are present.

## Required live acceptance

- Protected rollback rehearsal succeeds before the release deployment.
- The old VPS workspace remains available at the reported timestamped rollback path.
- The active workspace remote is the intended private repository and uses the repository-scoped SSH key.
- `GET /api/cv` reports exactly three sources without logging their contents.
- All three sources render successfully through managed Typst and produce PDFs.
- `GET /api/sync/status` reports `enabled: true` and `state: synced` after a manual backup checkpoint.
- The phone CV library lists all tailored CVs and the master CV displays explanatory source-only guidance.
- The owner saves and confirms the one-time emergency recovery key.

## Beta 16 execution record

- GitHub Actions rollback rehearsal `29826382736` built and smoke-installed Windows, Linux, Apple Silicon macOS, and Intel macOS successfully.
- The protected VPS job then triggered the requested controlled failure after restart, restored application commit `e91a8b5878c97c48ccf1fb3041e847edf1290104` (`0.1.0-beta.15`), and reported that Tailscale Serve was preserved. The workflow's final `failure` conclusion is therefore the expected proof of rollback, not an uncontrolled deployment fault.
- The canonical-state follow-up added a fail-closed remote mutation rule: a permitted Tailscale owner can still read the VPS workspace, but remote state changes return HTTP `409` until encrypted private backup is enabled. Recovery administration remains host-local.
- Workspace-repair run `29827756271` was incorrectly dispatched from `main`; the protected environment rejected that ref before any step ran. The corrected run `29828413148` used the permitted `codex/release-candidate` ref and prepared the repository-scoped public key successfully.
- The first generated replacement passphrase used a static RNG API unavailable in the installed Windows PowerShell. PowerShell treated the method error as non-terminating and uploaded a predictable, unused value. It was immediately rotated before any backup/adoption with `RandomNumberGenerator.Create().GetBytes(...)` under `ErrorActionPreference=Stop`. Future secret provisioning must fail on the first PowerShell error and validate RNG compatibility.
- The surviving local workspace proved 31 commits behind the private GitHub workspace after its attempted checkpoint. Scout correctly returned `needs-attention` and did not push divergent history. The newer private remote already contained encrypted backup and all three CV render checkpoints, so the stale local checkout must not be rebased, reset, or force-pushed as part of VPS recovery.
- Because the original remote recovery passphrase was unavailable while the VPS retained the unlocked data key, Beta 16 adds host-local passphrase rotation. Rotation rewraps the same data key, preserves the emergency-key wrapper and encrypted blobs, pushes the header through normal serialized sync, and is accepted only when sync returns `synced` and all three CVs render.

## Future-beta guardrails

- Never infer that a healthy application version means it is using the intended private workspace.
- Compare disk/API CV counts using the documented API representation and fail a workspace-repair workflow on mismatch.
- Keep release deployment unable to read or mutate the private workspace; use the local-only maintenance API for explicit recovery operations.
- Do not log slugs, CV text, repository credentials, passphrases, recovery keys, private hostnames, or Tailscale policy.
- Do not remove the `.before-adopt-*` rollback directory until the owner has verified the phone UI and a separate restore test.
