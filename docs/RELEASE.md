# Release Process

This private development repository and its Git history contain personal data. **Never make it public, push its history to a public remote, or use it as the public repository's initial history.** Public releases must come from an allowlisted, audited snapshot in a brand-new clean-history repository.

## Release gates

1. Start from a reviewed commit with a clean working tree. Run `npm ci`, `npm test`, `npm audit --audit-level=moderate` and `git diff --check`.
2. Complete code/security review, a fresh-workspace onboarding browser smoke test and representative CV import tests.
3. Configure personal markers for the audit without committing personal values. Run `npm run release:audit`; findings must be resolved, not waived casually.
4. Stage the allowlisted bundle:

   ```powershell
   node tools/build-release.mjs --stage-only
   ```

5. Manually inspect every staged path. It is the installer payload, not a public source repository. It must contain runtime UI/tools, templates, managed skills, dependencies, licence and bundled runtime only. It must not contain `profile/`, `cv/`, `data/`, `reports/`, `applications/`, `.env`, logs, scratch files, private docs, test fixtures or `.git`.
6. Create the reviewed public source allowlist separately:

   ```powershell
   node tools/build-release.mjs --public-source
   node tools/release-audit.mjs --root dist/release/public-source --stage --require-markers
   ```

   Import only `dist/release/public-source` into a new empty public repository with a new initial commit. Do not use this private repository's history or mistake `dist/release/stage` for the source tree. Run the audit and tests again, then inspect all tracked paths and the complete new Git object database.
7. Build the unsigned Windows beta in the clean public checkout using Inno Setup 6:

   ```powershell
   npm ci --omit=dev
   node tools/build-release.mjs --installer --version 0.1.0-beta.2
   ```

   Set `ISCC_PATH` when required. The installer is named
   `Scout-<version>-windows-x64.exe`; it and `checksums.txt` are written to
   `installer/output/`. The current installer creates UI shortcuts but does not
   add the CLI to `PATH`.
8. Test on clean Windows 10/11 VMs: install without developer tools/admin rights; first launch; Codex-only and Claude-only setup; missing/invalid Adzuna; supervised/scheduled scans; missed-run/overlap/timeout; upgrade; and uninstall preserving the workspace.
9. Publish installer, checksum, licence, release notes, known unsigned/SmartScreen status and supported-version statement through the public repository's release workflow.

## Required privacy review

Search tracked files, staged output, installer contents and all public Git objects for real names, email/phone/address/postcode, employers, CV phrases, salaries, opportunity IDs and secret assignments. Use synthetic screenshots and fixtures only. If a secret entered any commit, rotate it and rewrite the unpublished clean-history branch before sharing.

The release audit detects configured personal markers and likely secret assignments, but it is not proof of anonymity. Manual review remains mandatory.

## Versioning and rollback

Use semantic application versions and explicit workspace `schemaVersion`. Release notes must identify migrations, privacy/network changes, provider/source changes and manual actions. Retain the previous installer and checksums for rollback, but never publish a private workspace or its backups.

The first beta remains unsigned until a certificate and secure signing pipeline exist. Checksums verify bytes only; they do not provide publisher identity.
