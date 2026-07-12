# Configuration Reference

`workspace.json` is the versioned, non-secret configuration for one private Scout workspace. Paths, CVs, reports and credentials must not be put in the application repository.

## Selecting a workspace

Precedence is `--workspace PATH`, then `SCOUT_WORKSPACE`, then the default `%USERPROFILE%\Documents\Scout Workspace`. Existing private source checkouts containing `data/opportunities.json` retain legacy in-place behaviour unless an explicit workspace is selected.

```powershell
$env:SCOUT_WORKSPACE = 'D:\Private\Scout Workspace'
scout doctor
```

## Schema version 1

```json
{
  "schemaVersion": 1,
  "locale": "en-GB",
  "currency": "GBP",
  "timezone": "Europe/London",
  "profile": { "displayName": "", "tone": "natural, direct and evidence-led" },
  "search": {
    "roleFamilies": [], "sectors": [], "locations": [], "exclusions": [],
    "salaryMinimum": null
  },
  "commute": {
    "origin": "", "mode": "either", "maxMinutes": 180,
    "includeUnknown": true
  },
  "ai": { "provider": null, "model": null },
  "schedule": { "enabled": false, "time": "07:30", "provider": null },
  "setup": { "completedAt": null }
}
```

- `locale`, `currency` and `timezone` are required strings. Use recognised BCP 47, ISO 4217 and IANA values.
- `profile.tone` guides drafts; it never authorises sending.
- Search arrays contain user-defined plain-text preferences. `salaryMinimum` is numeric or `null`; adverts with missing salary remain uncertain rather than passing automatically.
- `commute.mode` records the user's policy; `maxMinutes` is the allowed journey time and `includeUnknown` controls whether unverified journeys remain visible.
- `ai.provider` is `codex`, `claude` or `null`. Leave `ai.model` null to use the provider's current supported default. Explicit model identifiers may contain letters, digits, `.`, `_`, `:`, or `-` only.
- Schedule time uses 24-hour `HH:MM`. The provider must be installed and authenticated before installation.
- `setup.completedAt` is written by Scout when onboarding finishes. It prevents the first-run wizard reopening; use Settings to retune an existing workspace.

The profile narrative and scoring precedents live in `profile/context.md` and `profile/calibration.md`. Search categories, ATS portals and employer lists live under `data/`. Preserve dated history instead of replacing it.

Run `scout doctor` after edits. Do not store secrets in `workspace.json`; see [Privacy](PRIVACY.md).
