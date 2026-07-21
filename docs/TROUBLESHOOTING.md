# Troubleshooting

Start with `scout doctor --workspace PATH`. Keep error reports synthetic and never attach a real workspace, `.env`, CV or provider log.

## Scout cannot find the workspace

Confirm the directory contains `workspace.json`. Check `--workspace` first, then `SCOUT_WORKSPACE`; command-line selection takes precedence. Quote paths containing spaces. Run `scout workspace init` only for a new/empty intended destination.

## Invalid or newer workspace schema

Restore valid JSON from a private backup or correct the reported field. Do not reduce `schemaVersion` to bypass a newer-schema error; install a compatible Scout version. Migration backups are under `.scout/backups/`.

## Provider not found or not authenticated

Run the provider's `--version` and authentication status command in a new PowerShell window. Restart Scout after `PATH` changes. Clear unsupported `ai.model` overrides. See [Providers](PROVIDERS.md).

## CV import fails

Files must be PDF, DOCX, Markdown or plain text and no larger than 10 MB. Password-protected, malformed and image-only/scanned PDFs cannot be extracted reliably; decrypt or OCR a private copy locally, then review extracted text before accepting it.

## Adzuna is unavailable

Confirm both variables exist in the selected workspace `.env`, without quotes accidentally becoming part of their values. Test `scout source adzuna`. Missing Adzuna credentials are non-fatal; invalid credentials, quota and network failures should be recorded as reduced coverage.

## Scheduled scan does not run

Check `scout schedule status`, confirm the native scheduler entry points to the current application/workspace and run `scout schedule run-now`. Inspect workspace logs and Task Scheduler, launchd, or systemd-user history. Remove/reinstall the schedule after moving a workspace.

## Port or UI problem

Scout serves the UI on loopback at `http://127.0.0.1:8459`. Close stale Scout processes before retrying. Do not expose the port to the network. From source, run `npm test` before `npm start` and inspect terminal output.

If an already-open page still shows an older layout after Scout itself was upgraded, refresh it once. Current Scout builds compare the loaded interface with the serving process and display **Scout updated — Refresh Scout** when they differ. Scout never performs that refresh silently; save or close active CV edits, chats, scans and settings first.

The header backup status opens **Backup details**. Use **Advanced backup settings** from there for configuration. The main **Settings** button opens the sectioned settings hub; first-run onboarding appears automatically only for an unfinished workspace.

## Private backup cannot be enabled

Backup is optional. Confirm Git and Git Credential Manager are installed, restart Scout after installation, and use a credential-free `https://github.com/owner/repository` URL. Connecting a local workspace requires an empty Private repository; use **Restore my existing workspace** for a repository that already contains Scout data. Scout refuses public repositories and refuses to push `.env`, generated PDF/DOCX files or other sensitive ignored paths when they are already tracked in Git.

## Backup is offline, pending, or needs attention

**Offline — saved locally** means Scout made a local commit and will retry later. **Needs attention** means both the computer and GitHub have new history; Scout deliberately does not reset, rebase, merge or force-push. Preserve both copies and resolve the Git history manually before selecting **Retry**. Never delete `.git`, `.scout/sync.json` or `.scout-backup/` as a conflict workaround.

## A scan reviewed candidates but kept zero

This is not automatically a failed scan. Scout shows the number reviewed, number kept and the discard breakdown (hard exclusions, mandatory gates, below-threshold results and provider assessment discards), with a link to the dated report. Check source health first. If sources were healthy, zero keepers can be the correct result for strict salary, location, commute or evidence gates. Do not weaken a genuine hard gate merely to produce results.

Scout refuses to start a scan when the approved profile, calibration or master CV is incomplete. If Setup reports an empty activated master CV and offers the validated recovery control, use it there; Scout backs up the current file and restores only the hash-checked reviewed staging copy. If the control is unavailable, preserve the workspace and inspect the reported mismatch.

## Restore fails

Restore requires an empty target folder, the private repository HTTPS URL, and either the passphrase or emergency recovery key. Scout rejects malformed/tampered recovery data, symlinks, unsupported workspace schemas and workspaces that fail `scout doctor`. Codex/Claude authentication is not restored; sign in to the provider separately. Startup and scheduled scans require explicit confirmation on the new computer.

## SmartScreen or checksum mismatch

Unsigned beta installers may trigger SmartScreen. Compare `Get-FileHash -Algorithm SHA256` with the release checksum. If it differs, do not run the file; download again from the official release. A matching checksum does not replace antivirus scanning or code signing.
