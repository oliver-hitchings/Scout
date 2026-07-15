# Scout

Scout is a local-first, AI-assisted opportunity finder. It searches configured job sources, applies your own exclusions and scoring rubric, keeps a private opportunity tracker, and drafts material for you to review.

Scout never submits an application or sends outreach. Your CV, profile, tracker, reports, applications, chat history, and source credentials live in a separate private workspace.

**New user?** Choose [Windows](docs/INSTALL_WINDOWS.md), [macOS](docs/INSTALL_MACOS.md), or [Linux](docs/INSTALL_LINUX.md). Scout beta packages are unsigned and require your own authenticated Codex or Claude provider account.

> **Repository note:** this is the canonical public Scout application repository. Personal CV, profile, tracker, report and application data belongs only in the separate private workspace repository. See [Repository layout](docs/REPOSITORY_LAYOUT.md).

## Status

Scout `0.1.x` is a cross-platform public beta. Windows SmartScreen and macOS Gatekeeper may warn because packages are unsigned. Verify the SHA-256 checksum published with every release.

## What Scout does

- Uses either the Codex CLI or Claude Code as the AI provider; a second provider is optional.
- Imports selectable text from PDF, DOCX, Markdown, or plain-text CVs.
- Interviews you to build a factual profile, configurable search lanes, exclusions, and a 100-point scoring rubric.
- Offers optional Google XYZ evidence questions and a separate natural-voice review when tailoring a CV.
- Builds searches from the CV and preferences you explicitly approve; it does not inspect unrelated AI conversations or provider history.
- Searches configured ATS boards and public sources. Adzuna is optional.
- Tracks evidence, verdicts, follow-ups, applications, and dated reports in a private local Git repository.
- Keeps real recruiter correspondence, calls, contacts and related vacancies together in a company relationship history while leaving each AI job chat role-specific.
- Optionally backs that workspace up to a private GitHub repository and restores it on another computer; local-only use remains the default.
- Runs supervised or scheduled daily scans on Windows.
- Keeps model choice optional, using the provider's supported default unless you select an override.

Scout is not an auto-apply tool. It does not invent qualifications, infer positive facts from missing evidence, or send anything on your behalf.

## Five-minute start

1. Install Scout from the release page and launch it. For a source checkout, see [Development setup](#development-setup).
2. Create a new local workspace or restore an existing Scout workspace from private GitHub backup. The default local path is `%USERPROFILE%\Documents\Scout Workspace`.
3. Install and sign in to either Codex or Claude, then let Scout verify it.
4. Import a CV, answer the setup questions, and generate one bounded proposal. Review every staged file before explicitly activating it.
5. Optionally add Adzuna credentials, run `scout doctor`, then perform one supervised scan.
6. Optionally connect a private GitHub repository for automatic backup. Git and Git Credential Manager are required only for backup/restore.
7. Only after reviewing that scan, enable the daily schedule.

The full walkthrough is in [Quick Start](docs/QUICK_START.md). If you want an AI assistant to guide setup, use [AI Setup](docs/AI_SETUP.md).

## Application and workspace are separate

```text
Scout application                  Private Scout workspace
-----------------                  -----------------------
UI, CLI, templates                 workspace.json
provider adapters                  profile/ and cv/
managed skills                     data/ and reports/
release documentation              applications/ and imports/
                                    .env, logs/, private Git history
```

Application upgrades replace application files and managed instructions. They do not delete or publish the workspace. Uninstalling Scout leaves the workspace in place.

Private GitHub backup is optional. Scout verifies that a repository is not public before connecting it, keeps normal career files readable in that private repository, and additionally encrypts credentials, generated PDF/DOCX files and recovery state. Keep the passphrase or one-time emergency recovery key safe. Codex and Claude sign-in state remains provider-owned and is not copied.

You can select a non-default workspace with either:

```powershell
$env:SCOUT_WORKSPACE = 'D:\Private\My Scout Workspace'
scout doctor
```

or:

```powershell
scout doctor --workspace 'D:\Private\My Scout Workspace'
```

See [Privacy and Data](docs/PRIVACY.md) and [Configuration](docs/CONFIGURATION.md) before moving or backing up a workspace.

## Core commands

```text
scout doctor [--workspace PATH]
scout workspace init [--workspace PATH]
scout workspace migrate --from PATH --to PATH
scout cv quality <application-slug> [--workspace PATH]
scout scan --provider codex|claude --mode primary|second-pass
scout schedule install|status|remove|run-now
```

Run `scout` without arguments for command help.

## Development setup

Requirements: Windows 10/11, Node.js 24 LTS, Git for source development, and at least one authenticated compatible provider CLI.

```powershell
git clone https://github.com/oliver-hitchings/Scout.git
cd Scout
npm install
$env:SCOUT_WORKSPACE = "$HOME\Documents\Scout Workspace"
node tools/scout.mjs workspace init
npm test
npm start
```

Open `http://127.0.0.1:8459`. Use a synthetic workspace for development and never copy private workspace content into tests, screenshots or commits.

## Documentation

- [Quick Start](docs/QUICK_START.md)
- [Install Scout on Windows](docs/INSTALL_WINDOWS.md)
- [Install Scout on macOS](docs/INSTALL_MACOS.md)
- [Install Scout on Linux](docs/INSTALL_LINUX.md)
- [AI-assisted setup and retuning](docs/AI_SETUP.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Privacy and data handling](docs/PRIVACY.md)
- [CV evidence and quality](docs/CV_QUALITY.md)
- [Codex and Claude providers](docs/PROVIDERS.md)
- [Adzuna and other sources](docs/ADZUNA_AND_SOURCES.md)
- [Scheduled scans](docs/AUTOMATION.md)
- [Upgrades and migrations](docs/UPGRADES.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Known issues](docs/KNOWN_ISSUES.md)
- [Release process](docs/RELEASE.md)
- [Repository layout and development boundaries](docs/REPOSITORY_LAYOUT.md)

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Use synthetic fixtures only; never contribute a real CV, profile, tracker, report, credential, or application.

Report vulnerabilities through the private route described in [SECURITY.md](SECURITY.md), not in a public issue.

Scout is available under the [MIT License](LICENSE).
