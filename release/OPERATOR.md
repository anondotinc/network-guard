# Operator runbook — publication is gated

Nothing in this runbook is permission to publish. Follow the separate
[source and distribution checklist](../docs/release-checklist.md). The storage host is
`release.anon.inc` for APKs and shared catalog metadata; new helper assets use
the official tagged GitHub Releases. Provisioning, signing, uploads and activation
are explicit operator actions, never side effects of source pushes or CI.

## 1. Required approvals and inputs

- Choose **an exact** existing `Downloads/anon-v…apk` path. Do not pick by
  modification time and do not execute `make mobile` for this workflow.
- Confirm Android package, versionName, versionCode, and the expected **app
  signing certificate SHA-256** with the mobile release owner. The Play upload
  key and debug key are not substitutes. If the APK signer differs from the
  installed wallet, stop and determine upgrade compatibility; never recommend
  uninstalling an existing wallet to work around the mismatch.
- Approve the macOS Developer ID **Application** certificate and team, access to
  its private key through Keychain, and an existing `notarytool` Keychain profile.
  An app-based installer does not require Developer ID Installer.
- Approve the metadata Ed25519 key, external custody/backup procedure, and
  independently distributed public-key fingerprint. Keep private material out
  of all repositories, command-line arguments, build logs, and artifacts.
- Provision a **new dedicated release bucket** and its `release.anon.inc`
  custom domain separately. Do not reuse the prover/artifact bucket or its
  credentials. Scope the release credential to Object Read & Write on only this
  bucket; no account administration, DNS, or other bucket access.
- Complete clean-Mac testing with production extension + installer only. Intel
  cross-compilation is not live Intel acceptance. Review the extraction/license
  audit before making this source repository public.

## 2. Import an existing APK

In the parent Anon workspace, `make register-apk APK=/absolute/selected.apk
RELEASE_CONFIG=/absolute/config.json` provides a local inspection/dry run.
`EXECUTE=1` additionally authenticates remote history, signs, publishes the APK
to R2, verifies delivery, and imports the catalog into lander. It does not rebuild
mobile or deploy the site. See `scripts/release/README.md` in that workspace for
the reviewed configuration template and recovery steps. The standalone commands
below remain usable without the wallet checkout.

Install Android SDK Build Tools separately if not already present. Set each
placeholder explicitly; the tooling does not search Downloads or Android SDK
installations and does not run a mobile build.

```sh
node release/cli.mjs import-apk \
  --apk /absolute/selected/Downloads/anon-vVERSION-CODE.apk \
  --expected-signer APPROVED_APP_CERTIFICATE_SHA256 \
  --version VERSION --build-id CODE --released-at YYYY-MM-DDTHH:MM:SSZ \
  --aapt /absolute/android-sdk/build-tools/VERSION/aapt2 \
  --apksigner /absolute/android-sdk/build-tools/VERSION/apksigner \
  --channel stable --out release/out/selected-release
```

`aapt2 dump badging` supplies package/version/SDK/ABI metadata. `apksigner verify
--verbose --print-certs -Werr` must succeed and match the approved signer. The
tool hashes before and after inspection and after copying. It never modifies or
re-signs the source APK. The result is an `unreleased` record, an inspection
record, and a versioned artifact copy; no public catalog entry is activated.

## 3. Build and package the helper

```sh
node scripts/build-setup.mjs --channel production
node release/cli.mjs package-helper \
  --app 'dist/production/Anon Network Guard Setup.app' \
  --version 0.1.1 --build-id YOUR_UNIQUE_TEST_BUILD \
  --out release/out/helper-local-test
```

That produces an `UNSIGNED-TEST.zip`, staging record with `publishable:false`,
and checksum file. It cannot become a public catalog entry. Do not tell users
to bypass Gatekeeper; unsigned local test output is for the engineering test
pass, not installation guidance for a public release.

After all signing approvals, an operator may explicitly run:

