# Documentation maintenance

Scout is shared with people who may not know its history or internal terminology. Current documentation must describe the product that exists now, give a clear next action, and keep private workspace data out of the public repository.

## Document roles

- `README.md` is the short public introduction and first decision point.
- `docs/README.md` is the documentation index and recommended reading path.
- Installation and operations guides are current instructions, not release diaries.
- `docs/releases/` is immutable historical context for a specific release.
- GitHub issues and pull requests track unfinished work. Do not create root-level TODO, handoff, acceptance, or implementation-plan documents.
- Code, configuration schemas, command help, and tests are authoritative when prose disagrees.

Keep one canonical explanation for each subject. Link to it instead of copying large procedures into several files.

## Required documentation impact review

For every user-facing change, check whether it affects:

- installation, upgrade, rollback, or uninstall steps;
- commands, flags, paths, ports, environment variables, or configuration;
- the setup wizard, settings, reports, status, errors, or recovery;
- supported platforms, providers, sources, schedules, or network access;
- security, privacy, backup contents, credentials, or repository visibility;
- screenshots, examples, release packaging, or troubleshooting; and
- the README, documentation index, release notes, and in-app help text.

Update affected documentation in the same pull request as the implementation. Add a release note for user-visible changes. Remove completed plans and obsolete workarounds instead of leaving them beside current instructions.

## Writing rules

- Write for a first-time user. Define Scout-specific terms at first use.
- Lead with the outcome, then give numbered steps and a verification step.
- Clearly distinguish defaults, recommendations, and required settings.
- Prefer version-neutral instructions. Exact versions belong in historical release notes, checksums, migration notes, and genuinely version-specific compatibility guidance.
- Use placeholders such as `OWNER`, `HOSTNAME`, and `YOUR_WORKSPACE` instead of personal names, private repository URLs, IP addresses, or machine paths.
- Use absolute dates when a date matters.
- Do not promise changing third-party prices, plans, limits, or behaviour. Link to the provider's current official documentation.
- Use descriptive link text and meaningful headings. Do not rely on colour, position, or screenshots alone.
- Keep examples safe to copy. Never include credentials, tokens, recovery passphrases, private keys, CV content, tracker data, reports, or other private workspace material.

## Public-repository privacy scrub

Before committing documentation or examples, search for:

- home-directory paths and usernames;
- private repository names or clone URLs;
- VPS addresses, Tailscale names, IP addresses, and account identifiers;
- email addresses, access tokens, API keys, SSH keys, and passphrases;
- real CV, profile, opportunity, report, application, or chat content; and
- screenshots or logs containing any of the above.

Use synthetic examples when a realistic example is needed. If private material is found, remove it from the change and follow the security process if it was committed or published.

## Verification

Run the normal test suite before merge:

```powershell
npm test
```

Documentation checks validate local Markdown links, required maintenance references, obsolete-file removal, mojibake, stale version labels in current guides, and common private-path leaks. Also read the rendered Markdown from the perspective of a new user; automated checks cannot judge whether a walkthrough is understandable.

For a release, build the package and verify that every relative link in the packaged README resolves inside the package.

## Maintenance checklist

- [ ] Current behaviour and defaults match the implementation.
- [ ] A new user has one clear entry path and a verification step.
- [ ] Completed TODOs, old acceptance notes, and obsolete workarounds are removed.
- [ ] Current guides are not unnecessarily pinned to a release number.
- [ ] Public examples contain no private workspace or operator information.
- [ ] Added, moved, and removed documents are reflected in navigation and release packaging.
- [ ] Relative links and documentation tests pass.
- [ ] User-visible changes have release notes.
