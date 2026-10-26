# Release key enrollment

Only the repository owner performs production key enrollment. Keep the private
Ed25519 key outside every checkout and workspace. Scout's public registry is
`ui/lib/releaseKeys.json`; it intentionally contains no enrolled key by default.
Until enrollment, the release workflow reports a clean skip of production
signing, tag deployment and publication, and the in-app updater rejects updates.
This permits a reviewed application merge; it does not clear the signed-release
or live-operator gates. Candidate `-rc` tags remain build-only.

CI runs `node --test tools/release-signing.test.mjs` explicitly on all four OS
runners. It generates temporary test keys, signs synthetic artifacts for all
five package formats, verifies each with isolated test trust, and rejects
modified packages, revoked keys and empty production trust. Test keys never
enter the bundled registry, artifacts or logs.

## Create the production key offline

Run these commands yourself in a trusted offline shell with OpenSSL installed.
Replace the directory with a location outside the application and workspace.
Do not run them in an automated coding or CI session. Store an encrypted offline
backup using your organization's secret-management procedure.

```sh
set -eu
umask 077
SCOUT_KEY_DIRECTORY=/absolute/private/release-key-directory
mkdir -m 700 "$SCOUT_KEY_DIRECTORY"
openssl genpkey -algorithm Ed25519 -out "$SCOUT_KEY_DIRECTORY/private.pem"
openssl pkey -in "$SCOUT_KEY_DIRECTORY/private.pem" -pubout -out "$SCOUT_KEY_DIRECTORY/public.pem"
chmod 600 "$SCOUT_KEY_DIRECTORY/private.pem"
```

`mkdir` must create a new directory; stop on an existing directory or any command
failure. The private file must never be committed, pasted into a terminal command,
printed, sent to an agent, included in a release payload or passed as an argument.
Transfer only the public file to the reviewed application checkout.

## Enroll the public key

From that checkout, set `SCOUT_PUBLIC_KEY_FILE` to the transferred public file,
then run this Node command. It reads only the public key, derives its SHA-256 SPKI
identifier and appends it without replacing existing or revoked trust.

```sh
set -eu
export SCOUT_PUBLIC_KEY_FILE=/absolute/path/to/public.pem
node --input-type=module <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import { signingKeyId } from './ui/lib/releaseManifest.mjs';
import { releaseSigningReadiness } from './tools/release-signing.mjs';
const file = 'ui/lib/releaseKeys.json';
const trust = JSON.parse(fs.readFileSync(file, 'utf8'));
releaseSigningReadiness(trust);
const publicKey = crypto.createPublicKey(fs.readFileSync(process.env.SCOUT_PUBLIC_KEY_FILE));
const keyId = signingKeyId(publicKey);
if (trust.revokedKeyIds.includes(keyId) || trust.keys.some((key) => key.keyId === keyId)) {
  throw new Error('Use a new key; this key is already enrolled or revoked');
}
trust.keys.push({ keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
releaseSigningReadiness(trust);
fs.writeFileSync(file, `${JSON.stringify(trust, null, 2)}\n`);
NODE
node tools/release-signing.mjs readiness
npm test
git diff -- ui/lib/releaseKeys.json
```

Review and merge only the public registry change through a focused PR. The
installed application trusts its bundled registry; it never downloads a new
trust registry to authorize an update.

## Set the protected signing secret

On the trusted machine holding the private key, use authenticated GitHub CLI.
Replace `OWNER/Scout` with the intended repository, and verify its protected
`release-signing` environment has owner reviewers and the intended release-ref
restrictions. Configure those rules before storing the secret.

```sh
set -eu
SCOUT_RELEASE_REPOSITORY=OWNER/Scout
SCOUT_KEY_DIRECTORY=/absolute/private/release-key-directory
gh api "repos/$SCOUT_RELEASE_REPOSITORY/environments/release-signing" >/dev/null
gh secret set SCOUT_RELEASE_SIGNING_KEY --repo "$SCOUT_RELEASE_REPOSITORY" \
  --env release-signing < "$SCOUT_KEY_DIRECTORY/private.pem"
```

The readiness job reads public trust without secrets or environment approval.
A non-revoked public key enables the protected signing job; it does not establish
that the private secret exists or matches. The job still fails closed if the
secret is missing, mismatched, malformed, or signature verification fails.
Never substitute `--trust-file` in production verification to bypass bundled trust.
Complete the protected [release rehearsal](RELEASE.md) before any publication.

## Rotate or revoke

For planned rotation, create a new pair offline and enroll its public key while
retaining the old public key. Release and install that trust bridge before
switching the environment secret to the new private key. Verify older supported
installations can authenticate the transition. After the transition, remove the
retired public entry and append its exact `keyId` to `revokedKeyIds` in a reviewed
registry change. Revocation wins even when a public entry remains present.

For compromise, stop publication, revoke the compromised identifier and replace
the environment secret. Do not reuse an identifier or edit a published tag.
Installations with the old bundled registry may require a manually verified
installer; a remote registry cannot revoke trust inside an already installed
binary. See the [incident and artifact verification contract](SUPPLY_CHAIN_SECURITY.md).
