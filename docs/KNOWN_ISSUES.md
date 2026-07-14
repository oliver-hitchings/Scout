# Known Issues

This page tracks confirmed problems in released Scout packages. Check
[Troubleshooting](TROUBLESHOOTING.md) for general setup and diagnostic guidance.

## Windows: Codex can be reported as not installed when it is present

- **Affected release:** Scout `0.1.0-beta.9`
- **First recorded:** 2026-07-14
- **Status:** Resolved in Scout `0.1.0-beta.10` after installed-VM acceptance.

On the confirmed affected setup, Scout found the correct Codex path but Windows
returned `ENOENT` when the tray host launched Codex from inside its process Job
Object. Running the same Scout runtime outside that Job Object detected and
authenticated Codex normally. The beta.10 fix replaces Job Object cleanup with
Scout's explicit local shutdown endpoint and checks official per-user provider
locations from the packaged runtime environment.

On some Windows installations, Scout's provider check displays:

```text
Codex
Not installed
```

This can be a false negative when Codex is supplied by the Codex desktop app and
the executable exists at the official per-user location:

```text
%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
```

Do not reinstall Codex solely on the basis of Scout's status message. First
verify the CLI directly:

```powershell
codex --version
codex login
codex login status
```

Then fully quit and reopen Scout and refresh the provider check. If PowerShell
can run Codex but Scout still reports **Not installed**, treat it as this known
detection issue. Continue to keep provider login credentials in the provider's
official login flow; do not copy tokens into Scout or its workspace.
