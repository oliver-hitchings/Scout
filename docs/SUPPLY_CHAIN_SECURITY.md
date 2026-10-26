# Release package verification and signing

Scout publishes SHA-256 checksums and GitHub artifact attestations for packages built by the current tagged-release workflow. New releases also require an owner-signed release manifest. Verify the signature, checksum and attestation before installing a package. The checksum detects changed bytes; the attestation links those bytes to the release workflow in `oliver-hitchings/Scout`.

Windows and macOS packages remain operating-system unsigned. Windows SmartScreen and macOS Gatekeeper therefore cannot yet identify Scout through an Authenticode or Apple Developer ID publisher certificate.

## Signed manifest and installer preflight

The updater requires `release-manifest.json` and its detached Ed25519
`release-manifest.sig`. The manifest binds the repository, exact release version,
and each package's filename, byte length and SHA-256. Scout checks a locally
bundled public key and its revocation list before requesting installer bytes.
Unknown, revoked, missing, malformed, oversized or altered signing metadata
blocks the download. Streamed byte limits, SHA-256 verification and atomic
publication remain required after signature verification. Unsigned older
releases can still be inspected on GitHub but cannot be downloaded by Scout.

Before manually running an installer, use the same verifier from an existing
trusted Scout installation or a separately verified source checkout:

```sh
node tools/release-signing.mjs verify --package Scout-<version>-<platform-package> \
  --manifest release-manifest.json --signature release-manifest.sig \
  --version <version>
```

Run the native installer only after that command succeeds. This preflight does
not replace Authenticode or Gatekeeper and cannot stop a user from bypassing it
and opening an installer directly. Obtain Scout's verifier and trusted public
keys independently of the package being checked. An explicit `--trust-file`
may select an independently authenticated trust JSON file for offline use;
never trust a key merely because it arrived beside a downloaded installer.
There is no environment or network override for the updater's bundled trust.

The initial `ui/lib/releaseKeys.json` intentionally contains no public keys.
**Owner enrollment is required before production update downloads or signed
publication can succeed.** CI generates a throwaway Ed25519 key in a temporary
directory, verifies real signed synthetic installer bytes, then deletes the key.
No test or production private key is committed or packaged.

## Owner key creation, enrollment, rotation and revocation

1. On the owner's trusted signing machine, outside the repository and workspace,
   create an Ed25519 key. Restrict the directory and private file to the owner:

   ```sh
   umask 077
   openssl genpkey -algorithm ED25519 -out OWNER_PRIVATE_SIGNING_KEY.pem
   openssl pkey -in OWNER_PRIVATE_SIGNING_KEY.pem -pubout -out OWNER_PUBLIC_SIGNING_KEY.pem
   ```

2. Keep the private key in the owner's protected secret store with a separate
   encrypted recovery copy. Never add it to Git, a workspace, CI output or an
   artifact. Compute the public key ID as SHA-256 of its SPKI DER encoding:

   ```sh
   openssl pkey -pubin -in OWNER_PUBLIC_SIGNING_KEY.pem -outform DER | openssl dgst -sha256
   ```

3. In a separately reviewed change, add only `{ "keyId": "<64-hex-public-key-id>",
   "publicKey": "<PEM-public-key>" }` to `keys` in `ui/lib/releaseKeys.json`.
   Keep `schemaVersion: 1` and `revokedKeyIds: []`. Verify the fingerprint
   through a separate trusted channel. The owner controls the identity and
   review; an automated agent must never invent a production identity.
4. Configure the protected GitHub Environment `release-signing`, required owner
   approval and restricted release-tag access. Only that environment receives
   `SCOUT_RELEASE_SIGNING_KEY`. The publication job writes it to a private
   temporary file, signs all packages, verifies them against the enrolled
   bundled public key and removes the file on exit. A missing or mismatched key
   fails publication closed. Release-candidate tags containing `-rc` neither
   deploy nor publish.
5. For offline signing of a fresh artifact directory:

   ```sh
   node tools/release-signing.mjs sign --directory RELEASE_ARTIFACTS \
     --version <version> --key-file OWNER_PRIVATE_SIGNING_KEY.pem
   ```

   Preserve `checksums.txt`; the updater requires it to agree with the signed
   manifest. Ship both manifest files beside the immutable packages.
