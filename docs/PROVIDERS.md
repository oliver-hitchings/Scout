# Codex and Claude Providers

Scout needs one installed and authenticated provider CLI. Codex and Claude are supported; a second provider is optional and can perform a second-pass review.

For Codex, use the current [official Codex CLI installation guide](https://developers.openai.com/codex/cli/) and select the macOS, Linux or Windows instructions for the host. After installation, open Terminal or PowerShell, run `codex`, complete its sign-in flow, and verify `codex login status`. Scout needs that authenticated CLI session; signing in to a desktop app alone does not authenticate the command-line provider.

Install each CLI only from its official provider documentation. Scout does not manage provider subscriptions, passwords or tokens.

## Verify outside Scout

```powershell
codex --version
codex login
codex login status
```

or:

```powershell
claude --version
claude auth login
claude auth status
```

Then refresh provider status in Scout. Scout checks standard Windows standalone, npm, Node.js and user-local locations directly, so a stale desktop `PATH` should not hide a normal installation. macOS and Linux checks include Homebrew, `/usr/local/bin`, `/usr/bin`, `$HOME/.local/bin`, `$HOME/.codex/bin`, `$HOME/.npm-global/bin` and `$HOME/bin`; custom locations still require PATH configuration.

Scout uses the provider CLI, not a desktop application's embedded session. If Codex is installed but shown as signed out, run `codex`, complete sign-in, and confirm `codex login status` in the same host account before refreshing Scout.

Scout separately reports installation, authentication and bounded structured-output compatibility. An authenticated CLI that is too old for schema-constrained output remains disabled until it is upgraded from the provider's official installer. Bounded setup, scans and fit assessments use one non-resumable turn with no provider file-writing tools; Scout's trusted runtime validates and writes the workspace artifacts.

On Windows, Codex runs under its documented `unelevated` sandbox. Scout never uses Codex's unrestricted filesystem mode.

## Configure

Set `ai.provider` to `codex` or `claude` in `workspace.json`. Leave `ai.model` as `null` unless you have a specific supported model requirement; provider defaults age better than hard-coded model names.

Run a primary scan with:

```powershell
scout scan --provider codex --mode primary
```

`second-pass` is a verification workflow, not an independent licence to add weak or unverified results.

## Common failures

- **Not installed:** confirm the command works in a new PowerShell window and its directory is on the user `PATH`.
- **Installed but unauthenticated:** run the provider's status command, complete its official login, then retry.
- **Signed in but update required:** update the official CLI, verify `--output-schema` (Codex) or `--json-schema` (Claude) support, and refresh Scout.
- **Works in terminal, not Scout:** restart Scout/Windows after `PATH` changes and check whether the CLI is installed for a different Windows user.
- **Model rejected:** clear `ai.model` and use the provider default.
- **Corporate/network restriction:** test the provider directly and follow its proxy/firewall documentation; do not paste credentials into Scout logs or issues.

Provider output may contain private prompt context. Keep workspace `logs/` private when requesting support.
