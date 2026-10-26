# Scout on a private Linux home server

Run one Scout instance per person, without a desktop or tray. Each instance has its own workspace, provider home, device settings, loopback port and schedule. These examples target Ubuntu with Node.js 24 and systemd. The owner adds private network access separately; Scout always listens on `127.0.0.1`.

## Install and create a workspace

1. Install Node.js 24 and an official Scout application archive. Verify it using [release verification](SUPPLY_CHAIN_SECURITY.md), extract it under `/srv/apps/scout/releases/VERSION`, and point `/srv/apps/scout/app` at that immutable directory. Keep application files owned by the administrator and read-only to the service account. Install Git if using private-repository backup and Typst if exporting PDFs.
2. Create an unprivileged account and private state directory:

   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/scout --shell /usr/sbin/nologin scout
   sudo install -d -o scout -g scout -m 0700 /srv/appdata/scout
   sudo install -d -o root -g root -m 0755 /etc/scout
   ```

3. Create the first person's empty workspace. `person-a` is a placeholder identifier, not a display name:

   ```bash
   sudo -u scout env SCOUT_HOUSEHOLD_SETTINGS=/srv/appdata/scout/household.json \
     /usr/bin/node /srv/apps/scout/app/tools/scout.mjs household create person-a \
     --directory /srv/appdata/scout --port 8460
   ```

   `household create` refuses an existing directory, duplicate identifier/port, overlapping workspace, or a workspace inside the application. It creates fresh generic files and never copies another person's profile, CV, provider credentials or tracker.

4. Create `/etc/scout/person-a.env`, owned by root with mode `0600`, containing `PORT=8460`. The service manager reads this file before dropping privileges. Provider commands use this instance's `HOME`; any executable must be available under the service's PATH. Store a local model's API-key file in this instance's private provider home, never in the application or unit file. See [provider setup](PROVIDERS.md).
5. Copy the packaged [web service](../templates/systemd/scout@.service), [scan service](../templates/systemd/scout-scan@.service), and [scan timer](../templates/systemd/scout-scan@.timer) into `/etc/systemd/system/`. All state directories in `BindPaths` must already exist. The units hide sibling state directories and expose only this instance's workspace and provider home. They use `User=scout`, an owner-only umask, process-group shutdown and a read-only application.
6. Start the web service:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now scout@person-a.service
   curl --fail http://127.0.0.1:8460/api/health
   ```

   A successful response includes `schemaVersion: 1`, the application version and `status: "ready"`. `setup-required` means the workspace has not been initialised. This is a liveness/configuration check; provider and scan readiness are reported separately.
7. Open this instance through an owner-controlled private connection and complete setup: choose background watch or active job hunt, import that person's CV, set their location, currency and timezone, and choose an AI provider. A local OpenAI-compatible provider does not require the Codex CLI. No public port, remote proxy or tray is configured by these examples.

## Schedule scans without a desktop

Use the system timer templates above for a system account. Registered household instances and explicitly headless services (`SCOUT_HEADLESS=1`, set by the templates) reject desktop-native schedule install, remove and run-now actions in both the CLI and UI/API. Their native status is marked owner-managed rather than guessed from another person's user-global task name. The settings screen directs the owner to this guide and keeps manual scans available. Manage each instance's system timer with the administrator commands below. Scout's desktop `schedule install` command remains available outside household/headless mode and needs a working user service manager.

Configure one schedule entry in this workspace's `workspace.json` before enabling its timer. Stop the instance while editing configuration. For the example timer:

```json
{
  "id": "person-a-primary",
  "enabled": true,
  "time": "07:30",
  "days": [1, 2, 3, 4, 5],
  "provider": "local",
  "mode": "primary",
  "model": null
}
```

Add that entry to `schedule.jobs`; do not replace the whole configuration with this fragment. Set workspace `timezone` to `UTC` for the example, or change both the timer's `OnCalendar` timezone and the workspace timezone to match the owner's choice. Set `SCOUT_SCAN_PROVIDER`, `SCOUT_SCAN_MODE` and `SCOUT_SCAN_JOB` in the instance environment file when using a different provider or job. Choose a model through that workspace's provider settings. A second pass needs a separate service/timer definition and job identifier; do not reuse the primary job's identity.

```bash
sudo systemctl enable --now scout-scan@person-a.timer
systemctl list-timers 'scout-scan@*'
sudo systemctl start scout-scan@person-a.service
journalctl -u scout-scan@person-a.service --since today
```

The scan process reads only this workspace and uses the normal provider preflight, durable queue, fenced lease and backup checkpoint. No desktop login is required. A provider failure remains visible and does not substitute another provider. `Persistent=true` starts a missed timer after downtime; Scout still checks the configured logical window and queue expiry. It does not invent successful coverage for a missed window.

