# Quick Start

Scout is a local-first opportunity finder for Windows, macOS and Linux. It keeps your career data in a private workspace and uses Codex or Claude to help search and assess opportunities. It never sends applications or outreach.

## 1. Install and launch

Download the Windows installer and its `checksums.txt` from the same GitHub release. Compare the installer SHA-256 hash before running it:

```powershell
Get-FileHash .\Scout-0.1.0-beta.5-windows-x64.exe -Algorithm SHA256
```

The first unsigned beta may trigger Microsoft SmartScreen. A matching checksum proves file integrity, not publisher trust. Scout installs for the current user under `%LOCALAPPDATA%\Programs\Scout` and does not require administrator rights.

For a source checkout, install Node.js 20+, then run `npm install` and `npm start`.

## 2. Create a private workspace

Accept the default `%USERPROFILE%\Documents\Scout Workspace`, or choose another private local folder. Do not select a public repository or a broadly shared/synchronised folder.

From a source checkout:

```powershell
node tools/scout.mjs workspace init --workspace "$HOME\Documents\Scout Workspace"
```

The workspace contains `workspace.json`, your profile, CV, tracker, reports, applications, imports, logs and ignored credentials. It is separate from application files and survives upgrades and uninstall.

## 3. Connect an AI provider

Install and sign in to either Codex or Claude Code using the provider's official instructions. Scout does not collect the provider password or token.

```powershell
codex login
codex login status

# Or
claude auth login
claude auth status
```

The beta installer currently provides the Scout UI shortcut but does not add the
`scout` command to `PATH`. Use the UI diagnostics, or invoke the bundled CLI
explicitly when following command-line examples:

```powershell
$ScoutNode = "$env:LOCALAPPDATA\Programs\Scout\runtime\node.exe"
$ScoutCli = "$env:LOCALAPPDATA\Programs\Scout\app\tools\scout.mjs"
& $ScoutNode $ScoutCli doctor --workspace "$HOME\Documents\Scout Workspace"
```

In a source checkout, `node tools/scout.mjs doctor` is equivalent. A globally
available `scout` command is only present when the package has been linked or
installed separately.

See [Providers](PROVIDERS.md) if detection or authentication fails.

## 4. Add your CV and preferences

The first-run wizard accepts selectable-text PDF, DOCX, Markdown and plain text files up to 10 MB. Scanned PDFs need OCR before import. Review the extracted text and every generated profile/configuration change; Scout must not invent missing facts.

Complete the setup interview with your role families, sectors, locations, minimum salary, commute preferences, exclusions and preferred writing tone. See [AI Setup](AI_SETUP.md) for a guided route or [Configuration](CONFIGURATION.md) for manual editing.

Scout uses these approved answers, the imported CV and generated search lanes to find and score jobs. It does not inspect unrelated Codex/Claude conversations or automatically infer a career from previous AI usage.

## 5. Add sources

Public/ATS sources work without Adzuna. Adzuna is optional and uses `ADZUNA_APP_ID` and `ADZUNA_API_KEY` stored in the workspace `.env`. See [Adzuna and Sources](ADZUNA_AND_SOURCES.md).

## 6. Run and review the first scan

Use **Settings → First scan → Run supervised scan**. Keep Scout open while it searches, then review the dashboard and dated report. The command-line equivalent is:

```powershell
& $ScoutNode $ScoutCli doctor
& $ScoutNode $ScoutCli scan --provider codex --mode primary
```

Use `claude` instead if selected. Review the dated report and tracker changes. Confirm that exclusions, salary handling and locations behave as intended before relying on results.

## 7. Enable daily scans (optional)

Only schedule scans after a successful supervised run:

```powershell
& $ScoutNode $ScoutCli schedule install --time 07:30 --provider codex
& $ScoutNode $ScoutCli schedule status
```

Scheduled scans use Windows Task Scheduler, macOS launchd, or a Linux systemd user timer. See [Automation](AUTOMATION.md).
