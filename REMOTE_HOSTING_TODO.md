# Private Remote Hosting: Outstanding Tasks

This is the handoff checklist for the `agent/private-remote-hosting` feature branch. Resume in the clean worktree at:

```text
C:\Users\olive\Documents\GitHub\Scout-remote-hosting
```

The beta.11 version bump and release commit must remain separate from the feature PR. The beta.10 installer currently in `installer/output/` is a validation artifact only and must not be published as beta.11.

## 1. Restore publishing access

- [x] Reauthenticate GitHub CLI:

  ```powershell
  gh auth login -h github.com
  gh auth status
  ```

- [x] Review the feature worktree with `git status --short --branch` and `git diff --check`.
- [x] Commit only the private-remote-hosting feature on `agent/private-remote-hosting`.
- [x] Push the branch and open a **draft** PR against `main`.
- [x] Confirm the PR contains no beta.11 version bump, release notes, tag or published installer.

## 2. Prepare the Windows host

- [ ] Install Tailscale from <https://tailscale.com/download> on the desktop.
- [ ] Sign in to Tailscale with the owner account that should be allowed into Scout.
- [ ] Install Tailscale on the phone and laptop and sign in with that same owner account.
- [ ] Install a fresh validation build of Scout or upgrade an existing beta.10 installation.
- [ ] In **Settings -> Private Remote Access**, confirm the detected owner and enable hosting.
- [ ] Leave **Start Scout automatically with Windows** selected.
- [ ] If Tailscale requests HTTPS approval, open its authorization URL and retry setup.
- [ ] Record the final `https://device.tailnet.ts.net[:port]` address without recording credentials.

## 3. Run automated host acceptance

- [ ] Run:

  ```powershell
  scout remote preflight --require-enabled
  ```

- [ ] Save the report as PR/release evidence. It must report no failed checks.
- [ ] Confirm `tailscale serve status --json` still contains any unrelated mappings unchanged.
- [ ] Confirm Scout remains bound only to `127.0.0.1:8459` and no Funnel configuration exists.

## 4. Test real clients and identity enforcement

- [ ] With phone Wi-Fi disabled, open Scout over mobile data through the Tailscale HTTPS address.
- [ ] Install Scout with **Add to Home Screen** and relaunch it from the installed icon.
- [ ] Connect from the laptop browser through the same address.
- [ ] Continue one Scout/Codex chat from desktop, phone and laptop; confirm all clients show the same transcript and active host session.
- [ ] Confirm pages, downloads, normal APIs and streamed chat work for the configured owner.
- [ ] Test with a different Tailscale user and confirm Scout returns `403`.
- [ ] Test a tagged device or request without `Tailscale-User-Login` and confirm Scout returns `403`.
- [ ] Confirm the browser shows clear host-unavailable messaging while the desktop host is stopped.

## 5. Test Windows recovery and upgrade

- [ ] Kill `ScoutRuntime.exe` without quitting the tray host; confirm automatic recovery.
- [ ] Confirm the tray host remains alive after a failed restart and retries with bounded backoff.
- [ ] Choose **Quit Scout** and confirm remote access stops until Scout is relaunched or Windows sign-in occurs.
- [ ] Reboot the desktop, sign in normally, and confirm the remote URL is reachable within 90 seconds.
- [ ] Confirm the `\Scout\Scout Host` task uses the interactive user, least privilege and no stored password.
- [ ] Upgrade from beta.10 with legacy registry startup enabled; confirm the scheduled task is verified before the legacy entry is removed.

## 6. Test backup, restore and safe cleanup

- [ ] Create an encrypted recovery backup containing at least one visible Scout chat transcript.
- [ ] Restore it to a separate test host/workspace.
- [ ] Confirm the transcript is visible, marked recovered and has no Codex/Claude session ID.
- [ ] Send the next message and confirm it starts a new provider session.
- [ ] Confirm no provider authentication store or `%USERPROFILE%\.codex` was copied.
- [ ] Create an unrelated Tailscale Serve mapping, disable Scout remote access and confirm the unrelated mapping remains unchanged.
- [ ] Re-enable Scout, uninstall it and again confirm unrelated Serve configuration and the private workspace remain intact.

## 7. Validate other-platform instructions

- [ ] Test the documented macOS LaunchAgent/login setup on a release runner or VM.
- [ ] Test the documented Linux `systemd --user` setup on a release runner or VM.
- [ ] Confirm both start only after user sign-in and do not introduce system services or provider credential copying.
- [ ] On the Ubuntu VPS, test the dedicated-user exception in `docs/INSTALL_VPS.md`: reboot without an SSH login, confirm Scout recovers, run one provider turn, and capture the preflight report.
- [ ] Confirm the VPS has no public Scout/HTTP ports, Scout listens only on `127.0.0.1:8459`, and disabling linger stops reboot-time hosting.

## 8. Finish beta.11 after the feature PR is approved

- [ ] Create the protected `beta-vps` GitHub Environment, owner approval rule, Tailscale workload identity and deployment-only SSH secrets documented in `docs/RELEASE.md`.
- [ ] Confirm `tag:scout-deploy` can reach only SSH on the VPS and the deployment key has only the narrow service-restart sudo permission.
- [ ] Exercise `tools/deploy-vps.sh` once against a disposable tag/commit and confirm rollback restores the prior commit after an intentional health-check failure.
- [ ] Merge the feature PR only after required acceptance evidence is attached.
- [ ] Create a separate beta.11 version/release commit.
- [ ] Run `npm ci`, `npm test`, `npm run release:audit` and `git diff --check` from the release commit.
- [ ] Build all release artifacts and record their SHA-256 checksums.
- [ ] Verify Windows, macOS and Linux CI/release runners.
- [ ] Publish `v0.1.0-beta.11` only after the release gates pass.
- [ ] Replace this checklist link with the final acceptance record or mark every item complete.

## Completed before handoff

- [x] Feature implemented in a clean beta.10-based worktree without changing the original checkout.
- [x] Remote-owner HTTP security, local-only administration, PWA caching boundaries, supervised startup, watchdog recovery, chat backup/restore and non-destructive uninstall are covered by automated tests.
- [x] Responsive desktop and 390 x 844 phone setup views were checked with no browser-console errors.
- [x] Full suite: 308 tests, 307 passed, 0 failed, 1 platform-specific skip.
- [x] Release audit passed across 329 files.
- [x] Source and packaged-runtime preflight smoke tests passed all locally available checks.
- [x] Validation-only Windows installer built successfully with SHA-256 `0ec247619c93bc50733488c510526c402356a41fb21820014505162f022f6226`.
