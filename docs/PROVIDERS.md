# Codex and Claude Providers

Scout needs one installed and authenticated provider CLI. Codex and Claude are supported; a second provider is optional and can perform a second-pass review.

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

Then restart Scout so it inherits the updated `PATH`, and run `scout doctor`. macOS/Linux launchers include common Homebrew, `/usr/local/bin`, `$HOME/.local/bin` and npm-global locations; custom locations still require PATH configuration. On Windows Scout resolves npm-installed `.cmd` shims safely.

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
- **Works in terminal, not Scout:** restart Scout/Windows after `PATH` changes and check whether the CLI is installed for a different Windows user.
- **Model rejected:** clear `ai.model` and use the provider default.
- **Corporate/network restriction:** test the provider directly and follow its proxy/firewall documentation; do not paste credentials into Scout logs or issues.

Provider output may contain private prompt context. Keep workspace `logs/` private when requesting support.
