# Private Remote Access

Scout is local-first by default. Private Remote Access is optional and makes one signed-in computer the canonical Scout host. Phone and laptop browsers then use that one running Scout process, private workspace, chat transcripts and active provider sessions. Clients do not clone or directly edit the workspace.

## Requirements and cost

- The host must be awake, connected to the internet, signed in to its operating-system user account and running Scout.
- Install [Tailscale](https://tailscale.com/download) on the host and every client, then sign in with the same user login on each device.
- Tailscale's [Personal plan](https://tailscale.com/pricing) is currently free and intended for personal, non-commercial use. Business and organisational users must check the current plan and terms themselves.
- Codex or Claude authentication stays in the host user's provider-owned profile. Scout never copies `%USERPROFILE%\.codex`, provider credentials or authentication stores to another device.

Scout uses private [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), not Funnel. The backend remains on `127.0.0.1:8459`; there is no LAN listener, router port-forward or public Scout endpoint.

## Enable it

1. Open Scout on the host at `http://127.0.0.1:8459`, then open **Settings**.
2. In **Private Remote Access**, install or sign in to Tailscale if Scout requests it, then select **Check again**.
3. Confirm the detected Tailscale owner. Scout accepts only that exact login. Other tailnet users, shared users and tagged devices receive `403`.
4. Leave the HTTPS port automatic. Scout inspects `tailscale serve status --json` and uses 443 when unused, then 8443. If both are occupied, enter another free port. Scout never resets or replaces unrelated Serve mappings.
5. On Windows, leave **Start Scout automatically with Windows** selected unless you do not want this host to recover after sign-in.
6. Select **Enable private remote access**. If Tailscale displays an HTTPS authorization link, open it, approve HTTPS, and select **Retry setup**.
7. Save the final `https://device.tailnet.ts.net` address. A non-default port appears at the end of the URL.

Scout records the exact mapping it owns. **Turn off remote access** removes it only while it still points to Scout; changed or unrelated mappings are left untouched. Scout never runs `tailscale serve reset`.

After enabling remote access, run this on the host for a read-only local acceptance report:

```powershell
scout remote preflight --require-enabled
```

It checks the supervised startup registration, exact Scout-owned Serve mapping, loopback-only network policy, local API classification, security and cache headers, and the installable web-app manifest. It does not print the configured owner login or any provider credentials. The report lists the remaining phone, alternate-identity, crash-recovery and reboot checks separately.

Maintainers completing a release should work through the root [Private Remote Hosting: Outstanding Tasks](../REMOTE_HOSTING_TODO.md) checklist and attach the resulting evidence to the feature PR or release record.

## Connect a phone or laptop

1. Install Tailscale on the client and sign in with the same owner login shown by Scout.
2. Open the Scout HTTPS address in Safari, Chrome or Edge. Test mobile access with Wi-Fi off if you want to confirm it works over mobile data.
3. To install the browser app, use **Add to Home Screen** on iPhone/iPad or **Install app**/**Add to Home screen** in Chrome or Edge.

The installed web app caches only Scout's static shell. APIs, chats, CVs, reports, downloads and streamed responses are never cached for offline use. If the host is asleep, off, signed out or disconnected, Scout shows a host-unavailable message; offline editing is not supported.

## Startup and recovery

Windows installs a least-privilege per-user Task Scheduler task named `\Scout\Scout Host`. It starts after that Windows user signs in, stores no password, ignores duplicate launches, and restarts the tray host after unexpected failure. The tray host checks `ScoutRuntime.exe` every 30 seconds and retries failures with bounded backoff. Target availability is within 90 seconds after sign-in, subject to Windows and network startup.

Scout cannot host before Windows sign-in. Sleep and hibernation also stop remote access. Choosing **Quit Scout** stops remote access until Scout is relaunched or the next sign-in.

Encrypted private backup includes visible Scout chat transcripts, but not provider session IDs. Restoring on another host marks each recovered transcript and makes its next message start a new Codex or Claude session. This preserves the conversation for reference without copying provider authentication or pretending an old device-local provider session still exists.

## Disable or uninstall

Use **Settings -> Private Remote Access -> Turn off remote access** on the host. Normal local Scout use continues without Tailscale. The Windows uninstaller also attempts to remove the exact Scout-owned mapping, its Task Scheduler entry and the legacy startup registry entry. It preserves unrelated Tailscale Serve configuration and the private Scout workspace.

For diagnostic comparison, [Tailscale documents](https://tailscale.com/docs/reference/tailscale-cli/serve) the persistent `--bg` mapping and `serve status --json` commands Scout uses. Do not substitute Funnel.
