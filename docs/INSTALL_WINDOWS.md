# Install Scout on Windows

Scout is an unsigned Windows 10/11 public beta. It keeps its workspace on your computer, but the career context needed for AI tasks is sent to the Codex or Claude account you choose. Scout never applies for jobs or sends outreach.

## Install

1. Open the latest [Scout release](https://github.com/oliver-hitchings/Scout/releases/latest) and download the Windows `.exe` plus `checksums.txt`.
2. In PowerShell, verify the download with `Get-FileHash .\Scout-0.1.0-beta.4-windows-x64.exe -Algorithm SHA256` and compare it with `checksums.txt`.
3. Run the installer. Windows SmartScreen may warn because the beta is not code-signed; use **More info → Run anyway** only after the checksum matches this repository's release.
4. Leave **Launch Scout** selected, or double-click the Scout shortcut later. Scout starts a local server and opens `http://127.0.0.1:8459` in your browser.

## First setup

1. Follow Scout's link to install either Codex CLI or Claude Code, sign in with your own eligible provider account, and refresh the provider check.
2. Tell Scout the roles, sectors, locations, compensation and exclusions you want. Scout does not read unrelated AI conversations or infer a career from provider history.
3. Import a selectable-text PDF, DOCX, Markdown or text CV. Scanned PDFs need OCR first.
4. Talk to Scout, review the staged profile/CV/search changes, and explicitly approve them. Nothing is activated silently.
5. Run the supervised first scan inside Settings and review the dashboard. Only then enable an optional daily scan.

## Privacy and recovery

The default private workspace is `%USERPROFILE%\Documents\Scout Workspace`. It survives upgrades and uninstall. Do not put it in a public repository or share its logs. If Scout does not open, launch it again and use **Settings → Restart Scout**; diagnostic logs are in the workspace's `logs` folder.

To upgrade, install a newer Scout release over the existing application. To uninstall, use Windows Installed Apps; remove any scheduled scan first. Your workspace is deliberately preserved.