```sh
node release/cli.mjs package-helper \
  --app 'dist/production/Anon Network Guard Setup.app' \
  --version 0.1.1 --build-id UNIQUE_RELEASE_BUILD \
  --released-at YYYY-MM-DDTHH:MM:SSZ --channel stable \
  --identity 'Developer ID Application: APPROVED ORGANIZATION (TEAM_ID)' \
  --team-id TEAM_ID --notary-profile EXISTING_KEYCHAIN_PROFILE \
  --execute-signing --out release/out/selected-release
```

The tool copies the app to a fresh temporary staging directory; it does not
modify the native build output. Signing order is embedded helper → recomputed
`payload.json` helper hash → outer app. Both architectures must exist. The
submission ZIP goes to Apple; accepted status, stapling validation, explicit
all-architecture strict codesign verification of both app and embedded helper,
approved identity/team/timestamp/runtime checks for each slice, and Gatekeeper
assessment are required before the final
ZIP is created and hashed. No VPN or native-host installation runs.

### Publish the helper asset on GitHub

New signed helper records point to
`https://github.com/anondotinc/network-guard/releases/download/v<VERSION>-<BUILD_ID>/<FILENAME>`.
After source/license approval and repository publication, enable immutable
releases in that repository, create the exact tagged draft, attach the final
signed/notarized ZIP, then publish the stable release. Do not use `latest` links.
The publisher checks GitHub's public API for `immutable:true`, a non-draft stable
release, and matching asset digest/size before downloading and hashing it. It
does not create GitHub releases or upload helper ZIPs to R2. Shared catalog
metadata still uses R2. Old R2 helper records remain supported and unchanged.

The same Apple Developer account/team used for iOS can issue the needed
**Developer ID Application** certificate; the iOS Apple Distribution certificate
is not a substitute. An app-based installer needs no Developer ID Installer
certificate. See the Apple certificate reference below.

## 4. Create and sign a catalog candidate

```sh
node release/cli.mjs catalog \
  --release release/out/selected-release/PRODUCT-VERSION-BUILD.release.json \
  --artifacts release/out/selected-release --publish \
  --out release/out/catalog-candidate.json
```

To preserve earlier release history, add `--previous`, `--previous-signature`,
and `--public-key` for the last trusted catalog. Keep verified historical
artifacts in the artifact tree. Never hand-merge guessed signing metadata.
`--publish` labels a **candidate** as published; it does not activate or upload
anything. Do not copy the candidate into the website before storage verification.

```sh
node release/cli.mjs sign \
  --catalog release/out/catalog-candidate.json \
  --artifacts release/out/selected-release \
  --private-key /absolute/external/secure/metadata-ed25519.pem \
  --out release/out/signed-candidate
node release/cli.mjs verify \
  --catalog release/out/signed-candidate/catalog.json \
  --signature release/out/signed-candidate/catalog.json.sig \
  --public-key /absolute/independently-trusted/metadata-public-key.pem \
  --artifacts release/out/selected-release \
  --sums release/out/signed-candidate/SHA256SUMS
```

`catalog.json.sig` is exactly 64 **raw** Ed25519 bytes. Signatures cover the
exact UTF-8 catalog bytes, including whitespace and final newline. Verify first,
then parse. Editing metadata after signing invalidates the signature.

## 5. Publishing dry run and activation

```sh
node release/cli.mjs publish \
  --catalog release/out/signed-candidate/catalog.json \
  --signature release/out/signed-candidate/catalog.json.sig \
  --public-key /absolute/independently-trusted/metadata-public-key.pem \
  --artifacts release/out/selected-release
```

The default is completely offline: no credentials are read and no HEAD/GET/PUT
is sent. Review the planned immutable keys and final activation object. After
separate approval, supply `--execute --account-id APPROVED_ACCOUNT_ID --bucket
DEDICATED_RELEASE_BUCKET --confirm-dedicated-bucket DEDICATED_RELEASE_BUCKET`.
Only that mode reads `ANON_RELEASE_R2_ACCESS_KEY_ID` and
`ANON_RELEASE_R2_SECRET_ACCESS_KEY` from a secure process environment. Do not
paste secret values into shell history or use shared workspace `.env` files.

