# Install Scout on Linux

Scout supports Ubuntu 22.04+ and Debian 12+ on x64. Other x64 distributions can try the portable tarball. Scout requires your own authenticated Codex or Claude account.

Private Remote Access is optional. After normal setup, install [Tailscale](https://tailscale.com/download), sign in, and enable **Settings -> Private Remote Access**. Connect clients and install the home-screen app as described in [Private Remote Access](PRIVATE_REMOTE_ACCESS.md). The computer must be awake and the user session active.

## Optional user service

Scout does not install a Linux host service automatically in this release. For a source checkout, create `~/.config/systemd/user/scout-host.service`, replacing the executable and checkout paths with absolute paths:

```ini
[Unit]
Description=Scout private host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/Scout
ExecStart=/absolute/path/to/node /absolute/path/to/Scout/ui/server.mjs
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

Run `systemd-analyze --user verify ~/.config/systemd/user/scout-host.service`, then `systemctl --user daemon-reload` and `systemctl --user enable --now scout-host.service`. Inspect it with `systemctl --user status scout-host.service`; disable it with `systemctl --user disable --now scout-host.service`. Do not enable user lingering: Scout and provider authentication are intended to start after the owner signs in.

1. Download the `.deb` or `.tar.gz` and `checksums.txt` from [Scout releases](https://github.com/oliver-hitchings/Scout/releases).
2. Run `sha256sum Scout-*-linux-x64.*` and compare it with the published checksum.
3. On Ubuntu/Debian, run `sudo apt install ./Scout-*-linux-x64.deb`, then open Scout from the application menu or run `scout-dashboard`.
4. For the portable build, extract it and run `./Scout-*-linux-x64/scout-dashboard`.
5. Complete provider setup, onboarding and the supervised first scan in the browser window Scout opens.

Private data defaults to `~/Documents/Scout Workspace`. `sudo apt remove scout` removes application files but preserves that workspace. Daily scans use the current user’s systemd service manager; systems without systemd user services retain supervised manual scans.