## Household instances and switching

Create another person with a fresh identifier and a different port, then create its environment file. The command creates its private provider home inside its workspace. Enable `scout@person-b.service` and, if wanted, `scout-scan@person-b.timer`. Every systemd instance has explicit paths, so changing the CLI's selected person never changes a running service.

```bash
sudo -u scout env SCOUT_HOUSEHOLD_SETTINGS=/srv/appdata/scout/household.json \
  /usr/bin/node /srv/apps/scout/app/tools/scout.mjs household list
sudo -u scout env SCOUT_HOUSEHOLD_SETTINGS=/srv/appdata/scout/household.json \
  /usr/bin/node /srv/apps/scout/app/tools/scout.mjs household switch person-b
```

Selection affects the next CLI or web process without `--workspace` or `SCOUT_WORKSPACE`; those explicit settings take precedence. A selected household instance supplies its own port, device settings and private provider home. It clears inherited provider API-key/token variables and selects isolated Codex/Claude configuration directories; sign in separately for each person. Local-provider API-key files still come from that workspace’s explicit configuration. `PORT` remains an explicit owner override. Registered household instances always pin their device settings to their own workspace, even when a command inherits another instance’s `SCOUT_DEVICE_SETTINGS`; explicit external device-file overrides apply only outside household selection. The registry stores only instance identifiers, paths, ports and filesystem identities. Linked/replaced roots fail closed. It does not combine results or offer browser switching into someone else's workspace. Moving/restoring a workspace requires rebuilding its host-local registry; do not edit stored filesystem identities to bypass validation.

The systemd filesystem sandbox blocks accidental access to sibling state from an instance. A single Unix account is still an administrator trust boundary: the account owner can change the units or run commands outside that sandbox. Use separate Unix accounts, independent provider credentials and separately authorised private access when household members must be protected from one another. A loopback port is not a household authentication system; the owner must map each person's private access to only their instance.

## Reviewed scan storage maintenance

Storage warnings appear in the local summary API and the normal notification
outbox before pressure blocks new scans. On the instance's host, use
`scout cleanup --workspace YOUR_PRIVATE_WORKSPACE --plan` to list eligible data.
Select runs explicitly, save a private plan, inspect its digest and apply only
that confirmed plan. `--plan --queue` separately reviews queue compaction.
The [reviewed cleanup procedure](OPERATIONS.md#scan-storage-and-reviewed-cleanup)
covers credentials, retained/recovery-critical work, encrypted archives and
interruption recovery. There is no unattended deletion policy. Run the command
as the owning instance account with its explicit workspace; household selection
does not authorize maintenance on a different person's data.

## Local dashboard API

`GET /api/summary` is read-only, local-only and uncached. It never starts a provider, scan, digest or tracker mutation. The response has `schemaVersion: 1` and:

- `generatedAt`, current `mode` (`background` or `active`) and effective `threshold`;
- `scanHealth`: booleans `healthy`, `stale`, `degraded` and nullable `lastRunAt`;
- `providers`: configured provider identifiers, allowlisted health `state` and nullable `checkedAt`;
- `newMatches`: up to 200 new/inbox or shortlisted opportunities at/above the mode threshold, sorted by score, first-seen and identifier. Each contains only `id`, `title`, `employer`, `score`, `link` and `firstSeen`;
- `newMatchCount` and `matchesTruncated`, so a bounded card never pretends it returned every match; and
- `pendingAlerts` and `pendingAlertCount`: every unacknowledged notification within the notification store's 1,064-alert boundary, projected to identifier, kind, provider, count, creation time and delivery boolean.

“New” means still in the new/shortlist workflow, not “since the dashboard last polled”. Polling never marks an opportunity read. Links contain only HTTP(S) origin/path; queries, fragments and embedded credentials are excluded. New scan keepers retain their first-seen date through rechecks and receipted mutation recovery. Unknown legacy discovery dates and missing links are `null`; a later recheck never invents an original discovery date. No CV, profile, notes, prompts, provider output, private filesystem path or credentials are returned. Invalid durable state produces a sanitised `503` response. Breaking schema changes require a new schema version; consumers should reject unknown versions. Read each person's loopback port separately. Neither endpoint accepts write methods or grants access through Scout's remote-owner proxy route.

```bash
curl --fail http://127.0.0.1:8460/api/summary
```

## Optional outbound notifications

Outbound delivery is **off by default**. No destination is inferred. An owner can create `.scout/outbound-notifications.json` inside one workspace, owned by the Scout account with mode `0600`. `SCOUT_NOTIFICATION_CONFIG` can name an explicit external owner-managed file instead. There is no web endpoint that changes this configuration.

For an owner's loopback notification server:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "type": "webhook",
  "url": "http://127.0.0.1:9080/notify",
  "timeoutMs": 8000
}
```

Other destinations require HTTPS with normal certificate verification. Credentials, query strings, fragments and redirects are rejected; use an owner-side relay if authentication is needed. Scout sends one bounded JSON POST per alert, with `schemaVersion: 1`, `notification: {id, kind, provider, count, createdAt}` and an `Idempotency-Key` equal to the alert identifier. It sends no job title, CV, profile or provider response. Delivery is at least once: the receiver should deduplicate by identifier because a crash after acceptance can precede the receipt write.

For a local executable:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "type": "command",
  "command": "/usr/local/bin/scout-notify",
  "args": ["--scout-json"],
  "timeoutMs": 8000
}
```

