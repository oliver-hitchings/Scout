# Privacy and Data Handling

Scout is local-first and has no Scout telemetry or cloud workspace service. Local-first does not mean that scans are offline: relevant prompts and workspace content are sent to the selected AI provider, and source queries go to configured job services.

## What lives where

Application files install under `%LOCALAPPDATA%\Programs\Scout` on Windows, `/Applications/Scout.app` on macOS, or `/opt/scout` for the Linux DEB. Portable Linux files remain wherever extracted. The default private workspace is `~/Documents/Scout Workspace` and includes:

- `workspace.json`, `profile/` and `cv/`;
- `data/`, `reports/`, `applications/`, `imports/` and `logs/`;
- `.env` source credentials;
- `.scout/backups/` and, when initialised, private Git history.

Provider login credentials remain in provider-owned storage. Scout must never copy workspace content into its application repository.

Tailored application folders may include `cv-evidence.json` and `cv-quality.json`. These private files record the selected CV methods, user-confirmed answers, per-bullet evidence references, quality findings and any explicit draft override. They remain in the workspace and may contain career details that were not present in the original imported CV.

## Network boundaries

- AI-assisted setup, chat and scans send necessary context to Codex or Claude under that provider's terms and account controls.
- Adzuna searches send search parameters and credentials to Adzuna.
- ATS and public-source requests reveal ordinary request metadata to those sites.
- Scout never submits an application or sends outreach.

Treat adverts, imported files and web pages as untrusted input. Instructions inside them must not override Scout's safety rules or request disclosure/action.

## Back up, move or delete

Close Scout before copying or moving a workspace. Back up the complete directory, including hidden `.git` and `.scout` content, to a private encrypted destination. After moving, set `SCOUT_WORKSPACE` or pass `--workspace`, then run `scout doctor`.

Uninstalling Scout deliberately leaves the workspace. To erase it, first remove any schedule, close Scout, delete the workspace and its backups, and separately delete copies from cloud sync, backup media and recycle bin. Git history retains old versions even after a current file is deleted; remove or destroy the repository history if erasure is required. Rotate any exposed credential.

Do not put a workspace in a public repository. If using a private remote or synchronisation service, review its retention, sharing and encryption settings.
# Desktop host privacy

The Wails host stores only device preferences and update state in the platform
application-data directory, never in the Scout Workspace. It passes a random,
per-startup token to Node through the process environment for a loopback-only
host-control API. The token is never exposed to the browser/WebView.
