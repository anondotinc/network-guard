# Release tooling verification

These checks exercise the release pipeline with synthetic files, generated test
keys, mocked platform tools and in-memory transports. They are not evidence that
a downloadable artifact has been signed, notarized or accepted on a clean Mac.

## Reproduce

From the repository root:

```sh
node --test release/tests/*.test.mjs scripts/*.test.mjs
```

The exact commit's CI output is the authoritative test result. For native,
installer, universal-build and compiled-protocol checks, see
[testing](../docs/testing.md).

## Automated coverage

| Boundary | Regressions |
| --- | --- |
| Catalog | Strict schema, unknown fields, duplicate versions, unsafe or mutable locations, invalid sizes/hashes, unsupported platforms, unavailable desktop and unsigned helper records. |
| APK inspection | Expected package/version/build/signer, debug certificates, multiple signers, split APKs, ambiguous architectures, signature-tool failure and duplicate output. Tests use mocked Android tools, not a real wallet APK. |
| Metadata signatures | Node's Ed25519 support, exact-byte verification before parsing, corrupt data, wrong keys, invalid signature lengths, wrong key type and symlinked artifacts. Fixture keys cannot authorize a live release. |
| Immutable upload | Matching retry versus conflicting bytes, source changes, failed upload/readback, authenticated prior catalog, concurrent activation and safe withdrawal. |
| Public delivery | Exact immutable URL, bounded credential-free redirects, HTTP errors, partial/oversized/truncated bodies, unexpected encoding and stream failure. Activation follows storage readback and public-URL hashing. |
| GitHub releases | Official tagged URLs, immutable non-draft release metadata, asset size/digest, permitted download redirects and corrupted bytes. Helper binaries are not silently copied to R2. |
| Dry run | No credential reads or network calls. Live mode rejects fixture catalogs before accessing credentials or transports. |
| Installer packaging | Bundle structure, helper payload digest, versions/channels, both architecture slices and unsigned-test exclusion from publishable catalogs. |
| Signing commands | Strict all-architecture verification of app and helper, per-slice Developer ID identity/team, hardened runtime and timestamp checks, before notarization and after stapling. Platform commands are mocked in these regressions. |

The suite never installs or registers a helper, connects a VPN, invokes Apple
notarization services, provisions storage or publishes a release. Generated
fixtures and packaged artifacts stay in ignored output directories, not Git.

## Separate acceptance gates

- A real APK needs inspection with Android's signature tools and the owner's
  approved **app-signing** certificate fingerprint, package and version.
- Signed helper distribution needs Developer ID Application credentials,
  notarization, Gatekeeper acceptance and clean-Mac testing. Compiling both
  architectures does not replace an Intel runtime test.
- Production metadata keys and their public fingerprints need independent
  approval and documented custody/rotation.
- Live R2/GitHub delivery, credential scope, immutable-object behavior, DNS/cache
  delivery and interrupted uploads require authorized staging acceptance.
- A source preview or successful CI run does not make an unsigned test installer
  suitable for public distribution.

Follow the [release checklist](../docs/release-checklist.md) and
[operator runbook](OPERATOR.md). No real downloads, release identifiers or signing
identities should be inferred from synthetic fixture data.
