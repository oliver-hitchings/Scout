# Headless and household operation

- Added dedicated-user Linux service/timer examples and install, upgrade, complete backup and restore guidance.
- Added local-only, read-only schema-v1 health and dashboard-summary endpoints, with bounded match projection and no CV/profile text.
- Added isolated household create/list/switch commands. Selection applies to the next process; running instances retain explicit workspace boundaries.
- Added owner-configured command/webhook delivery for the existing alert/digest outbox, disabled by default and usable without a tray. Successful sends record normal receipts; failed sends remain pending.

- Household/headless schedule controls direct the owner to per-person system timers and reject desktop-native mutations before any system command, preventing collisions across people.
