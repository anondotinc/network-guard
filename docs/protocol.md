# Native protocols

Development 0.1.4 also provides the separately negotiated [v7 RPC proxy](rpc-proxy.md).
The local-only contracts and 4 KiB limits below apply to v1–v6, not v7 payloads.

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
| 5 | `v,id,method,provider` | `probe`, `openApp` (Proton VPN only) |
| 6 | `v,id,method,provider` | `status` (Proton VPN only) |

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
{"v":4,"id":"00000000-0000-4000-8000-000000000001","ok":true,"helper":{"version":"0.1.3","channel":"production","protocols":[1,2,3,4],"providers":["mullvad","ivpn","nordvpn"],"capabilities":["describe","read-status","connect-selected","open-provider-app"]}}
```

The channel is `development` for debug and `production` for release. Discovery's
capabilities summarize the helper, not universal support by every provider. An old
helper's bounded `unsupportedVersion` reply should lead the wallet to an update
path, never guessed compatibility or another permission prompt.

### Installed version and updates

`describe` is the version endpoint: use it over native messaging, not an HTTP
listener. `helper.version` comes from `NetworkGuardBuild.version`, the same
metadata used by Setup. It reports the registered, installed helper, not the
extension version or an uninstalled build in a source checkout.

The extension reads this endpoint before explicit provider installation checks
and app launches. Its provider registry declares a minimum helper version:
0.1.0 for Mullvad/IVPN/NordVPN; 0.1.2 for Proton VPN probe/open and 0.1.3 for
Proton status. If the installed version is
older, it returns `helperUpdateRequired` with the validated description before
sending any provider operation. The UI shows installed/required versions, links
to Anon's update guide, and rechecks from a fresh native session after installation.
The update recommendation does not disable compatible older providers. No
remote update poll, install, permission grant or VPN connection happens during
discovery. Changing only the extension does not update the installed native host.

Preserve the v4 response shape and frozen inventory for existing extensions.
Compatible future releases may have a new minor/major version while preserving
this endpoint. Add new operations under an additive wire version and record their
minimum helper release in the extension. Release the matching signed installer
before shipping the extension feature that requires it.

### Proton VPN v5

v4 discovery remains the frozen compatibility view for v1–v4, including its
original provider/protocol arrays. Existing extensions validate those arrays
exactly. New clients use v5 only for `provider:"protonvpn"`; they never send
Proton operations under v3 or retry through a different provider. Read v4
`describe.version` first and require 0.1.2 or later. The 0.1.0/0.1.1 executables
reject v5 provider requests with `{v:1,ok:false,error:"invalidRequest"}` because
the legacy parser rejects the extra `provider` field before checking `v`. That
reply alone cannot distinguish an old helper from a malformed request; do not
reclassify every `invalidRequest` as an update or send a fallback command.

```json
{"v":5,"id":"00000000-0000-4000-8000-000000000001","method":"probe","provider":"protonvpn"}
```

Success contains `v,id,ok,availability`; availability has exactly `provider`,
`available:true`, and `capabilities:["open-app"]`. An unavailable installation
has `available:false` and an allowlisted `error` instead. Probing only validates
the fixed local app signature; it does not launch the app or inspect a tunnel.

An explicit `openApp` request has the same request fields. Success is exactly
`{v:5,id,ok:true,opened:"protonvpn"}`. It confirms acceptance of the bounded
`/usr/bin/open -a /Applications/ProtonVPN.app` command after signature validation,
not connectivity. Proton's own startup preferences may connect it. No snapshot,
credentials, arbitrary paths, arguments, URLs, status or connect method is accepted.
Both native channels support the same operations under their existing exact origins.

### Proton VPN status v6

Read v4 `describe.version` first and require 0.1.3 or later. Only the following
request is accepted; v6 does not accept probe, app launch, connect, disconnect,
service IDs, caller-selected paths or arguments. v5 remains launch-only.

```json
{"v":6,"id":"00000000-0000-4000-8000-000000000001","method":"status","provider":"protonvpn"}
```

```json
{"v":6,"id":"00000000-0000-4000-8000-000000000001","ok":true,"snapshot":{"provider":"protonvpn","installation":"verified-local-signature","providerVersion":"6.5.1","tunnel":"disconnected","protection":"unknown","reason":"route-not-verified"}}
```

The adapter validates the fixed signed app and exact version 6.5.1. Public
SystemConfiguration preferences identify one enabled service whose type/subtype
are `VPN` / `ch.protonvpn.mac` and whose provider bundle is
`ch.protonvpn.mac.WireGuard-Extension`. Missing, disabled, ambiguous or unsupported
profiles return `providerUnavailable`. Its validated UUID is discovered locally;
the profile display name is never trusted as identity.

The fixed `/usr/sbin/scutil --nc status <UUID>` read has a three-second deadline
and 64 KiB output limit. Only the exact first-line `Connected`, `Disconnected`,
`Connecting` or `Disconnecting` state is normalized. Extended status is discarded;
no account, endpoint, address or profile data crosses native messaging. Unknown
output fails closed. Other protocols and future Proton versions need review.

While Proton is selected and local access is allowed, the extension checks on
wallet opening and about every 30 seconds. Manual checks force a refresh. These
reads do not enable auto-connect. Connect/disconnect in Proton.
A successful app launch or accepted OS command is never treated as connected.

Snapshots carry provider, locally verified installation classification, supported
provider version when known, and normalized tunnel state. `protection` is always
`unknown`: a tunnel observation is never routing verification.

Errors: `invalidRequest`, `unsupportedVersion`, `unsupportedMethod`, `invalidFrame`,
`notInstalled`, `untrustedInstallation`, `unsupportedProviderVersion`,
`providerUnavailable`, `providerTimeout`, `oversizedOutput`, `unrecognizedStatus`,
`controlBusy`, `providerConflict`. No account, IP, subprocess output, or exception
message is included. See `CONTRACTS.md` for the frozen cross-repository interface.
