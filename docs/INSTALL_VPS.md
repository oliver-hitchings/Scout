# Host Scout on a private VPS

This is an optional advanced, single-owner deployment for an always-on Ubuntu host. Normal users should keep running Scout locally; local installation requires no VPS, Tailscale or deployment credentials. In this advanced mode the VPS becomes the one canonical machine holding the private workspace and provider sessions. Do not use this setup to share a Codex or Claude account, provide Scout to other users, or expose Scout to the public internet.

## Recommended host

- Ubuntu Server 24.04 LTS, x86-64/AMD64
- 2 vCPU, 4 GB RAM, 40 GB storage and 2 GB swap
- one dedicated, unprivileged Linux user; never run Scout or a provider CLI as `root`
- Tailscale on the host and every client
- no public Scout, HTTP or HTTPS ports

Four GB is the supported starting point for one interactive Scout/provider turn at a time. Use 8 GB for concurrent provider processes, browser automation or other services. The AI computation runs remotely, so no GPU is required.

## Install and authenticate

1. Create or choose a normal Linux user used only by the Scout owner. Give other people separate VPS and provider accounts.
2. Install the Scout Linux x64 `.deb` as described in [Install Scout on Linux](INSTALL_LINUX.md).
3. Sign in to Codex or Claude while logged in as that same Linux user. Use the provider's device-login flow where offered. Do not set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when you intend to use subscription authentication.
4. Install Tailscale, sign in, and use Tailscale SSH or a tailnet-only firewall rule for ongoing administration. Keep the initial SSH route until tailnet access has been tested so you do not lock yourself out.
5. Run `scout-dashboard` once through an SSH session with port forwarding, or temporarily use a local text browser, and finish Scout setup at `http://127.0.0.1:8459`. Never bind Scout to `0.0.0.0`.
6. In **Settings -> Private Remote Access**, confirm the detected owner and enable the Tailscale Serve address. Scout uses Serve, never Funnel.

Provider credentials stay in this user's home directory and are not included in Scout backup or release artifacts. Check the provider's current subscription and automation terms before relying on unattended use.

## Install the reboot-safe user service

The desktop Linux instructions deliberately stop Scout when the owner signs out. On a dedicated VPS only, a lingering user manager lets the same unprivileged user service start after reboot without creating a root Scout service.

Create `~/.config/systemd/user/scout-host.service` as the Scout owner:

```ini
[Unit]
Description=Scout private VPS host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="SCOUT_WORKSPACE=%h/Documents/Scout Workspace"
Environment="PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin:%h/.npm-global/bin"
ExecStart=/opt/scout/runtime/node /opt/scout/app/ui/server.mjs
Restart=on-failure
RestartSec=30
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
```

Then verify and enable it:

```sh
mkdir -p ~/.config/systemd/user
systemd-analyze --user verify ~/.config/systemd/user/scout-host.service
systemctl --user daemon-reload
systemctl --user enable --now scout-host.service
sudo loginctl enable-linger "$(id -un)"
systemctl --user status scout-host.service
```

`enable-linger` is the one intentional difference from a desktop installation. Apply it only to the dedicated Scout owner account. It does not make Scout root and it does not copy provider credentials. Disable the mode with:

```sh
systemctl --user disable --now scout-host.service
sudo loginctl disable-linger "$(id -un)"
```

Portable tarball users must replace both `/opt/scout` paths with absolute paths inside the extracted release. If the workspace lives elsewhere, change `SCOUT_WORKSPACE` to its absolute path.

## Validate before relying on it

Run `scout remote preflight --require-enabled`, then complete these live checks:

- reboot the VPS and confirm the private URL recovers without an SSH login;
- confirm `ss -ltn` shows Scout only on `127.0.0.1:8459`;
- confirm `tailscale serve status --json` contains Scout's Serve mapping and no Funnel;
- connect from the owner's phone or laptop over Tailscale;
- confirm another Tailscale identity and a request missing `Tailscale-User-Login` receive `403`;
- stop the user service and confirm the private URL becomes unavailable;
- run one Codex or Claude turn after reboot to confirm that user's provider login remains usable.

Keep automatic security updates, VPS snapshots and Scout's encrypted private-workspace recovery configured. A provider session may still require periodic interactive reauthentication.

## Source-checkout service and Beta updates

The private Beta host may instead use a system-level `scout-host.service` when the unit explicitly sets `User=ubuntu` (or another dedicated unprivileged owner), points at the source checkout and exports the separate `SCOUT_WORKSPACE` path. Scout itself must never run as root. This layout avoids user lingering and supports the gated tag deployment in [Release Process](RELEASE.md).

For the standard source paths, create `/etc/systemd/system/scout-host.service` with root ownership:

```ini
[Unit]
Description=Scout private VPS host
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/apps/Scout
Environment="HOME=/home/ubuntu"
Environment="SCOUT_WORKSPACE=/home/ubuntu/Documents/Scout Workspace"
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin:/home/ubuntu/.npm-global/bin"
ExecStart=/usr/bin/node /home/ubuntu/apps/Scout/ui/server.mjs
Restart=on-failure
RestartSec=30
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

Confirm the Node path with `command -v node` and adjust `ExecStart` if necessary. Validate and start the unit with `sudo systemd-analyze verify /etc/systemd/system/scout-host.service`, `sudo systemctl daemon-reload` and `sudo systemctl enable --now scout-host.service`.

For automated Beta updates, use a separate `scout-deploy` account. It updates the clean application checkout but must not read the workspace or the Scout owner's Codex and Claude profiles. Scout itself continues to run as `ubuntu`.

Create the account and a shared application group, then make only the application checkout group-writable:

```sh
sudo addgroup --system scout-deploy
sudo adduser --system --home /home/scout-deploy --shell /bin/bash --ingroup scout-deploy scout-deploy
sudo adduser ubuntu scout-deploy
sudo chgrp -R scout-deploy /home/ubuntu/apps/Scout
sudo chmod -R g+rwX /home/ubuntu/apps/Scout
sudo find /home/ubuntu/apps/Scout -type d -exec chmod g+s {} +
```

Install the deployment-only SSH public key in `/home/scout-deploy/.ssh/authorized_keys`, prefixed with `restrict`. Keep the workspace and provider credential directories owned by `ubuntu` with no group access. Use `visudo` to create `/etc/sudoers.d/scout-deploy` containing only:

```sudoers
scout-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart scout-host.service
```

Confirm the real systemctl path with `command -v systemctl`, keep the file owned by root with mode `0440`, and validate it with `sudo visudo -cf /etc/sudoers.d/scout-deploy`. Do not grant the deployment key general passwordless sudo.

The release workflow updates only the clean application checkout: fetch the exact release tag, run `npm ci`, run the complete tests, restart `scout-host.service`, then verify the local version and live Tailscale Serve mapping. It records and restores the previous application commit if deployment fails. The workspace, Codex/Claude profiles and existing Tailscale Serve mapping remain outside that update.