Execution order:

1. Authenticate existing `catalog/v1.json` against the trusted public key and
   retain its ETag. Preserve history; refuse changed immutable identities.
2. Conditional-create each R2-hosted versioned artifact (`If-None-Match: *`). If it
   already exists, verify the existing bytes; never overwrite it.
3. Download each uploaded artifact from R2 and compare bytes + SHA-256. A
   successful PUT, ETag, or stored metadata checksum alone is insufficient.
4. Download every non-withdrawn artifact again through its exact signed
   `https://release.anon.inc/<product>/<version>/<build>/<filename>` URL.
   This is a mandatory gate, including artifacts that already existed in R2.
   Each request is an unauthenticated GET with no cookies, no referrer, no
   automatic redirects, identity content encoding, and a 60-second deadline.
   HTTP 200, bounded body size, and the expected final bytes + SHA-256 are
   required. DNS failure, missing files, redirects, partial/encoded responses,
   truncated/oversized data, stream errors and wrong hashes stop the operation
   before catalog metadata or activation is written. Do not bypass the gate;
   resolve custom-domain/DNS/cache delivery and rerun after review.
   For GitHub-hosted helper assets, require the immutable-release API checks
   above and allow only one HTTPS redirect to
   `release-assets.githubusercontent.com/github-production-release-asset/`.
   The metadata and asset requests share a 60-second deadline, carry no credentials,
   and require the signed digest and byte size. Arbitrary redirects are rejected.
5. Store and read-verify the exact catalog, detached signature, and checksum
   file under `catalogs/<catalog-sha256>/`.
6. Atomically replace `catalog/v1.json` with one envelope containing
   `{schemaVersion:1,catalogBase64,signatureBase64}` using the previous ETag or
   `If-None-Match: *` for first activation. Read-verify that envelope too.

The single activation object prevents mixed catalog/signature pairs. Failed
uploads or public-host verification never activate entries. A lost response after activation is ambiguous;
do not declare it failed or retry blindly. Obtain and authenticate the current
catalog first. Artifacts uploaded before a later failure may remain orphaned;
they are harmless and immutable, and are not shown by the website.

The publisher's mandatory public-host checks establish point-in-time delivery;
they cannot guarantee future DNS/CDN availability or global propagation. After
successful activation, use the lander's explicit
signed-catalog import command with the independently trusted key, review the
data diff, and run its contract/network tests. No binary belongs in lander Git.
Site publication remains a separate approved deployment.

## Repair and withdrawal

- Installer missing/broken: download the same verified signed setup app and use
  **Install / Repair**. Registration conflicts require explicit review. Do not
  run a terminal command that overwrites development or unrelated native hosts.
- To remove: use the setup app's **Uninstall** for the corresponding channel.
  This removes only owned installation/registration data. It does not remove or
  disconnect the VPN, change the wallet, or revoke Chrome permissions.
- Broken release: run `withdraw` with the authenticated catalog, exact product,
  version/build, and concise reason. Sign and dry-run the resulting candidate;
  after approval, activate it with the same guarded pipeline and import it into
  the website. Preserve release history and show the withdrawal notice.
- Do not overwrite an artifact to fix it. Ship a new build/version. Withdrawn
  versions cannot be reactivated by this tooling.
- If a release signing key is compromised, stop publication and perform a
  separately reviewed key-rotation/consumer trust update. The active catalog
  must verify with the current trusted key; no automatic key discovery exists.
- This tool has no object-delete operation. Urgent access revocation, public
  cache purge, or removal of a harmful artifact requires an approved storage
  operator action after the catalog withdrawal; do not quietly rewrite bytes.

## Authoritative references

- [Android APK signature verification](https://developer.android.com/tools/apksigner)
- [Android app signing versus upload keys](https://developer.android.com/studio/publish/app-signing)
- [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [R2 S3 API and conditional operations](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)
