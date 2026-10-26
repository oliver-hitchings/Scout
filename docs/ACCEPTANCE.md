# Check provider expiry and recovery

Run the automated checks before release. The owner then checks the installed
provider versions once with their own accounts, using a disposable workspace.

## Automated checks

From the application checkout, with Node.js 24 and dependencies installed:

```sh
npm run test:acceptance
```

The suite starts the actual Scout HTTP server and actual provider subprocesses
inside temporary provider homes. The executables imitate expired Claude
credentials, a revoked Codex session and a rejected Codex refresh. They never
contact a provider or read an existing account. The suite checks:

- remote authentication failure remains authoritative despite successful local
  sign-in checks, and the failed chat request remains available for explicit resend;
- the actual `scan --scheduled` command fails preflight, reaches the dashboard
  recovery API, and produces one provider-notification episode across repeat attempts;
- guided login uses the production HTTP routes and subprocesses, including the
  configured remote-owner path, CSRF/origin rejection, a failed remote confirmation
  and a successful retry;
- only successful remote confirmation clears the failure, missed scans remain
  available for an explicit choice, and reconnecting never resends chat automatically;
- a successful explicit resend runs once without duplicating the original user
  message, and login codes/raw provider diagnostics stay out of durable workspace
  data and server logs.

Native timer installation and Windows balloon delivery have separate platform
checks. This suite invokes the command a timer launches; it does not install a
timer, change a real sign-in or verify a third party's current login service.
A preload rejects source HTTP before loading the server and scan command, so
the explicit post-reconnection scan reports degraded coverage without contacting
job sources. The tests use Node's HTTP client only for the loopback Scout API.

Installed-artifact CI separately runs `node tools/native-install-smoke.mjs`
against the built native package (also `--portable` on Linux). Scan failures
return to the owning acceptance flow so its cleanup runs. The installed scan
uses production readiness and the real scan pipeline with only collection and
advert liveness replaced at synthetic boundaries; result checks target the
visible job card rather than a matching row in a hidden audit table. Windows uninstall
waits for the actual Inno uninstaller rather than a temporary launcher. The
first acceptance failure remains visible if cleanup also fails; cleanup-only
failures still fail the job. Temporary-directory removal has a bounded retry
for operating-system handles that close just after the owned processes exit.

Before each tested mutation, the native fixture explicitly drains pending
checkpoints in its installed server through a private fixture control channel.
This keeps a slow real Git child from replacing the intended domain check with
a legitimate workspace-busy result. The checkpoint guard, actual HTTP actions
and operation deadlines remain intact; no request is retried and no production
control endpoint is added.

The real browser profile-publication and mode-save actions also await that
owned boundary and require successful production HTTP responses. Mode-save
acceptance deliberately holds a real preceding Git checkpoint before draining
it, so a fast runner cannot hide missing browser-action ordering. The original
stored-mode check remains required.

## Once with real accounts

Use a separate test workspace and the same operating-system account that runs
Scout. Keep the intended workspace backed up. Use the provider's official account
controls to expire or revoke only the test host's session. A local logout checks
missing credentials; it does not establish remote-expiry or revocation behaviour.
Never copy account identifiers, codes, credentials, provider output or private
career material into an issue or test report.

For a source checkout on Linux or macOS, replace `YOUR_TEST_WORKSPACE` with an
absolute directory outside the application checkout, then run:

```sh
node tools/scout.mjs workspace init --workspace YOUR_TEST_WORKSPACE
SCOUT_WORKSPACE=YOUR_TEST_WORKSPACE PORT=8460 node ui/server.mjs
```

Open `http://127.0.0.1:8460`, complete setup with synthetic profile/CV evidence,
and use this test instance for the checks below. In PowerShell, set
`$env:SCOUT_WORKSPACE` and `$env:PORT` before running `node ui/server.mjs`.

1. **Expired Claude session.** With Claude still reporting local sign-in, revoke
   or expire the test session through the provider's account controls. Open a
   synthetic opportunity's chat and send one harmless request. Check that Scout
   says sign-in is required, saves the request and displays the provider warning.
   Refresh Settings twice: the warning must remain until remote verification succeeds.
2. **Revoked or refresh-failed Codex session.** Repeat with Codex. If the provider
   exposes separate revocation and refresh-failure cases, check both. Record a case
   that cannot be induced as unverified; do not simulate it by deleting local files.
3. **Guided recovery and explicit retry.** From the host, and again through the
   owner's configured private remote address, choose **Reconnect**, complete the
   guided sign-in and wait for verification. A failed verification must retain the
   warning. After success, confirm that no message was resent. Choose **Resend**
   yourself: the original request appears once and completes once. Refresh the
   conversation and check that its resend action has gone.
4. **Blocked scheduled scan.** Enable a test schedule using the affected provider,
   then revoke its test session before its next run. Check that the run is recorded
   as blocked by sign-in before source collection, the dashboard identifies the
   missed job, and one provider alert remains across repeated checks. After
   reconnecting, confirm that the missed run waits for **Run missed scan now**.
   Choose it once and confirm a new run appears. Restore the intended schedule.

Record the application commit, operating system, browser, provider CLI versions,
date, and pass/fail/unverified for each step. A synthetic pass proves Scout's
composition; the real-account result establishes compatibility with those provider
versions. See [provider reconnection](RECONNECT_PROVIDER.md) and
[private remote access](PRIVATE_REMOTE_ACCESS.md) for the normal user flow.