6. To rotate, ship the new public key in a release signed by the still-trusted
   old key, allow installations to receive the trust update, then switch the
   protected signing secret. Retain old public keys only for the documented
   transition period. Record key IDs and activation dates in public release
   notes, never private key material.
7. On compromise, disable publication, remove the old active key, append its
   ID to `revokedKeyIds`, rotate the secret and publish an independently
   authenticated replacement installer and security advisory. Old installed
   clients cannot learn a new revocation list through untrusted metadata:
   affected owners must install the trusted replacement out of band. Never
   move an existing tag or claim revocation retroactively secures old clients.

Signing is additive to the F-1 sealed packaging/publication controls in PR #84.
Those controls remain a separate release gate and are not replaced by a valid
manifest signature.

## Verify a downloaded package

1. Download the package, `checksums.txt` and `checksums.intoto.jsonl` from the same GitHub release.
2. Verify the package digest against `checksums.txt`:

   **Windows PowerShell**

   ```powershell
   Get-FileHash .\Scout-<version>-windows-x64.exe -Algorithm SHA256
   Get-Content .\checksums.txt
   ```

   **macOS**

   ```sh
   shasum -a 256 Scout-<version>-macos-<architecture>.dmg
   grep 'Scout-<version>-macos-<architecture>.dmg' checksums.txt
   ```

   **Linux**

   ```sh
   sha256sum --check --ignore-missing checksums.txt
   ```

   Compare the filename and the complete hexadecimal digest. Checksums verify bytes, not publisher identity, so continue with the attestation check.
