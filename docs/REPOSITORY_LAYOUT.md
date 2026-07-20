# Scout repository layout

Scout deliberately separates public application code from private career data.

| Repository or checkout | Visibility | Purpose | Put future work here? |
| --- | --- | --- | --- |
| This Scout application repository | Public | Application source, UI, installer, tests, templates, and public documentation | **Yes - all application development starts here.** |
| Your `scout-workspace` repository or local workspace | Private | Your CV, profile, calibration, opportunity tracker, reports, chats, and application material | **Yes - only for private search data and its history.** |
| Any legacy mixed-history archive | Private | Historical code mixed with personal workspace data | **No - do not start new development here.** |

The installed application under `%LOCALAPPDATA%\Programs\Scout`, `/Applications/Scout.app`, or `/opt/scout` is a build of the public `Scout` repository. It reads private data from the user's `Documents/Scout Workspace`; it is not another source repository.

## Rules for agents

1. For UI, server, installer, provider, test, template, or public-documentation changes, clone or update the public Scout application repository and work there.
2. For job searches, CV changes, scoring calibration, tracker updates, reports, chats, or application material, work only in the selected private workspace or its private backup repository.
3. Never copy private workspace content or history into `Scout`, including in tests, screenshots, issues or commit history. Use synthetic fixtures.
4. Do not develop in or publish a legacy mixed-history archive. Consult one only when recovering historical application work, then manually port the smallest privacy-safe change.
5. Before pushing, verify the destination remote and visibility. The public repository must pass the release audit.

