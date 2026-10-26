# Upgrades and Workspace Migrations

Scout application versions and workspace schema versions are separate. Installer upgrades replace application files and managed instructions; they must not delete the private workspace, its credentials or Git history.

Installed application files remain read-only. Scout refreshes its managed
instruction copies inside the private workspace with owner write permission,
including copies made read-only by an older package. Scans and upgrades can
refresh these copies without changing the installed application's permissions.

The installer currently exposes the UI through shortcuts but does not add
`scout` to `PATH`. Installer users can run diagnostics through the UI or use the
explicit bundled CLI invocation in [Quick Start](QUICK_START.md).

## Before upgrading

1. Finish or stop active scans and remove/disable the schedule if the release notes require it. Stop every older Scout process before a release first activates the fenced scan lease.
2. Back up the complete private workspace, including hidden `.git` and `.scout` directories.
3. Record the installed Scout version and run `scout doctor`.
4. Read release notes for schema, provider and source changes.

Scout checks the official GitHub releases once a day and shows an in-app notice
when a newer version is available. In **Settings -> Application updates**, the
default is notification-only. You may opt in to automatic package downloads;
Scout accepts only the package for the current platform and verifies it against
the release `checksums.txt` SHA-256 value before storing it in device-local state.
Installation always remains an explicit user action, so Windows elevation,
macOS Gatekeeper and Linux package-manager prompts are never hidden.

On Windows, choose **Quit Scout** from the notification-area menu before running the new installer. Install the newer release over the existing application (Windows installer, replacement macOS app, or Linux package), then run:

```powershell
scout doctor --workspace "$HOME/Documents/Scout Workspace"
```

Scout validates `workspace.json`. Versioned migrations are designed to be safe to rerun and save the pre-migration configuration under `.scout/backups/`. Scout refuses a workspace schema newer than the application understands; upgrade the application rather than manually lowering `schemaVersion`.

The ranked-discovery migration also creates one verified
`0.1.0-beta.22`-compatible workspace snapshot before staging or publishing the
new profile. This is a compatibility-data snapshot rather than the older
configuration-only JSON backup or a complete workspace/Git backup. It preserves
the allowlisted private career data and credentials needed by beta.22, while
omitting `.git`, `.scout` operational state (including backup connection
settings), post-beta.22 profile/fenced runtime state, and unlisted workspace-root
content. It records a per-file SHA-256 manifest. The migration is idempotent and
reuses an existing verified compatibility snapshot only when its manifest
proves exact equivalence for every protected live path. If tracker, report, CV,
configuration or another protected file changed, Scout creates a new
current-state snapshot before migration.

Fenced scan-lease activation changes the execution contract used by current
Scout. Current Scout rejects a conflicting legacy lock after activation, but
older binaries do not understand the new lease and cannot be prevented from
writing by that check. Stop every older process and disable its schedules before
the first new scan. Restoring only an older executable is not a safe rollback;
use a separately materialised compatible snapshot with all other processes stopped.

VPS source checkouts continue to use the protected release workflow described in
[VPS installation](INSTALL_VPS.md). It refuses dirty or unexpected checkouts,
runs the complete tests, rolls back a failed health check, and preserves the
separate workspace, provider credentials and existing Tailscale Serve mapping.

## Regional settings when fields are missing

Existing explicit regional settings are preserved: a workspace with locale
`en-GB`, currency `GBP`, timezone `Europe/London` and Adzuna country `gb` keeps
those choices. Only missing keys receive the neutral defaults `en`, `USD`,
`UTC` and country `null`. Scout does not infer a country from the machine or
silently restore a UK default. Check **Settings → Search & profile** after an
upgrade if an older workspace omitted any of these fields; review and save the
language, currency, time zone and optional source country you actually want.
Reading a current-schema workspace fills missing defaults in memory without
rewriting its file. An older-schema migration saves the original configuration
before persisting the filled defaults.

## Legacy/private checkout migration

The migration command seeds the current schema, overlays the legacy private content,
then performs a byte-for-byte parity check for every migrated file before making its
first private Git commit. Keep the legacy checkout private and unchanged until you
have also inspected the reported file count and opened the migrated tracker, CV and
a representative application. Use different source and destination paths:

```powershell
scout workspace migrate --from 'C:\path\to\legacy' --to 'D:\Private\Scout Workspace'
```

A corrected command should preserve the legacy workspace content, infer only
documented configuration, initialise private Git history and attempt an initial
commit. The commit can fail when Git identity is not configured, so inspect the
command result and `git status`. The source must remain in place. Compare tracker,
CV, reports and applications before switching launchers. Migration does not make
a public repository safe: old mixed Git history must remain private.

## Rollback and uninstall

If an upgrade fails, stop Scout, preserve the failed workspace and logs, and
restore only a version and workspace snapshot that are mutually compatible.
After fenced-lease activation, do not restart an older Scout binary against
that workspace: the old binary cannot honour the current fencing protocol.
Current Scout can reject a legacy lock, but cannot make an older binary safe.
Restore a copied pre-activation snapshot only when a reviewed rollback requires
it. Do not overwrite newer workspace history casually.

To rehearse or perform a reviewed beta.22 rollback, materialise the verified
snapshot into a new, absent directory:

```powershell
scout workspace rollback-beta22 --workspace 'D:\Private\Scout Workspace' --to 'D:\Private\Scout beta22 rollback'
```

Scout validates every manifest entry before creating the destination, copies
into a temporary sibling, verifies the completed copy, and then renames it
into place. It refuses the live workspace and any path inside it. The newer
workspace remains untouched, so post-migration data is not destroyed. Inspect
the returned file count and digest, open the restored tracker, report and
application, and only then start beta.22 with the separate restored workspace.
Use `scout workspace snapshot-beta22 --workspace PATH` to display or create the
compatibility snapshot explicitly. A damaged snapshot fails closed; restore a
verified private backup instead of editing its manifest.

If final verification fails, Scout may intentionally preserve an unaccepted
destination and/or its temporary `.scout-rollback-*` sibling because either
pathname could have been substituted concurrently. Do not run or delete those
trees by assumption. Preserve them for operator review, compare their physical
identity and manifest content, and choose a new absent destination for any
subsequent reviewed rollback attempt.

Uninstall removes application files but intentionally preserves the workspace. Verify this on important deployments and remove schedules separately.