3. Install the [GitHub CLI](https://cli.github.com/) and verify the package against Scout's public repository:

   ```sh
   gh attestation verify Scout-<version>-<platform-package> \
     --repo oliver-hitchings/Scout
   ```

4. Confirm that verification reports `oliver-hitchings/Scout` as the source repository. Stop if the checksum, repository identity or attestation verification differs.

An older release without `checksums.intoto.jsonl` predates this control. Its checksum can still detect changed bytes, but it has no Scout release-workflow attestation.

## Offline verification

Prepare the verifier on a trusted connected machine:

```sh
gh attestation trusted-root > trusted_root.jsonl
```

Transfer the package, `checksums.txt`, `checksums.intoto.jsonl` and `trusted_root.jsonl` to the offline machine through the approved path. After checking the checksum, verify:

```sh
gh attestation verify Scout-<version>-<platform-package> \
  --repo oliver-hitchings/Scout \
  --bundle checksums.intoto.jsonl \
  --custom-trusted-root trusted_root.jsonl
```

Refresh `trusted_root.jsonl` on a connected trusted machine for each new release or after a GitHub/Sigstore trust-root change. Offline verification proves against the captured trust state; it cannot discover later revocation or incident information by itself.

## Signing identity and ownership

The project has no long-lived project signing key for these attestations. For a tagged release, GitHub Actions issues the exact release workflow a short-lived GitHub OIDC identity. `actions/attest` obtains an ephemeral Sigstore signing certificate, records the attestation in the public transparency log and returns the bundle published with the release.

The repository owner controls who can approve and change the tagged-release workflow. The `publish` job alone receives `id-token: write` and `attestations: write`; build jobs and workflow-dispatch rehearsals cannot publish releases or attestations. Every subject digest is generated from `checksums.txt`, verified locally, verified again with `gh attestation verify`, and only then published.

Every reusable action in a workflow that receives secrets is pinned to a reviewed
immutable full commit SHA, with its major release line retained only as a comment
for maintenance. This includes both jobs in CI, tagged-release builds and
publication, and workspace repair. Tests discover every workflow containing a
secret reference and reject mutable action references throughout it. Updating
one of those SHAs requires a reviewed dependency change and another
release-candidate rehearsal.

Allowlisted application and public-source trees omit nested `node_modules`
directories, including differently cased names. Production dependencies enter a
release only through the separate top-level dependency staging pass, selected
from the lockfile. That pass retains required nested production dependencies and
the existing private-file filters; the staged-tree privacy audit still inspects
their contents.

The audit has one narrowly reviewed metadata exception for Ajv's pinned security
meta-schema: the `advert-body` heuristic at line 5 of exactly
`node_modules/ajv/dist/refs/json-schema-secure.json` and its `lib/refs` copy,
beneath only these app roots relative to the audited stage:

- `app` (common stage and Windows installer);
- `deb/opt/scout/app` (Linux Debian package);
- `Scout-<package-version>-linux-x64/app` (Linux portable package, using the
  exact version from the auditor's own package); and
- `dmg-root/Scout.app/Contents/Resources/app` (macOS disk-image bundle).

Both must have SHA-256
`b7840b4f1526eee47ac19780906a436d0c39df2aa3d505388caf18864085a421`.
This is public schema-description text, not an advert. A byte change, different
path, additional parent directory or different portable version removes the
exception. The audit still inspects the entire stage, including files outside
these roots. Personal-marker, credential, prompt, transcript,
private-path and all other checks still apply. Dependency upgrades must review
any changed metadata before updating this exact digest.

CI runs `npm audit --omit=dev` against the locked production tree and fails if
the registry reports a known vulnerability. Ajv is pinned to the patched
8.20.0 release; Mammoth's compatible XML-parser dependency is locked to
`@xmldom/xmldom` 0.8.15. These resolve the reported Ajv `$data` ReDoS and
xmldom XML injection, parser-time and memory-consumption advisories. The two
reviewed Ajv meta-schema files remain byte-for-byte identical after this update;
their digest exception is unchanged. Use `npm ci` to reproduce the reviewed
dependency tree before testing imports and provider validation.

Release staging refuses symbolic links for both copied trees and individually
allowlisted inputs, including a link in any ancestor component, except for the
single exact DMG layout entry `dmg-root/Applications -> /Applications`. Regular files
are opened without following links; ancestor and opened-file identities are
checked before and after bytes are read. The staged-tree privacy audit applies
the same component and identity checks and fails on any other symlink. Directory
entries are bound to their enumerated identities before recursive copying.
Windows, macOS and Linux compiler or launcher inputs are copied through this
verified reader into the fresh stage, checked for change across compilation,
and the finished platform payload is audited before installer or archive
creation. The conventional macOS `/Applications` DMG link is added only after
the symlink-free `Scout.app` payload passes its audit. The finished DMG layout,
including that exact link and its target, is then content-snapshotted and bound
into the immutable audit digest before packaging; every other link still fails.

Attestation establishes build provenance, not software safety. It does not prove that the source or resulting package is free of vulnerabilities or malicious behaviour.

## Rotation and dependency maintenance

There is no private attestation key to rotate. GitHub and Sigstore rotate the short-lived issuing infrastructure and trusted roots. Maintainers must:

1. update `actions/attest` only through a reviewed pull request;
2. run release-workflow tests and a release-candidate rehearsal after an update;
3. retain the published bundle with each immutable release; and
4. refresh offline trusted-root files rather than assuming an old root remains current.

If the repository, workflow or GitHub identity is suspected to be compromised, disable release publication, revoke affected GitHub sessions and tokens, rotate any unrelated environment secrets, and investigate the transparency-log evidence. Mark the affected release as compromised with a security advisory and prominent release notice. Never move, delete or recreate its tag. Publish a bumped replacement version after the workflow and repository are trusted again. Keyless attestation entries remain historical evidence; they cannot be erased or made trustworthy by rotating a non-existent project key.

## Remaining platform-signing work

Attestation does not replace native package signing. Completing operating-system publisher identity requires operator-controlled credentials and policy that are deliberately absent from the public repository:

- acquire an Authenticode code-signing certificate for the chosen Windows publisher identity, protect it in a release-only GitHub Environment, define approval and renewal procedures, and validate the signed installer on a clean Windows system;
- enrol the chosen Apple publisher identity, provision Developer ID Application signing and notarisation credentials in a release-only GitHub Environment, define approval and renewal procedures, and validate Gatekeeper assessment on a clean macOS system; and
- document the authorised legal/publisher identity, credential custodians, expiry monitoring, emergency revocation and replacement process before enabling either signing path.

Until those decisions and credentials exist, releases must continue to say that Windows and macOS packages are unsigned and users should expect platform warnings.