Scout invokes that absolute, protected executable with the fixed argument array followed by one JSON argument using the same payload. It never invokes a shell. The child receives a minimal environment without provider keys, a bounded lifetime/output, and this workspace as its working directory. The owner explicitly authorises that executable to run as the Scout account; keep it read-only to untrusted users and available inside the service sandbox. Configure paths rather than shell pipelines. On timeout Scout terminates the child process group and waits for it to close.

The headless web service checks the normal alert/digest outbox at startup and every five minutes. Standalone CLI scans also dispatch after completion or a failed preflight. Active-hunt digests become due under the normal notification policy even when no tray is running. A tick delivers at most 16 alerts, stopping on the first failure; unsent alerts remain pending for a later tick. Only successful command exit or HTTP 2xx records the normal delivery receipt. Acknowledgement remains a separate reviewed action in Scout.

Run a delivery check explicitly (with an enabled configuration this sends pending alerts):

```bash
sudo -u scout env HOME=/srv/appdata/scout/workspace-person-a/.scout/provider-home \
  /usr/bin/node /srv/apps/scout/app/tools/scout.mjs notifications dispatch \
  --workspace /srv/appdata/scout/workspace-person-a
```

The command reports only enabled/busy and delivered/failed counts. Failures exit nonzero; raw command output and destination URLs are not printed. Set `enabled` to `false` or remove the configuration file to disable delivery. A workspace-local `outbound-dispatch.lock` prevents overlapping daemon/CLI sends. After a crash, stop that instance's web and scan services, verify no dispatcher remains, and remove only that empty lock directory before restarting. Never delete the notification files or receipts to clear a delivery lock.

## Upgrade, backup and restore

1. Disable the instance's scan timer and stop its scan/web services. Wait for all processes and child commands to exit. Take a consistent encrypted backup before changing binaries or workspace schema.
2. Back up **the complete workspace directory**, including `workspace.json`, `.env`, CV/import/profile files, tracker, reports, applications, chats, `.git` if used, `.scout` journals/queue/notification state, and encrypted `.scout-backup` recovery state. Preserve modes and hidden files. Do not cherry-pick tracker files away from their journal/receipt state. Include external living-CV sources separately if configured.
3. The workspace includes its isolated provider home; protect this credential material with encryption. Back up the household registry, `/etc/scout/*.env`, installed unit overrides, and any external notification configuration. Provider homes contain device-local login credentials and local API-key files: either back them up separately with encryption and restricted access or plan to re-authenticate on restore. Recovery keys/passphrases need their own offline recovery procedure. Never commit these files to the public application repository. See [private backup and state](VPS_BACKUP_AND_STATE.md).
4. Verify and extract the new application into a new immutable release directory, switch `/srv/apps/scout/app` to it, then start one web instance. Check `/api/health`, `/api/summary`, provider state and a synthetic/manual scan before re-enabling its timer. Repeat per person. Keep the previous application and the pre-upgrade workspace backup until verification is complete.
5. To restore, keep the original workspace untouched and materialise one complete backup into a new private directory. Verify its integrity before use. Remove stale host process locks only after proving no old process is alive; preserve scan journals, queue and notification receipts. Start with schedules and outbound notifications disabled while checking results, providers, timezone and backup status. Rebuild the host-local household registry against the restored root identity; creating a new instance first and restoring into its directory while stopped is one option. Restore credentials only to that person's provider home or sign in again as the dedicated account. Do not point two running instances at one restored directory.
6. A binary rollback alone is unsafe after a workspace-format change. Use the matching pre-upgrade workspace backup in a separate directory, or the documented versioned rollback workflow, and verify it before switching. Do not overwrite newer data. Re-enable schedules/outbound delivery only after the owner has checked the recovered state.

For diagnosis use `systemctl status`, `journalctl -u scout@person-a.service`, the health/summary endpoints, and [troubleshooting](TROUBLESHOOTING.md). Never paste raw workspaces, credential files or provider output into public issue reports. Update the private operator context with installed paths, actual ports, private access, backup destinations and the last successful restore drill.
