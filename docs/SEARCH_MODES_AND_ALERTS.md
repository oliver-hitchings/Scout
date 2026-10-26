# Choose how Scout brings matches to your attention

Each private workspace has its own search mode. Setup asks whether you are
looking now. To change it later, open **Settings → Search & profile**, choose
**How should Scout help you?**, then select **Save search mode**.

| Mode | When to choose it | What you receive |
| --- | --- | --- |
| Background watch | You are not looking, but would consider an exceptional move | An alert only when a newly assessed match clears the exceptional bar; no routine digest |
| Active job hunt | You are actively looking | A daily summary of newly assessed good matches, with an invitation to review and give feedback |

Existing workspaces default to background watch. The workspace's own profile,
locale and timezone continue to govern its search. A mode does not change your
confirmed exclusions or publish an unreviewed profile.

## How the bar works

Both modes use Scout's existing deterministic ranking and detailed-assessment
gates. Background watch applies minimum check/action scores of 85/95 and
assesses at most six selected vacancies per scan. Active hunting uses the
workspace's normal check/action scores (55/70 by default) and assesses at most
60. A stricter configured threshold remains stricter. These scores are a
selection policy, not a guarantee that a role is suitable.

The displayed fit labels use this same current policy. Refreshing setup or
saving unrelated settings does not change a job's label. Saving a new mode or
stricter custom thresholds updates the labels to match those settings.

Only an assessed keeper at the action threshold creates a match notification.
An unknown mandatory requirement or a discarded assessment cannot trigger it.
A generic provider recommendation without a deterministic score keeps its
ordinary 70/55 value; selecting background mode cannot inflate that value to
95. Older legacy discovery without a ranked score may therefore produce no
exceptional matches. Publish a reviewed search profile to use ranked discovery.

Active hunting collects new qualifying matches for 24 hours from the first
one, then creates one digest. No empty digest is sent. A running host checks
every five minutes, so delivery can be a few minutes after the due time or
wait until a scan releases the workspace. When the host is stopped, the next
start or local delivery poll catches up. Changing to background watch clears
ordinary unsent active matches, while preserving outstanding exceptional
matches as background alerts. This change survives reloads and a later return
to active hunting; those cleared or already-alerted matches do not reappear in
a digest. Already-created alerts remain reviewable.

## Local delivery and acknowledgement

Assessed-match state is kept in the workspace's private
`.scout/notifications.json` and committed with the tracker/report mutation and
its recovery receipt. Provider episodes have independent reserved capacity in
`.scout/provider-notifications.json`. Timer-produced digests use
`.scout/notifications-runtime.json`, together with bounded consumed-pending IDs
that preserve mode-switch and digest completion without rewriting scan state;
delivery and acknowledgement use
`.scout/notification-receipts.json`. Those companion files never rewrite a
scan's receipted target. Lifetime vacancy dedupe is a small `notificationState`
tuple on the existing private tracker entry, committed in the same mutation. Repeating or recovering that mutation does not create another
alert. Provider transitions prepare a small fenced pending intent; the authoritative
health record is replaced before publishing the warning. Preparing or publishing
a notification cannot prevent health replacement. A full match outbox therefore
cannot erase an authentication failure. Pending intents are retried by the next
health transition or local notification poll, retaining quick failure/recovery
episodes without duplicates. Checking and sign-in progress do not create
notifications. A new failure after recovery can create a new alert.

The Windows tray polls the local outbox every 30 seconds. Each displayed
notification has an immutable event owner, so delayed update, recovery or old
notification events cannot acknowledge a newer match. It shows only generic
match counts or a provider name, never CV details, role titles, account data or
technical provider output. Clicking a balloon opens Scout. A delivery receipt
is recorded after Windows reports that the balloon was shown. If that receipt
fails, the running tray retries it without showing the balloon again. A crash
between display and receipt can cause a repeat after restart; the durable alert
itself remains a single record. Windows notification settings and Do not disturb
can delay or suppress a balloon, so check the dashboard if delivery is uncertain.

The dashboard shows unacknowledged alerts across reloads. Select **Review in
Scout**, then **Acknowledge notification** when you have seen it. Desktop
delivery and acknowledgement are separate: a displayed balloon does not remove
an alert from the dashboard. A busy scan can defer acknowledgement; retry when
it finishes. Provider reconnect and retry controls remain in the provider banner.

The local endpoints are `GET /api/notifications`,
`POST /api/notifications/poll`, `POST /api/notifications/delivered` and
`POST /api/notifications/acknowledge`. Polling and desktop delivery receipts are
restricted to the local Scout host. The normal owner, origin and JSON checks
protect mutations. Outbound notifications are disabled by default. A headless
host can use an [optional command or webhook](HOME_SERVER.md#optional-outbound-notifications)
only after the owner explicitly configures and enables it; Scout never infers a
destination. macOS, Linux and a remote browser retain dashboard alerts without
that hook. Scout does not install a native notification daemon on those platforms.

Each notification file is bounded to 4 MiB; the combined outbox retains at
most 1,000 match/digest alerts plus 64 provider warnings. The provider reserve
retires superseded or resolved operational history while preserving current
provider warnings; episode identities continue monotonically. Acknowledged
match/digest history may be removed to make room,
including on a dashboard-only host without native delivery. Unacknowledged
obligations are kept. Delivery receipts retain only current alerts and pending
obligations. Each provider also has a bounded pending-intent file; if notification
storage is unavailable through many state changes, it keeps the oldest
unreported transition and newest transitions rather than growing indefinitely.
Previously qualifying vacancies do not accumulate in the outbox:
their dedupe tuple stays with their existing tracker entry. If unresolved alerts
reach the bound, acknowledge older dashboard alerts to make room. Scout does
not silently discard an unseen alert or fill the disk. Notification files are
host runtime state; the per-vacancy tuple follows ordinary private tracker backup.

## Check the result

1. Save the desired mode in Settings and reopen the section to verify it.
2. Keep the Scout host and its scheduled scans running. Leave the Windows tray
   enabled if you need desktop delivery while the dashboard is closed.
3. Review the dashboard's provider warnings if scheduled work is blocked.
4. In active mode, review the digest's new matches and give explicit feedback;
   Scout never sends an application or resends a chat automatically.
