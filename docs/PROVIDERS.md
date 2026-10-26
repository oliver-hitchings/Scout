# AI providers

Scout needs one configured provider: Codex, Claude, or a local OpenAI-compatible model server. A second provider is optional and can perform a second-pass review. Local models connect directly over HTTP and need neither provider CLI.

## Local OpenAI-compatible model

On the Scout host, open **Settings → AI providers**, choose **Local OpenAI-compatible**, and enter your model server's base URL (including `/v1` when required) and exact model name. The host is the computer running Scout. Remote dashboard sessions can use the approved model but cannot change its endpoint, model, key-file selector or transport limits; the fields are read-only there.

Leave the API-key file blank if the server needs no key. Otherwise use a regular file under the selected workspace's private `.scout` directory, such as `.scout/model-key`. Relative paths resolve from that workspace; absolute paths inside the same directory also work. A Linux server can instead use the explicit system directory `/etc/scout/secrets`. Other files, linked ancestors, symlinks and non-regular files such as named pipes are rejected. Restrict the file to the Scout service account and back it up through your own secret-recovery process; do not commit it. Scout reads at most 8 KiB by descriptor, rechecks the owning directory and file identity, and never copies the key into configuration, provider health, run journals or diagnostics. The path stays private workspace configuration visible to its owner. Restoring on another computer needs that computer's endpoint and credential-file setup.

