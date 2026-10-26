# Settings input preservation

Search-profile loading no longer replaces an unsaved search-mode choice. Provider
sign-in status updates also preserve job-work model names entered in Settings.
The section's Save button records the user's current values.

Deterministic browser regressions hold the initial responses until after a user
edits the controls, then verify the saved request after those responses arrive.
