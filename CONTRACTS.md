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
    "version": "0.1.3",
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

## Proton VPN provider v5

Network Guard 0.1.2 adds a separate v5 provider contract for `protonvpn`, with only
`probe` and `openApp`. Existing v1–v4 schemas and the strict v4 discovery inventory
remain unchanged. New clients first read v4 `describe.version` and require 0.1.2
or later for Proton's v5 operations. Old helpers can return `invalidRequest`
before recognizing an unknown version; this error is not a compatibility probe.
Show an update action from validated version metadata; never send a fallback command.
See [the v5 wire contract](docs/protocol.md#proton-vpn-v5).

## Proton VPN status v6

Network Guard 0.1.3 adds only `status` for `protonvpn` under v6. The request has
exactly `v,id,method,provider`; success returns a normalized `snapshot` with
`protection:unknown` and `reason:route-not-verified`. Require 0.1.3 for this
operation, while retaining the 0.1.2 minimum for v5 probe/open. Do not infer
connection-control capability from status support. While Proton is selected and local access is allowed, the extension checks
status on wallet opening and about every 30 seconds, independently of auto-connect.
See [the v6 wire contract](docs/protocol.md#proton-vpn-status-v6).

## Platform discovery v8

v8 `describe` adds the platform and a per-provider capability map, because
capabilities now differ by operating system. It is the same static, provider-free
read as v4; v4 stays frozen for installed extensions. The only v8 request is
exactly `{ "v": 8, "id": "<UUID>", "method": "describe" }`. Success:

```json
{
  "v": 8,
  "id": "<same UUID>",
  "ok": true,
  "helper": {
    "version": "0.1.4",
    "build": 7,
    "channel": "production",
    "platform": "linux",
    "arch": "x86_64",
    "protocols": [1, 2, 3, 4, 5, 8],
    "providers": {
      "mullvad": ["read-status", "connect-selected"],
      "ivpn": ["read-status", "connect-selected"],
      "nordvpn": ["open-app"],
      "protonvpn": ["open-app"]
    }
  }
}
```

`platform` is `macos`, `linux` or `windows`; `arch` is `arm64` or `x86_64`.
`providers` lists what this helper can do per provider on this platform. Wire
versions per operation are unchanged: Proton uses v5 for `probe`/`openApp` and v6
for `status`, other providers use v3. A helper that doesn't know v8 replies with
its legacy `{v:1,ok:false,error:"unsupportedVersion"}`; the client then sends v4
on the same port. Helpers built before v8 exist only on macOS.

Every helper runs the fixtures in [`conformance/`](conformance/README.md), which
pin each request's exact reply, including the order of checks that decides which
error and whether the reply carries the request id.

## Device Guard v9

The Device Guard app keeps Network Guard running per user ([device/](device/README.md)).
Chrome talks to its host shim, registered under the same host name. v1–v8
requests and replies stay byte-identical: in bridge mode the app forwards them
to the installed helper and relays its reply bytes unchanged. v9 is the shim's:

- `{"v":9,"id":"<UUID>","method":"appStatus"}` is answered by the shim itself,
  even when the app is down:
  `{"v":9,"id":<same>,"ok":true,"app":{"running":<bool>,"version":"<app version>"|null,"startAtLogin":"enabled"|"off"|"requiresApproval"|"unknown"},"shim":{"version":"<shim version>"}}`.
  `version` is the running app's (from its socket hello), else `null`.
- `{"v":9,"id":"<UUID>","method":"openApp"}` is sent only after a user's click.
  The shim starts the app (macOS: `launchctl kickstart` of the registered agent
  when it exists, else `open -g` of the bundle, with `-n` and the shim's `HOME`
  so a copy serving another home is never mistaken for this one; Linux: `setsid`
  spawn; Windows: `CreateProcessW` without handle inheritance), waits up to 10 s, and replies
  `{"v":9,"id","ok":true,"app":{…as above}}` or `{"v":9,"id","ok":false,"error":"appStartFailed"}`.
  An app that already answers is reported without a launch.
- While the app is not running, every other well-formed request gets
  `{"v":<request v>,"id":<request id>,"ok":false,"error":"appNotRunning"}`; a
  request that arrives while an `openApp` launch is in progress gets
  `"appStarting"`. Malformed requests keep today's envelope rules
  ([`conformance/router.json`](conformance/router.json) ordering, for example
  `{"v":1,"ok":false,"error":"invalidRequest"}`), in every app state. A
  background poll never starts the app.
- Only exactly `v,id,method` with a UUID id and the method `appStatus` or
  `openApp` is v9. Any other `v:9` request is malformed and gets what a plain
  helper answers today, byte for byte: a wrong key set, a non-UUID id or a
  non-string method is `{"v":1,"ok":false,"error":"invalidRequest"}`, and an
  unknown method is `{"v":1,"ok":false,"error":"unsupportedVersion"}`, both
  without the id. A fractional or non-numeric `v` is an unknown version too.
- An old helper answers a well-formed v9 request with `{"v":1,"ok":false,"error":"unsupportedVersion"}`:
  the wallet then knows there is no Device Guard app (a plain helper) and
  behaves as today.

"Well-formed" means the helper's version router accepts the request's shape
and would answer it from a provider or with `ok:true`; "malformed" means it
rejects it before that (`invalidRequest`, `unsupportedVersion`,
`unsupportedMethod`). The shim decides this with the helper's own router.
[`conformance/shim.json`](conformance/shim.json) pins its replies, and its
malformed-request bytes match the Swift helper's.

The shim's parser is stricter than Foundation's. Bytes that are not strict
UTF-8 JSON (a byte-order mark, UTF-16, a trailing comma) or that repeat a
top-level key may read differently to the Swift helper, so they are its to
answer. While the app runs, they are relayed like any v1–v8 request. They are
never v9 and never served from the bridge's cache. While the app can't be
reached, the shim answers them by its own reading (for example
`invalidRequest`); the `helperResponse` cases in `shim.json` pin those
differences. "Running" means the app answers its socket hello within 2 s. An
app that is alive but silent longer is reported as not running, and its
requests get `appNotRunning`.

In bridge mode, when the installed helper can't be run or doesn't answer, a
well-formed request gets `{"v":<request v>,"id":<request id>,"ok":false,"error":"providerUnavailable"}`.
The app may reuse an `ok:true` read (status, probe, describe, capabilities) for
at most 5 s from the helper's run, with only the request id replaced; this
never extends the wallet's 45 s status TTL. Connects and provider app launches
are never reused.

## Release catalog v1

Owner: `release/catalog.schema.json`. Consumers pin the schema and pure Node/ESM
validator (`release/catalog.mjs`) and verify byte-for-byte contract parity in tests.

Root: `{schemaVersion:1,releases:[]}`. A release has exactly `product`, `version`,
`buildId`, `releasedAt` (ISO UTC), `channel`, `status`, `notes` (string array), and
`artifacts` (array), plus optional verified `source` provenance. Products:
`android`, `network-helper`, `desktop`. Channels: `test`, `stable`. Status:
`unreleased`, `published`, `withdrawn`. Desktop is not an available product here.

Artifacts contain `platform` (`android`, `macos`, or helper-only `linux` and `windows`), `architecture` (`universal`,
`arm64`, `x86_64`, Android-only `arm64-x86_64`; Linux and Windows are `arm64` or `x86_64` only), `minimumOs`, `filename`, `bytes` (positive integer), `sha256`
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
packageName:<verified package>}`. For the macOS helper: `{kind:"apple-developer-id",
teamId:<verified team>,identity:<verified certificate identity>,notarized:true}`.
For the Linux helper (`.tar.gz`): exactly `{kind:"catalog-sha256"}`. Linux has no
OS signature for the tarball; its authenticity is the detached catalog signature,
which pins the SHA-256. For the Windows helper (`.zip`): exactly
`{kind:"authenticode",subject:<leaf certificate common name>,timestamped:true}`;
packaging verifies both executables' signatures and that subject. Consumers that copy `catalog.mjs` (the site's
`src/lib/releases/vendor/catalog.mjs`) must take this version before a catalog
containing a Linux artifact is imported, and must not render Linux artifacts as
macOS downloads.
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
