# Wire conformance fixtures

Every Network Guard helper (Swift on macOS, Rust on Linux and Windows) must
produce exactly these responses. The fixtures are data only; each
implementation has a small runner:

- Swift: `Tests/NetworkHelperCoreTests/ConformanceTests.swift` (`swift test`)
- Rust: `rust/tests/conformance.rs` (`cargo test`)

The Swift helper is the reference. To record the response for a new case,
leave out `response`, run the Swift suite with `CONFORMANCE_RECORD=1`, review
the recorded JSON, and commit it. A runner never rewrites an existing
`response`.

## Files

| File | What it checks |
| --- | --- |
| `router.json` | One request frame in, one response frame out, through the full version router (v1–v6, v8). Adapters are fakes. |
| `frames.json` | Length-prefixed framing: limits, byte order, truncation, clean EOF. |
| `origins.json` | The caller-origin check applied to `argv[1]`. |
| `status-parsers.json` | Provider CLI output to tunnel state, or a failure. |

## `router.json`

```json
{
  "name": "v3 status reads the selected provider",
  "scenario": { "providers": { "ivpn": { "state": "connected" } } },
  "request": { "v": 3, "id": "…", "method": "status", "provider": "ivpn" },
  "response": { "v": 3, "id": "…", "ok": true, "snapshot": { … } },
  "calls": { "ivpn": { "reads": 1, "connects": 0, "opens": 0 } }
}
```

- `request` is encoded as compact JSON. `requestText` is sent as raw UTF-8
  instead, for payloads that are not JSON objects.
- `response` is compared as parsed JSON: same keys, same values. Tokens
  `{{version}}`, `{{build}}`, `{{channel}}`, `{{platform}}` and `{{arch}}` are
  replaced with the running helper's values first.
- `responseByPlatform` and `callsByPlatform` override `response` and `calls`
  for one platform (`macos`, `linux`, `windows`).
- `calls` lists only the adapters it names. Unnamed adapters are not checked.

### Fake adapters

Each provider gets one fake with this state. `scenario.providers.<name>`
overrides any field.

| Field | Default |
| --- | --- |
| `installed` | `true` |
| `failure` | `null` (or a `HelperError` code) |
| `state` | `"disconnected"` |

Behaviour, identical in every runner:

- `validate()`: throws `notInstalled` when not installed, then `failure` when set.
- `status()`: `validate()`, `reads += 1`, returns
  `{provider, installation: "verified-local-signature", providerVersion, tunnel: state, protection: "unknown", reason: "route-not-verified"}`
  with `providerVersion` of `2026.4` (mullvad), `3.15.15` (ivpn),
  `6.5.1` (protonvpn), `2026.4` (nordvpn, never reached through the router).
- `connect()`: `connects += 1`, `state = "connecting"`, returns `status()`.
- `openApp()`: `validate()`, `opens += 1`.

The v1 service reads the Mullvad fake. The v2 control service runs
`SelectedConnection.ensure` over the Mullvad fake's `status()` and
`connect()`. `scenario.control` (default `true`) is the build's
`supportsConnectionControl` flag.

## Platform capabilities

`describe` v8 and the registry's method gates use one table per platform.
These are the values the fixtures expect.

| Provider | macos | linux |
| --- | --- | --- |
| mullvad | read-status, connect-selected | read-status, connect-selected |
| ivpn | read-status, connect-selected | read-status, connect-selected |
| nordvpn | open-app | open-app |
| protonvpn | open-app, read-status | open-app |
