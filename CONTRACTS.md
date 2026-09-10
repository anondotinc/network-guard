# Integration contracts

Source repository: `https://github.com/anondotinc/network-guard`.
Protocol and enrollment compatibility are independent of repository visibility.
Building or updating source does not authorize installer actions or VPN changes.

## Repository areas

- Native/setup: `Package.swift`, `Sources/`, `Tests/`, `scripts/`, README,
  LICENSE, SECURITY, CONTRIBUTING, native/protocol documentation.
- Release tooling: `release/` (schema, tools, tests, fixtures, operator documentation).
- Website consumer: workspace `frontend/home`, consuming a pinned release contract.
- Wallet consumer: workspace `frontend/extension`, building native source from this
  repository while retaining its existing scratch/output path.

## Native discovery v4

Existing v1–v3 request/reply shapes remain unchanged. Frames remain at most 4096
bytes. The only v4 request is exactly `{ "v": 4, "id": "<UUID>", "method": "describe" }`.
It performs no provider or network operation. Success is exactly:

```json
{
  "v": 4,
  "id": "<same UUID>",
  "ok": true,
  "helper": {
    "version": "0.1.1",
    "channel": "development",
    "protocols": [1, 2, 3, 4],
    "providers": ["mullvad", "ivpn", "nordvpn"],
    "capabilities": ["describe", "read-status", "connect-selected", "open-provider-app"]
  }
}
```

Channel is `development` in debug builds and `production` in release builds.
Errors retain `{v,id,ok:false,error:<existing allowlisted code>}`. A legacy helper
may reply with its legacy version and `unsupportedVersion`; discovery maps that
specific bounded response to an update-required state. Unknown shapes fail closed.
Host/origin enrollment stays one exact extension origin per build channel.
Provider limitations remain in the provider registry and user documentation;
capabilities describe the helper, not a claim that every provider supports each one.

## Release catalog v1

Owner: `release/catalog.schema.json`. Consumers pin the schema and pure Node/ESM
validator (`release/catalog.mjs`) and verify byte-for-byte contract parity in tests.

Root: `{schemaVersion:1,releases:[]}`. A release has exactly `product`, `version`,
`buildId`, `releasedAt` (ISO UTC), `channel`, `status`, `notes` (string array), and
`artifacts` (array), plus optional verified `source` provenance. Products:
`android`, `network-helper`, `desktop`. Channels: `test`, `stable`. Status:
`unreleased`, `published`, `withdrawn`. Desktop is not an available product here.

Artifacts contain `platform` (`android` or `macos`), `architecture` (`universal`,
`arm64`, `x86_64`, Android-only `arm64-x86_64`), `minimumOs`, `filename`, `bytes` (positive integer), `sha256`
(64 lowercase hex), `signing` (structured product-specific signing identity), and
`location` (HTTPS download URL). APK catalog URLs are confined to
`https://downloads.anon.inc/` for new imports. Any previously signed
`https://release.anon.inc/` URLs remain valid and are never rewritten. Helper
URLs additionally support exact assets at
`https://github.com/anondotinc/network-guard/releases/download/v<VERSION>-<BUILD_ID>/<FILENAME>`.
New helper packages use GitHub; existing R2 records remain valid. GitHub release
metadata must establish a stable, published, immutable release and matching
asset digest/size, followed by actual download/hash verification before catalog
activation. The site's helper button opens the corresponding exact release page.
Fixtures may use the same hosts but must never be
presented as real downloadable releases. APKs use architecture `universal` only
when APK inspection confirms that; the dual 64-bit mobile output has its own
explicit label. The importer rejects other unsupported ABI sets.

`signing` for Android: `{kind:"android",certificateSha256:<64 lowercase hex>,
packageName:<verified package>}`. For helper: `{kind:"apple-developer-id",
teamId:<verified team>,identity:<verified certificate identity>,notarized:true}`.
Optional `source`: `{repository:<verified HTTPS repository URL>,commit:<40 hex>}`.
No guessed source references. `published` requires verified artifacts; absent
files stay unavailable. An empty catalog never implies downloadable releases.

Release tooling signs exact catalog bytes using detached Ed25519 signatures;
verification precedes parsing. SHA256SUMS is generated after final packaging.
An unsigned local test helper may be built and bundled but cannot be represented
as an authenticated, published release. Release tooling may maintain richer local
staging records outside this public catalog to record pending signing checks.

## Integration boundaries

- Source of truth for native source is this repository.
- Product display name: **Anon Network Guard**. The workspace path remains
  `frontend/network-helper`; native host/bundle IDs, executables, consent keys,
  protocol fields, and the catalog product key `network-helper` are unchanged.
- Extension development builds retain their existing Swift scratch/output path at
  `../extension/native/network-helper/.build` so current registration still works.
- Installer tests use temporary user homes, never real Chrome registrations.
- SDK/wallet runtime and request-blocking activation are outside this repository.
