# Native protocols

Transport: Chrome native messaging over stdin/stdout. Each JSON UTF-8 message is
preceded by a four-byte little-endian length. Length must be 1–4096 bytes. There are
no notifications or background server. EOF ends a session; malformed framing ends
with a fixed stderr message and nonzero exit. Caller origin must exactly match the
single build enrollment, including trailing slash.

Every request has a UUID `id`; successful replies preserve it normalized lowercase.
Unknown fields, versions, methods, providers and non-UUID identifiers fail closed.
Error replies contain only the version, available correlated ID, `ok:false`, and an
allowlisted error code. Older versions may omit the ID when parsing fails.

| Version | Request fields | Methods |
| --- | --- | --- |
| 1 | `v,id,method` | `capabilities`, `status` (Mullvad) |
| 2 | `v,id,method` | `capabilities`, `connectSelected` (Mullvad) |
| 3 | `v,id,method,provider` | `probe`, `status`, `connectSelected`, `openApp` |
| 4 | `v,id,method` | `describe` only |

v1 capabilities remain `read-status, read-only-prototype`. v2 capabilities remain
`connect-selected, development-control-pilot`; this historical string is unchanged
in the production channel to preserve existing clients. v3 accepts only `mullvad`,
`ivpn`, `nordvpn`. `openApp` is Nord-only; `status` and `connectSelected` are
Mullvad/IVPN-only. `probe` verifies installation without reading tunnel state.

v4 discovery is static and invokes no provider or network operation:

```json
{"v":4,"id":"00000000-0000-4000-8000-000000000001","method":"describe"}
```

```json
{"v":4,"id":"00000000-0000-4000-8000-000000000001","ok":true,"helper":{"version":"0.1.1","channel":"production","protocols":[1,2,3,4],"providers":["mullvad","ivpn","nordvpn"],"capabilities":["describe","read-status","connect-selected","open-provider-app"]}}
```

The channel is `development` for debug and `production` for release. Discovery's
capabilities summarize the helper, not universal support by every provider. An old
helper's bounded `unsupportedVersion` reply should lead the wallet to an update
path, never guessed compatibility or another permission prompt.

Snapshots carry provider, locally verified installation classification, supported
provider version when known, and normalized tunnel state. `protection` is always
`unknown`: a tunnel observation is never routing verification.

Errors: `invalidRequest`, `unsupportedVersion`, `unsupportedMethod`, `invalidFrame`,
`notInstalled`, `untrustedInstallation`, `unsupportedProviderVersion`,
`providerUnavailable`, `providerTimeout`, `oversizedOutput`, `unrecognizedStatus`,
`controlBusy`, `providerConflict`. No account, IP, subprocess output, or exception
message is included. See `CONTRACTS.md` for the frozen cross-repository interface.
