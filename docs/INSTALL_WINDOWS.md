# Install Scout on Windows

Scout is an unsigned Windows 10/11 public beta. It keeps its workspace on your computer, but the career context needed for AI tasks is sent to the Codex or Claude account you choose. Scout never applies for jobs or sends outreach.

## Install

1. Open [Scout releases](https://github.com/oliver-hitchings/Scout/releases), choose the newest beta, and download its Windows `.exe` plus `checksums.txt`.
2. In PowerShell, verify the download with `Get-FileHash .\Scout-0.1.0-beta.10-windows-x64.exe -Algorithm SHA256` and compare it with `checksums.txt`.
3. Run the installer. Windows SmartScreen may warn because the beta is not code-signed; use **More info → Run anyway** only after the checksum matches this repository's release.
4. Leave **Launch Scout** selected, or double-click the Scout shortcut later. Scout starts a local server and opens `http://127.0.0.1:8459` in your browser.

## First setup

1. Follow Scout's link to install either Codex CLI or Claude Code, sign in with your own eligible provider account, and refresh the provider check.
2. Tell Scout the roles, sectors, locations, compensation and exclusions you want. Scout does not read unrelated AI conversations or infer a career from provider history.
3. Import a selectable-text PDF, DOCX, Markdown or text CV. Scanned PDFs need OCR first.
4. Generate one bounded proposal, review all five staged profile/CV/search files, then explicitly choose **Approve and activate**. Approval uses no AI operation and nothing is activated silently.
5. Run the supervised first scan inside Settings and review the dashboard. Only then enable an optional daily scan.
6. Optionally choose **Set up private backup**. Scout explains how to create an empty private GitHub repository, checks Git and Git Credential Manager, and signs in through your browser. You can choose **Not now** and enable backup later in Settings without losing any Scout features.

Scout runs as `Scout.exe` in the Windows notification area. Use its arrow-menu icon to open, restart, check for updates, or quit Scout. The supporting local server appears as `ScoutRuntime.exe`, not a generic Node process.

## Privacy and recovery

The default workspace is `%USERPROFILE%\Documents\Scout Workspace`. It survives upgrades and uninstall, and local-only use needs neither Git nor GitHub. If you enable backup, use only the private workspace repository Scout guides you to create—never the public Scout application repository and never a public repository. Scout keeps ordinary career files readable in that private repository and adds encryption for credentials and generated documents. Keep the one-time recovery key somewhere outside the computer.

On a new computer, choose **Restore my existing Scout workspace** on the first screen, paste the private repository's HTTPS URL, sign in through Git Credential Manager, and enter either the recovery passphrase or recovery key. Scout validates the restored workspace before installing it and will not overwrite an existing non-empty workspace. If Scout does not open, launch it again and use **Settings → Restart Scout**; diagnostic logs are in the workspace's `logs` folder and are never backed up.

To upgrade, use the tray menu to quit Scout, then install a newer release over the existing application. To uninstall, use Windows Installed Apps; remove any scheduled scan first. Your workspace is deliberately preserved.
