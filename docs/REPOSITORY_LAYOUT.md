# Scout repository layout

Scout deliberately separates public application code from private career data.

| Repository | Visibility | Purpose | Put future work here? |
| --- | --- | --- | --- |
| [`oliver-hitchings/Scout`](https://github.com/oliver-hitchings/Scout) | Public | Canonical application source, UI, installer, tests, templates and public documentation | **Yes — all application development starts here.** |
| [`oliver-hitchings/scout-workspace`](https://github.com/oliver-hitchings/scout-workspace) | Private | The user's CV, profile, calibration, opportunity tracker, reports and application material | **Yes — only for private search data and its history.** |
| `oliver-hitchings/StartupFinder` | Private | Legacy mixed-history development archive and the `agent/scout-beta-2` safety branch | **No — do not start new development here.** |

The installed application under `%LOCALAPPDATA%\Programs\Scout`, `/Applications/Scout.app`, or `/opt/scout` is a build of the public `Scout` repository. It reads private data from the user's `Documents/Scout Workspace`; it is not another source repository.

## Rules for agents

1. For UI, server, installer, provider, test, template or public-documentation changes, clone or update `oliver-hitchings/Scout` and work there.
2. For job searches, CV changes, scoring calibration, tracker updates, reports or application material, work only in `oliver-hitchings/scout-workspace` or its local checkout.
3. Never copy private workspace content or history into `Scout`, including in tests, screenshots, issues or commit history. Use synthetic fixtures.
4. Do not develop in or publish `StartupFinder`. Consult it only when recovering historical work that is absent from `Scout`, then manually port the smallest privacy-safe change.
5. Before pushing, verify the destination remote and visibility. The public repository must pass the release audit.

