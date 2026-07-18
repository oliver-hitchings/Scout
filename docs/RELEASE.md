# Release Process

This is the canonical clean-history public application repository. Release only from this repository. Never copy commits, files or Git history from the private `scout-workspace` repository or the legacy mixed-history `StartupFinder` archive.

## Release gates

1. Start from a reviewed commit with a clean working tree. Run `npm ci`, `npm test`, `npm audit --audit-level=moderate` and `git diff --check`.
2. Complete code/security review, a fresh-workspace onboarding browser smoke test and representative CV import tests.
3. Configure personal markers for the audit without committing personal values. Run `npm run release:audit`; findings must be resolved, not waived casually.
4. Stage the allowlisted bundle:

   ```powershell
   node tools/build-release.mjs --stage-only
   ```

5. Manually inspect every staged path. It is the installer payload, not a public source repository. It must contain runtime UI/tools, templates, managed skills, dependencies, licence and bundled runtime only. It must not contain `profile/`, `cv/`, `data/`, `reports/`, `applications/`, `.env`, logs, scratch files, private docs, test fixtures or `.git`.
6. Build the unsigned Windows, macOS arm64/x64 and Linux x64 packages on their native GitHub runners. For a local Windows build:

   ```powershell
   npm ci --omit=dev
   node tools/build-release.mjs --installer --version 0.1.0-beta.12
   ```

   Set `ISCC_PATH` when required. The installer is named
   `Scout-<version>-windows-x64.exe`; it and `checksums.txt` are written to
   `installer/output/`. The current installer creates UI shortcuts but does not
   add the CLI to `PATH`.
7. Test on clean Windows, macOS and Ubuntu runners: install; first launch; provider detection; supervised/scheduled scans; missed-run/overlap/timeout; upgrade; and uninstall preserving the workspace.
8. Tag the reviewed commit with the exact package version prefixed by `v`. The cross-platform workflow builds all packages, runs native smoke tests and required-marker audits, deploys and health-checks the exact tag on the approved private Beta VPS, then publishes one checksum manifest and the release notes. A failed or unapproved VPS deployment prevents publication.

## Private Beta VPS deployment

The tag workflow uses the protected GitHub Environment `beta-vps`. Configure an owner approval rule and restrict it to release tags. Store these values as environment secrets, never in the repository:

- `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` for a narrowly scoped Tailscale OAuth client allowed to create ephemeral `tag:scout-deploy` nodes;
- `SCOUT_VPS_HOST` containing the private Tailscale hostname;
- `SCOUT_VPS_SSH_PRIVATE_KEY` containing a deployment-only Ed25519 private key;
- `SCOUT_VPS_SSH_KNOWN_HOSTS` containing the separately verified, pinned VPS SSH host-key line.

Tailnet policy should allow `tag:scout-deploy` to reach only TCP 22 on the Scout VPS. Install the matching public key only for the unprivileged deployment user. The VPS sudoers policy should allow that user to run only `/usr/bin/systemctl restart scout-host.service` without a password; validate the file with `visudo`.

The OAuth client needs only the `auth_keys` scope and permission to create `tag:scout-deploy` devices. The workflow sends [the reviewed deployment script](../tools/deploy-vps.sh) over the private SSH connection. It refuses a dirty or unexpected checkout, verifies that the release ref resolves to the workflow commit, runs `npm ci` and `npm test`, restarts the service, checks the version on `127.0.0.1:8459`, confirms the Tailscale Serve configuration did not change and runs the remote-hosting preflight. On failure after checkout, it restores the previous application commit and dependencies before restarting the service. It never changes the separate workspace or provider credential directories.

Before tagging a release, manually dispatch **Cross-platform release candidate** from `agent/beta12-release-candidate` with version `0.1.0-beta.12` and **Deploy VPS** selected. First select **Test rollback** while the VPS still runs the previous commit; that job must fail deliberately and log a healthy rollback. Then dispatch it again without **Test rollback** and require success. Workflow dispatch never enters the publication job.

## Required privacy review

Search tracked files, staged output, installer contents and all public Git objects for real names, email/phone/address/postcode, employers, CV phrases, salaries, opportunity IDs and secret assignments. Use synthetic screenshots and fixtures only. If a secret entered any commit, rotate it and rewrite the unpublished clean-history branch before sharing.

The release audit detects configured personal markers and likely secret assignments, but it is not proof of anonymity. Manual review remains mandatory.

## Versioning and rollback

Use semantic application versions and explicit workspace `schemaVersion`. Release notes must identify migrations, privacy/network changes, provider/source changes and manual actions. Retain the previous installer and checksums for rollback, but never publish a private workspace or its backups.

The first beta remains unsigned until a certificate and secure signing pipeline exist. Checksums verify bytes only; they do not provide publisher identity.
