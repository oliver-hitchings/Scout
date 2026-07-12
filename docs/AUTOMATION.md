# Scheduled Scans

Scout registers one per-user scheduler entry: `Scout Daily Scan` on Windows, `app.scout.daily-scan` on macOS, or `scout-daily-scan.timer` on Linux. Scheduling is optional and should only follow a successful supervised scan.

The beta installer does not add `scout` to `PATH`. The examples below use
`scout` as shorthand; installer users should invoke the bundled CLI as shown in
[Quick Start](QUICK_START.md), or use the corresponding UI controls.

## Install and inspect

```powershell
scout schedule install --time 07:30 --provider codex
scout schedule status
scout schedule run-now
```

Use `claude` if that is the authenticated provider. Time is local 24-hour `HH:MM`. The task runs with the current user's interactive token and least privilege, starts when next available after a missed trigger, ignores overlapping instances, and has a 45-minute execution limit.

The computer must be available and the user session or service manager active. Sleep, provider outages and network failures may delay or fail a scan. Linux systems without systemd user services report scheduling as unsupported while supervised scans remain available.

## Logs and locking

Scan result metadata is written under workspace `logs/`. Scout also uses a workspace scan lock to prevent competing runs. Inspect failed output without sharing private prompts or credentials. If a stale lock remains after a crash, first confirm no Scout/provider process is running before using the CLI lock commands.

## Change or remove

Re-run `schedule install` with the desired time/provider to update the configured task, then verify status and `run-now`. To disable it:

```powershell
scout schedule remove
scout schedule status
```

Remove the schedule before deleting or moving its workspace, then reinstall it against the new path. Scout records the schedule as enabled only after Windows confirms creation and marks it disabled after confirmed removal. Treat `schedule status`/Task Scheduler as authoritative after every operation. Uninstalling the application should not be treated as schedule removal; explicitly remove and verify the task first.
