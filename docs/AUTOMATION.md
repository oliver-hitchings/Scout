# Scheduled scans

Scout can register multiple named, per-user scheduler jobs. Scheduling is optional and may be enabled only after a successful supervised scan. Each job is enabled, changed and disabled independently.

First-run setup offers only the provider selected for the workspace, for example a Codex primary scan. A second compatible provider appears only after choosing **Add verification pass** in **Settings → Scans & schedule**. It is never enabled implicitly.

An optional two-provider VPS schedule is:

- `claude-primary` at 07:30 in `primary` mode;
- `codex-second-pass` at 08:30 in `second-pass` mode.

Linux timers pin the workspace IANA timezone (normally `Europe/London`) in `OnCalendar`, so daylight-saving changes do not shift the intended wall-clock time even when the VPS itself runs UTC.

The one-hour gap exceeds Scout's 45-minute native execution limit. The workspace lock remains authoritative: if a prior scan is still active, the later run is recorded as skipped and never overlaps it.

## Install and inspect

```powershell
scout schedule install --id claude-primary --time 07:30 --provider claude --mode primary
scout schedule install --id codex-second-pass --time 08:30 --provider codex --mode second-pass
scout schedule status
scout schedule run-now --id claude-primary
```

Each job receives a distinct native identity, such as `Scout Daily Scan - claude-primary`, `app.scout.daily-scan.claude-primary`, or `scout-daily-scan-claude-primary.timer`. Jobs run as the current user with least privilege, catch up after a missed trigger, and stop after 45 minutes.

On a headless Linux VPS, enable lingering for the dedicated Scout account so its user timers and D-Bus session remain available:

```sh
sudo loginctl enable-linger "$(id -un)"
systemctl --user status scout-daily-scan-claude-primary.timer
systemctl --user status scout-daily-scan-codex-second-pass.timer
```

## Change or remove

Re-run `schedule install` with the same ID to update one job. Remove jobs individually:

```powershell
scout schedule remove --id claude-primary
scout schedule remove --id codex-second-pass
scout schedule status
```

Remove all jobs before deleting or moving a workspace. Native scheduler status is authoritative. Uninstalling Scout does not implicitly remove saved jobs.

Scan metadata is written under `logs/` and `data/scan-runs.jsonl`. Do not share private prompts, workspace content, or provider credentials when diagnosing failures.
