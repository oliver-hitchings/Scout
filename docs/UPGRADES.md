# Upgrades and Workspace Migrations

Scout application versions and workspace schema versions are separate. Installer upgrades replace application files and managed instructions; they must not delete the private workspace, its credentials or Git history.

The installer currently exposes the UI through shortcuts but does not add
`scout` to `PATH`. Installer users can run diagnostics through the UI or use the
explicit bundled CLI invocation in [Quick Start](QUICK_START.md).

## Before upgrading

1. Finish or stop active scans and remove/disable the schedule if the release notes require it.
2. Back up the complete private workspace, including hidden `.git` and `.scout` directories.
3. Record the installed Scout version and run `scout doctor`.
4. Read release notes for schema, provider and source changes.

On Windows, choose **Quit Scout** from the notification-area menu before running the new installer. Install the newer release over the existing application (Windows installer, replacement macOS app, or Linux package), then run:

```powershell
scout doctor --workspace "$HOME/Documents/Scout Workspace"
```

Scout validates `workspace.json`. Versioned migrations are designed to be safe to rerun and save the pre-migration configuration under `.scout/backups/`. Scout refuses a workspace schema newer than the application understands; upgrade the application rather than manually lowering `schemaVersion`.

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

If an upgrade fails, stop Scout, preserve the failed workspace and logs, reinstall the previous compatible application version, and restore a copied backup only when necessary. Do not overwrite newer workspace history casually.

Uninstall removes application files but intentionally preserves the workspace. Verify this on important deployments and remove schedules separately.
# Native host lifecycle and updates

Scout desktop releases use the Wails v3 native host. It owns the bundled Node
service, window lifecycle, tray/menu actions and desktop update state. The Settings
page and tray call the same host update manager; the browser never receives the
host-control token. Stable is the default channel; existing prerelease installs use
Beta unless the user explicitly opts out.

Before direct installation, the host must match the exact platform asset name and
SHA-256 entry in the release's combined `checksums.txt`. Windows uses the per-user
Inno installer after host exit; macOS uses the normal elevation flow to replace the
app; Debian uses `pkexec dpkg -i`; portable Linux stages a sibling swap with
rollback. AUR/pacman installs are never self-updated: use `paru -Syu scout` or
`yay -Syu scout`.

The beta.7 legacy launchers remain compatibility delegates for this first native
host release and will be removed in the following release.