Use HTTPS for a model server on another computer. Plain HTTP is accepted only for `localhost`, loopback addresses, RFC1918 IPv4 addresses or numeric tailnet addresses (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`), including equivalent canonical IPv4-mapped forms. Public HTTP endpoints and HTTP DNS aliases are refused. Remote model settings show a warning because that server receives CV/job text and any configured key. Private HTTP traffic is unencrypted; use it only on a network you trust, or choose HTTPS. Existing key selectors outside the approved directories must be moved and selected again on the Scout host before provider work can resume. An existing public HTTP endpoint stays visible for local correction but cannot execute requests or be saved again; change it to HTTPS or an allowed private numeric address.

For manual configuration, merge this into your private `workspace.json`:

```json
{
  "ai": {
    "provider": "local",
    "local": {
      "baseUrl": "http://localhost:8000/v1",
      "model": "YOUR_MODEL",
      "apiKeyFile": null,
      "timeoutMs": 120000,
      "retries": 1
    }
  }
}
```

Scout sends non-streaming chat-completion requests to `BASE_URL/chat/completions`. The entire operation has a default 120-second deadline, including retries and response reading. `timeoutMs` accepts 1 ms to 30 minutes; `retries` accepts zero to two and defaults to one. Retries cover bounded transient network failures and HTTP 408/502/503/504 responses. Authentication failures, rate limits, invalid outputs and other HTTP errors are returned without a transient retry. Redirects are refused, preventing credentials or career context from being forwarded to a different endpoint. The endpoint rules above apply to every request, including health probes and retries.

Structured setup, scans and fit assessments first request strict JSON-schema output. An explicit schema/response-format rejection permits one plain-JSON attempt. Both paths parse the complete response without extracting Markdown or partial JSON and validate the same schema in Scout. Invalid or truncated output never becomes a successful assessment. Existing bounded per-job repair/retry rules still apply after adapter failure.

Configuration/key presence is labelled unverified. Startup, periodic scheduled checks and manual/scheduled scan preflight use a fixed structured completion with a maximum 10-second deadline; only a valid response establishes verified health. An unreachable server, rejected key, rate limit and invalid response retain separate failure states. Explicit HTTP 401/403 authentication failures and 429 rate limits remain authoritative even if the server's error body is oversized or stalls. Failures enter Scout's durable notification outbox, deduplicated for the same failure episode; interrupted publication is retried without duplicating the warning. Scout does not choose another provider or model automatically. A small local model can pass a health probe yet still fail a complex assessment; use a model that can reliably follow the assessment schema.

Local chat retains the conversation in the private workspace and sends bounded recent conversation context with each request. It answers questions and produces text drafts; it has no filesystem, tool or CLI session, so it cannot directly edit CV files or offer CLI-session handoff. Structured setup and scans use Scout's existing trusted write path.

Reopening a local conversation keeps its selected provider and saved messages,
so you can continue without choosing a provider again. If the model server rejects
authentication, the failed message stays saved with **Resend with Local model**.
Check the server and API-key file in **Settings → AI providers**, then click the
resend button when ready. Opening the chat or restoring provider health never
resends the message automatically. Each saved resend action can run only once.

Run a local scan with `scout scan --provider local --mode primary`. Scheduled jobs accept `"provider": "local"`; a blank scan model uses `ai.local.model`. Exact namespaced model names are supported in the picker, queue, recovery and assessment provenance. Changing the local endpoint or configured model invalidates incompatible queued/recovered scan work.

New scan history retains the exact model name, including its namespace. A model change can then reassess the strongest earlier rejections under Scout's existing per-scan limit; the unchanged model leaves those rejections alone. Older records with missing assessment provenance remain legacy history and are not rewritten.

## Codex and Claude

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

Provider checks run asynchronously, share an in-progress probe and keep a short-lived result cache. A slow or hung provider CLI may leave Settings showing its checking state until the bounded probe finishes, but it does not block the dashboard or unrelated Scout API requests. After signing in or upgrading a CLI, wait a few seconds and refresh provider status again.

Scout uses the provider CLI, not a desktop application's embedded session. If Codex is installed but shown as signed out, run `codex`, complete sign-in, and confirm `codex login status` in the same host account before refreshing Scout.

While guided sign-in, verification or explicit Claude credential clearing is
active, Scout blocks new chat, onboarding and scan work for that same provider
before starting a provider process. Work using the other provider remains
available. Wait for the bounded sign-in result, then retry the blocked action;
Scout does not resend it automatically, and a late result cannot replace the
current login-in-progress health state.

Scout separately reports installation, authentication and bounded structured-output compatibility. An authenticated CLI that is too old for schema-constrained output remains disabled until it is upgraded from the provider's official installer. Bounded setup, scans and fit assessments use one non-resumable turn with no provider file-writing tools; Scout's trusted runtime validates and writes the workspace artifacts. Claude and Codex use the same strict assessment schema: providers supply nuanced fit and evidence, while Scout retains numeric scoring, category, deterministic-exclusion, ordering and source-coverage authority.

On Windows, Codex runs under its documented `unelevated` sandbox. Scout never uses Codex's unrestricted filesystem mode.

## Configure

Choose the primary provider in **Settings → AI providers**. The same screen accepts an optional model identifier for Codex and Claude independently. Those choices apply to individual job conversations, CV tailoring, fit assessment and interview preparation. Leave either field blank to use that provider's current default.

When a new conversation starts, Scout shows a model picker. Codex models come from the installed CLI's bounded model catalogue when that capability is available; Scout labels this as a refreshed catalogue. If catalogue refresh is unavailable or fails, Scout clearly labels its short built-in list as fallback suggestions whose availability is unknown. Claude suggestions are also labelled as fallback because its CLI does not currently expose a model catalogue. A saved model missing from a refreshed catalogue, or one the provider has rejected, remains visible for diagnosis but cannot be selected again.

**Other…** is the advanced escape hatch for an exact provider model ID. Scout checks its syntax locally, but the provider remains the authority on whether it is accepted. Raw provider catalogue output, executable paths, account details and diagnostics are never sent to the browser.

For a resumable Codex conversation, Scout checks the device-local `codex://` handler before enabling **open in Codex**. A click is treated only as an attempt because browsers cannot confirm that a desktop app opened. Scout therefore keeps the exact technical task ID visible and copyable with resume instructions. In remote Scout sessions, the server host's handler is deliberately ignored: the integration must exist on the browser's own device, so copy/resume is used instead.

Scan models are separate. Choose an optional model for each job under **Settings → Scans & schedule**. The supervised scan uses the model shown for the primary scan row, and an enabled daily job saves its own model. Leaving it blank uses the provider default rather than the job-conversation model.

In `workspace.json`, the job-work choices are `ai.models.codex` and `ai.models.claude`; scheduled scan choices are stored on each `schedule.jobs[]` item. The singular `ai.model` field is retained only as a compatibility fallback for older workspaces.

Run a primary scan with:

```powershell
scout scan --provider codex --mode primary
```

For a one-off explicit override, add `--model MODEL`. Omit it to use the configured compatibility/default behaviour.

`second-pass` is a verification workflow, not an independent licence to add weak or unverified results.

## Common failures

- **Not installed:** confirm the command works in a new PowerShell window and its directory is on the user `PATH`.
- **Installed but unauthenticated:** run the provider's status command, complete its official login, then retry.
- **Signed in but update required:** update the official CLI, verify `--output-schema` (Codex) or `--json-schema` (Claude) support, and refresh Scout.
- **Works in terminal, not Scout:** restart Scout/Windows after `PATH` changes and check whether the CLI is installed for a different Windows user.
- **Model rejected or saved default unavailable:** choose a model marked available in the conversation picker, or clear the relevant model field in **Settings → AI providers** or **Settings → Scans & schedule**. Do not assume a fallback suggestion is currently available; the provider validates it when the conversation starts.
- **Corporate/network restriction:** test the provider directly and follow its proxy/firewall documentation; do not paste credentials into Scout logs or issues.

Provider output may contain private prompt context. Keep workspace `logs/` private when requesting support.
