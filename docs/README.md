# Scout documentation

Choose the path that matches what you are trying to do.

## I want to try Scout

1. Read [Getting started](GETTING_STARTED.md) for a short first-use guide, or the [full quick start](QUICK_START.md) for more detail.
2. Follow the installer guide for [Windows](INSTALL_WINDOWS.md), [macOS](INSTALL_MACOS.md), or [Linux](INSTALL_LINUX.md).
3. Complete the setup wizard and read [AI provider setup](AI_SETUP.md) if Scout cannot find your provider.
4. Use [troubleshooting](TROUBLESHOOTING.md) if setup or a scan fails.

Scout stores career data locally by default. Read [privacy and data handling](PRIVACY.md) before adding a CV or connecting a private backup repository.

## I want Scout to run on an always-on server

For a household Linux server with one private instance per person, use the [home server guide](HOME_SERVER.md). It includes headless systemd services, timers, a local dashboard API, optional outbound notifications and restore steps.

For the maintained VPS deployment, start with the [VPS installation guide](INSTALL_VPS.md). It covers:

- private access through Tailscale;
- the web service and reboot persistence;
- the selected primary provider and an optional independent verification pass;
- encrypted private-repository backups; and
- health checks and recovery.

The [canonical VPS state and automatic backup guide](VPS_BACKUP_AND_STATE.md) covers the source-of-truth model, backup triggers, recovery drill, and multi-client safety boundary. The [private remote access guide](PRIVATE_REMOTE_ACCESS.md) explains the network and security model in more detail.

## I already use Scout

- [Search modes and local alerts](SEARCH_MODES_AND_ALERTS.md)
- [Configuration reference](CONFIGURATION.md)
- [AI providers](PROVIDERS.md)
- [Reconnect an expired Codex or Claude session](RECONNECT_PROVIDER.md)
- [Job sources and Adzuna](ADZUNA_AND_SOURCES.md)
- [Scheduled scans](AUTOMATION.md)
- [Scan storage and reviewed cleanup](OPERATIONS.md#scan-storage-and-reviewed-cleanup)
- [Upgrades and rollback](UPGRADES.md)
- [Known issues](KNOWN_ISSUES.md)
- [CV quality guidance](CV_QUALITY.md)
- [Living CV, editable drafts, feedback and employer notes](LIVING_CV.md)

## I want to contribute

Read [CONTRIBUTING.md](../CONTRIBUTING.md), then use:

- [repository layout](REPOSITORY_LAYOUT.md) for public/private data boundaries;
- [operations context](OPERATIONS.md) for the maintained VPS topology and change path;
- [provider acceptance](ACCEPTANCE.md) for synthetic expiry/recovery checks and the owner's real-account check;
- [scan protocol](SCOUT_SCAN_PROTOCOL.md) for scan behaviour;
- [release process](RELEASE.md) for packaging and publishing;
- [release package verification and signing](SUPPLY_CHAIN_SECURITY.md) for checksums, attestations and platform-signing boundaries; and
- [documentation maintenance](DOCUMENTATION.md) whenever a change affects users, setup, operations, security, or support.

Historical release notes live in [`docs/releases`](releases/). They describe a release as it was and are not current setup instructions.
The [current release-candidate notes](releases/0.1.0-beta.24-rc1.md) describe the
prepared candidate and its remaining acceptance and owner gates.
The [native packaging privacy-audit note](releases/native-packaging-privacy-audit.md)
describes the scoped vendor metadata correction and remaining packaging gate.
