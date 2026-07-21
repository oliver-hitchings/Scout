# Known Issues

This page tracks confirmed problems in released Scout packages. Check
[Troubleshooting](TROUBLESHOOTING.md) for general setup and diagnostic guidance.

## Current release

No release-specific issue is currently confirmed here. If you find a reproducible problem, first follow [Troubleshooting](TROUBLESHOOTING.md), then report it through the appropriate public issue or private [security](../SECURITY.md) route using synthetic data.

## Resolved history

### CV sources hidden and Typst unavailable in beta.14

- **Affected release:** Scout `0.1.0-beta.14`
- **First recorded:** 2026-07-21
- **Status:** Resolved in Scout `0.1.0-beta.15`.

Beta.14 depended on a separately installed `typst` command and offered CV creation only inside expanded opportunity cards. Beta.15 packages a pinned compiler, keeps legacy CV sources visible when derived files are missing, and adds a creation route to the CV library.

### Stale settings dialog in beta.13

- **Affected release:** Scout `0.1.0-beta.13`
- **First recorded:** 2026-07-20
- **Status:** Resolved in Scout `0.1.0-beta.14`.

A page kept open across an upgrade could retain the older settings wizard in memory. The backup status also opened that full wizard, and the older page had no close control. Refreshing loaded the corrected assets. Beta.14 separates backup details from Settings, separates established settings from onboarding, derives cache keys from the exact UI build and prompts safely when an open page is stale.

### Windows provider detection in beta.9

- **Affected release:** Scout `0.1.0-beta.9`
- **First recorded:** 2026-07-14
- **Status:** Resolved in Scout `0.1.0-beta.10` after installed-VM acceptance.

On the confirmed affected setup, Scout found the correct Codex path but Windows
returned `ENOENT` when the tray host launched Codex from inside its process Job
Object. Running the same Scout runtime outside that Job Object detected and
authenticated Codex normally. The beta.10 fix replaces Job Object cleanup with
Scout's explicit local shutdown endpoint and checks official per-user provider
locations from the packaged runtime environment.

The fix is included in beta.10 and later. See the [beta.10 release notes](releases/0.1.0-beta.10.md) for the historical detail. Do not use the old workaround on a current release; follow [provider troubleshooting](TROUBLESHOOTING.md) instead.
