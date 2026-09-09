# Release tooling

Local-first release tools for the Android wallet APK and macOS Network Guard.
Node 22+; Node built-ins only. No install step, telemetry, auto-downloads, hidden
credential loading, mobile builds, or infrastructure provisioning.

```sh
node release/cli.mjs help
node --test release/tests/*.test.mjs
```

Read [the operator runbook](OPERATOR.md) before importing a real release. The
public catalog starts empty in `catalog.empty.json`; missing downloads remain
unavailable. `catalog.schema.json` plus `catalog.mjs` are the pinned v1 website
contract. Both must match byte-for-byte in the website contract tests.

## Commands

| Command | Input and assurance | External operations |
| --- | --- | --- |
| `import-apk` | Explicit APK, expected app signer, version/build; inspected by Android SDK `aapt2` and `apksigner` | None; reads local APK and copies verified bytes |
| `package-helper` | Universal production app; default unsigned local test archive | Local `plutil`, `lipo`, `ditto` only |
| `package-helper --execute-signing` | Approved Developer ID Application identity/team and notarization profile | Codesigning; explicit Apple notarization submission/assessment |
| `catalog` | Verified release record + artifact directory; optional authenticated prior catalog | None; creates an inactive candidate |
| `withdraw` | Authenticated catalog + exact release + reason | None; creates an inactive withdrawal candidate |
| `sign` | Candidate + artifacts + external Ed25519 private key | None; exact-byte detached metadata signing |
| `verify` | Trusted public key + catalog/signature; optional artifacts/checksum file | Offline only |
| `publish` | Signed catalog + verified local artifacts | Default dry run: no credentials or requests |
| `publish --execute` | Stable catalog + explicit dedicated bucket confirmation | Conditional R2 uploads, R2 and mandatory public-host download-and-hash verification, activation last |

No command installs a native host, changes Chrome permissions, invokes a VPN,
modifies mobile source, signs an APK, or substitutes a release signer.

## Integrity is not the same as authenticity

A SHA-256 beside a download detects accidental corruption only if the value
itself is trusted. Detached Ed25519 signatures authenticate the exact catalog
bytes with a separately trusted public key. The signed catalog binds the hashes,
file sizes, artifact locations, release status, and platform signing identity.
`SHA256SUMS` is checked against that authenticated catalog, not trusted alone.

The public key emitted by `sign` is a convenience for distribution; obtaining
that key alongside an untrusted download does **not** establish trust. Publish
and independently verify its fingerprint through approved Anon channels before
release. Do not generate or commit a production signing key here. `sign` refuses
private keys inside any Git checkout or readable by other users.

Offline verification authenticates the catalog and optional artifact hashes; it
does not replace Android package-signature verification or macOS Gatekeeper.

## Synthetic test bundle

```sh
node release/tests/fixture-bundle.mjs --out release/out/example-test
node release/cli.mjs verify \
  --catalog release/out/example-test/catalog.json \
  --signature release/out/example-test/catalog.json.sig \
  --public-key release/out/example-test/metadata-public-key.TEST-ONLY.pem \
  --artifacts release/out/example-test \
  --sums release/out/example-test/SHA256SUMS
node release/cli.mjs publish \
  --catalog release/out/example-test/catalog.json \
  --signature release/out/example-test/catalog.json.sig \
  --public-key release/out/example-test/metadata-public-key.TEST-ONLY.pem \
  --artifacts release/out/example-test
```

This creates a **non-APK byte fixture**, invented test release metadata, and an
ephemeral in-memory keypair. Only the public key is written. No URL in that
catalog represents an available artifact. The live publish command refuses
test-channel catalogs. Never copy this fixture into the website.

## Deliberate limits

- Android package is exactly `com.ahloop.anon`; one expected signer only. Split
  APKs and signer-rotation/multiple-signer cases require separate review.
- Supported APK ABI sets: no native libraries (universal), all four conventional
  Android ABIs (universal), arm64-only, x86_64-only, or the dual 64-bit
  `arm64-x86_64` APK emitted by `make mobile`. Other mixed ABI sets are refused.
- Setup app is production-enrolled, macOS 13+, arm64 + x86_64, with exact bundle
  identity. Development builds are not release packages.
- Files at most 512 MiB; catalogs at most 2 MiB / 500 entries. R2 transfers are
  bounded at 60 seconds per request. No multipart/resumable upload protocol.
- A matching existing immutable object can resume only after reading and
  hashing its bytes. Conflicting bytes require a new version/build.
- Every non-withdrawn public `downloads.anon.inc` artifact URL must independently
  return HTTP 200 and the signed byte size/hash before activation. Requests are
  credential-free, 60-second bounded, and do not follow redirects or accept
  encoded/partial responses. Public DNS, file-delivery or integrity failure
  cannot be bypassed by successful R2 readback. Default dry runs remain offline.
- R2 signature transport is dependency-free and fixed to the account's R2 S3
  endpoint. It has no list-account, create-bucket, DNS, or delete methods.
- Credential bucket scope must be established by an operator; a credential's
  least-privilege policy cannot be inferred from its secret value.
- Public site import remains an explicit verified source-data change. The site
  does not fetch a mutable catalog or start artifact requests on page load.

New production helper records target tagged GitHub Releases in
`anondotinc/network-guard`; legacy R2 helper entries remain valid. Publishing
does not upload GitHub assets to R2: it requires an already published stable
immutable release, matching GitHub asset digest/size, and actual byte verification.
Only one redirect to the fixed GitHub asset CDN is allowed, without credentials.
Shared signed catalog metadata remains in R2. See the operator runbook.
