# Source and licensing review

The initial helper source was extracted from the Anon extension's native helper,
with explicit owner approval to license **only this Anon-owned helper code** under
MIT. This does not change the wallet's Business Source License or relicense any
unrelated wallet, SDK, website, or vendor code.

Reviewed extraction scope:

- Swift package manifest.
- `Sources/AnonNetworkHelper/main.swift`.
- `NetworkHelperCore`: framing, enrollment, protocol, bounded Mullvad execution,
  connection controls, provider registry, IVPN adapter, NordVPN adapter.
- Corresponding XCTest files, using synthetic subprocesses/fake adapters.

No vendored source, third-party copyright block, copied vendor implementation,
external Swift package dependency, wallet implementation, preview UI, blocking lab,
cache, build binary, private checkout reference, key, or runtime log was included.
The adapters invoke separately installed vendor apps; those apps and their licenses
are not bundled. Apple SDK frameworks are build/system dependencies, not copied
third-party source. Test strings name public provider/site identities only.

New discovery, installer, AppKit setup UI, tests, build scripts and documentation
are Anon-owned work under the same scoped MIT grant. Release tooling has its own
review/tests and does not introduce bundled runtime dependencies.

The branded installer now includes the existing Anon icon. It is explicitly
excluded from the code's MIT grant; its source license and pinned provenance are
preserved in `assets/`. The derived icon and its separate license ship together.
No kit implementation code is included or relicensed.

This records a scoped extraction review, not a completed independent legal or
security audit. Final source-publication approval remains with the Anon owner.
Independent provider-pin verification remains a distribution gate, not a claim
established by passing synthetic tests. See the [release checklist](release-checklist.md).
No unverifiable source commit is invented for the initial extracted helper input.

## Proton VPN macOS adapter (2026-09-17)

Official sources reviewed at ProtonVPN/ios-mac-app commit
`6973fc1f7703314d80cada3eba377766c55710e5`:

- [macOS project](https://github.com/ProtonVPN/ios-mac-app/blob/6973fc1f7703314d80cada3eba377766c55710e5/apps/macos/macOS.xcodeproj/project.pbxproj)
  independently declares bundle ID `ch.protonvpn.mac` and signing team `J6S6Q257EK`.
  These match the installed website app's 6.5.1 code-signing metadata; the local
  binary alone was not used to establish the trust pin.
- [macOS URL handler](https://github.com/ProtonVPN/ios-mac-app/blob/6973fc1f7703314d80cada3eba377766c55710e5/apps/macos/ProtonVPN/AppDelegate.swift)
  handles `protonvpn://refresh`; it does not expose a connect/status command.
- [Official macOS guide](https://protonvpn.com/support/protonvpn-mac-vpn-application)
  describes managing the connection in Proton's app. The
  [official CLI](https://github.com/ProtonVPN/proton-vpn-cli) is for Linux.

The Anon-owned adapter verifies the fixed `/Applications/ProtonVPN.app` path
against Apple's trust anchor, identifier and team, then opens that app on explicit
request with a three-second deadline. No vendor implementation was copied.

The 0.1.3 status adapter additionally pins app version 6.5.1 and discovers a saved
WireGuard service using public SystemConfiguration preferences. The same official
macOS project declares `ch.protonvpn.mac.WireGuard-Extension`; this matches the
provider identifier observed on the local service. The editable name is not used.
Apple's [scutil source](https://github.com/apple-oss-distributions/configd/blob/main/scutil.tproj/nc.c)
and local command help document `--nc status`. Only its first-line tunnel state
is retained; extended output is discarded. Three-second/64 KiB bounds apply.

No custom URL, Proton preference/credential read, UI scripting, IP lookup or
connection-control command is used. This reads macOS tunnel state, not browser
routing. Missing/ambiguous profiles and unsupported app versions fail closed.
Synthetic fixtures cover all normalized states and failures; live connected-state
acceptance and signed distribution remain separate gates. See the
[local investigation](proton-macos-control-investigation.md).
