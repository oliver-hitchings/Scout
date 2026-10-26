# Reconnect an expired Codex or Claude session

Scout uses the Codex and Claude command-line sign-ins on the computer or server that runs it. Those sessions can expire or be revoked. This guide shows how to notice that, reconnect, and catch up on any scan that was blocked meanwhile. It works the same on the host itself and from your phone or laptop over [private remote access](PRIVATE_REMOTE_ACCESS.md).

## What you will see

When a provider that Scout uses (your chosen provider or one used by an enabled daily scan) needs you to sign in again, an amber notice appears at the top of every dashboard tab:

> Claude sign-in has expired, so Claude work cannot run until you reconnect. Scheduled scans waiting: claude-primary (07:30).

It stays until the provider is signed in again. It names the provider and the scheduled scans that cannot run. A scheduled scan that finds the provider signed out stops before doing any work and is recorded as blocked; Scout never switches to the other provider on its own, and scans for the other provider carry on normally.

## Reconnect

1. In the notice, choose **Reconnect Claude** (or **Reconnect Codex**). Scout opens **Settings -> AI providers**.
2. Choose **Sign in to Claude with Scout** (or Codex) and follow the on-screen steps: open the provider's sign-in page, then enter the one-time code if Scout asks for it. You can cancel and retry at any time.
3. If the guided sign-in cannot finish, run the command shown on that screen in a terminal on the host instead. The [official Codex guide](https://developers.openai.com/codex/auth/) and [official Claude guide](https://code.claude.com/docs/en/authentication) describe both flows.
4. Close Settings. Scout re-checks the provider and the amber notice goes away.

Not ready to deal with it now? Choose **Remind me later**. The notice shrinks to a single line ("Claude still needs sign-in") that keeps its **Reconnect** button. A new sign-in failure after you have reconnected shows the full notice again.

## Catch up on blocked work

Scout does not replay blocked work by itself, because that spends your provider allowance. Once the provider is signed in again, the notice changes to "Claude is signed in again" and offers what was blocked:

- **Run missed scan now** starts the scheduled scan that was blocked, exactly as the scheduler would have. It appears only when the most recent run of that scheduled scan was blocked by the expired sign-in.
- **Retry now** runs a normal scan with the reconnected provider. It appears only when your most recent manual scan for that provider was blocked.

Both use the normal scan safeguards: only one scan runs at a time, and a second request waits or is refused rather than overlapping. **Not now** hides the notice until you reload the page; it returns if the work is still waiting.

A chat message that failed because of the expired session stays in the conversation, including after closing Scout. Once you have reconnected, choose **Resend with Codex** or **Resend with Claude** beside that saved message. Scout sends the same saved request only after you press the button, keeps one copy of your message, and refuses a second use of a completed resend. Writing a different message starts a new request.

An installed provider can show **sign-in found but not yet verified**. That means its local command found credentials; it does not prove the remote provider accepts them. A known remote sign-in failure stays authoritative through refreshes, local login checks and sign-in progress until a real remote check succeeds. Guided sign-in performs that check. If a manual terminal login leaves the warning in place, use guided sign-in to complete verification; refreshing local status alone cannot clear a rejected remote session.

## Check that it worked

1. The amber notice is gone, or reads "signed in again".
2. **Settings -> AI providers** shows the provider as signed in. Its card, sign-in panel and diagnostic readiness use the same health evidence.
3. After **Run missed scan now** or **Retry now**, the scan status at the top of the page shows the scan in progress, and the new run appears among the latest scan results.

If the notice returns straight away, the sign-in did not complete or the provider rejected it. Repeat the steps, and see [troubleshooting](TROUBLESHOOTING.md#scheduled-scan-does-not-run) and [AI providers](PROVIDERS.md) for other provider states such as a network problem, a rate limit or a CLI that needs updating.
