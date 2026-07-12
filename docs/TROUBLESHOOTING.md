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

## SmartScreen or checksum mismatch

Unsigned beta installers may trigger SmartScreen. Compare `Get-FileHash -Algorithm SHA256` with the release checksum. If it differs, do not run the file; download again from the official release. A matching checksum does not replace antivirus scanning or code signing.
