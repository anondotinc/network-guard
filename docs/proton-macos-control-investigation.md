# Proton VPN macOS status and control investigation

Date: 2026-09-17. App inspected: Proton VPN 6.5.1
(`3106797.2605011144`). Network Guard 0.1.2 supports app launch only; 0.1.3 adds WireGuard status.

## Developer interfaces

Proton publishes its [Apple app source](https://github.com/ProtonVPN/ios-mac-app).
The [official Proton CLI](https://protonvpn.com/support/use-linux-cli) is for
Linux. No supported macOS command-line connect/status interface was found in
the reviewed vendor documentation. Proton's documented
[Shortcuts actions](https://protonvpn.com/support/ios-shortcuts) apply to iOS/iPadOS.

The reviewed macOS
[URL handler](https://github.com/ProtonVPN/ios-mac-app/blob/6973fc1f7703314d80cada3eba377766c55710e5/apps/macos/ProtonVPN/AppDelegate.swift)
accepts `protonvpn://refresh`; it does not supply a connect/status API. The
installed bundle declares no AppleScript scripting definition or app-intents
extension. This is evidence about the inspected release, not a guarantee about
future Proton versions.

## Confirmed local status path

macOS provides `/usr/sbin/scutil --nc`. Its local help documents `list`, `status`,
`start` and `stop`; Apple's [implementation](https://github.com/apple-oss-distributions/configd/blob/main/scutil.tproj/nc.c)
uses SystemConfiguration to query and control registered VPN services.

Read-only checks on the test Mac confirmed:

- One enabled Proton service, with `Interface.Type = VPN` and
  `Interface.SubType = ch.protonvpn.mac`.
- `VPN.NEProviderBundleIdentifier = ch.protonvpn.mac.WireGuard-Extension`.
- Both `scutil --nc list` and `scutil --nc status <service UUID>` reported
  `Disconnected`. Only the normalized state was retained from the status output.
- Public `SCPreferences` APIs could discover the service and its provider identity.
- A sandboxed proof of concept using public
  `SCNetworkConnectionCreateWithServiceID` / `SCNetworkConnectionGetStatus`
  returned `Invalid`, while `scutil` succeeded. Direct framework status access
  is therefore not yet validated for Network Guard's execution environment.

For an interactive check on this installation:

```sh
/usr/sbin/scutil --nc list
/usr/sbin/scutil --nc status "ProtonVPN"
```

Status is the macOS tunnel state. It does not prove wallet routing or whole-device
protection, especially with split tunneling. It also does not establish that
the app UI agrees with macOS at every transition.

## Connection control remains unverified

The user tested `scutil --nc start "ProtonVPN"` and reported that it did nothing.
No working connection-control interface is established. Network Guard therefore
keeps connection control unavailable; connect and disconnect inside Proton.
Command acceptance alone must never be reported as a successful connection.

### User-requested live control experiments

After the user requested auto-connect implementation, two one-shot experiments
ran while Proton 6.5.1 was already disconnected. Both used the existing signed
app/version checks, exact saved-profile identity, and alternate-provider conflict
checks. Neither disconnected a VPN, changed profiles or on-demand settings,
accessed credentials, or ran as part of the automated test suite.

| Attempt | Result |
| --- | --- |
| `/usr/sbin/scutil --nc start <discovered UUID>` | Command accepted; status remained disconnected throughout the 15-second observation. |
| Public `SCNetworkConnectionStart(connection, nil, true)` | API accepted; observed disconnecting then disconnected, with no connected state during 15 seconds. |

Fixed-marker diagnostics confirmed that Proton's OS-initiated startup path was
reached. A narrowly timed, redacted macOS diagnostic read then established the
immediate failure: `nesessionmanager` accepted the direct API runner's start,
and the running **ProtonVPN app sent a stop command about 19 ms later**, while
the session was still starting. The session subsequently became disconnected
with a stop-command reason. No raw VPN log, account data, endpoint, service UUID
or keychain content is retained here.

The reviewed Proton
[connection manager](https://github.com/ProtonVPN/ios-mac-app/blob/6973fc1f7703314d80cada3eba377766c55710e5/libraries/Core/LegacyCommon/Sources/LegacyCommon/Core/VpnManager.swift#L730-L735)
explicitly disconnects a newly connecting tunnel when its internal
`connectAllowed` flag is false. Its disconnect method sets that flag false;
its own connection preparation enables it. This is consistent with the observed
app-issued cancellation after a manual disconnect, but the private in-memory
flag was not inspected. An external macOS start request does not run Proton's
app-side connection preparation. This explains why retrying the same system
start command is not an adequate auto-connect implementation.

Apple documents that [start acceptance is asynchronous](https://developer.apple.com/documentation/systemconfiguration/scnetworkconnectionstart(_:_:_:))
and requires checking the resulting state. The reviewed Proton macOS
[packet-tunnel source](https://github.com/ProtonVPN/ios-mac-app/blob/6973fc1f7703314d80cada3eba377766c55710e5/apps/macos/ProtonVPN%20WireGuard/PacketTunnelProvider.swift)
contains an OS-direct startup path, so absence of a vendor CLI alone does not
prove OS control can never work. These local attempts nevertheless failed due
to an app-issued stop; connection control must remain unavailable until a
successful reconnect is reproduced without fighting Proton's app state.

Proton documents its own auto-connect setting under Settings → Connection in
the [macOS guide](https://protonvpn.com/support/protonvpn-mac-vpn-application).
It runs at app startup and after unexpected disconnects. Opening an already
running, manually disconnected app is not an established reconnect interface;
do not relabel `openApp` as `connectSelected` or add a forced quit/relaunch fallback.

This path does not select a country/server or reproduce Proton's Quick Connect
policy. Do not import credentials or assume a saved profile remains usable after
logout, expiry, app upgrades or server changes.

## Implementation and remaining acceptance

1. Validate the signed Proton installation using the existing independent pins.
   Discover profiles by exact app and extension identifiers, not their editable
   display name. Never hardcode a user's service UUID or accept it from the UI.
2. Use fixed executable/arguments, bounded output/deadlines, and normalized state
   only. Do not forward extended status, usernames, server addresses, profiles or
   credentials. Reject missing, disabled, duplicate or ambiguous matches.
3. Verify disconnected, connecting, connected and disconnecting transitions on
   supported macOS releases. Check missing profiles, stale configuration and
   process failures with injected fixtures. Review IKEv2/Smart/Stealth behavior
   separately; the observed profile is WireGuard.
4. Test an explicitly requested reconnect and observe the resulting status.
   Keep connection control unavailable until this succeeds reliably. Do not add
   automatic disconnect, replace profiles or change Proton's on-demand settings.
5. Preserve v5's launch-only contract. Introduce a new versioned status/control
   contract and per-feature helper-version checks, so older 0.1.2 installations
   can still open Proton while users update for status support.

Network Guard 0.1.3 implements the identity-checked, bounded read under v6.
The extension uses per-feature minimum versions. Following the local test,
Proton checks refresh on wallet opening and about every 30 seconds while linked
and selected; manual checks remain available. Auto-connect remains unavailable.
Injected tests cover all four states, identity ambiguity, missing/disabled
profiles, app version/signature failures, deadlines and output redaction.
Live transition testing beyond the Quick Connect observation below remains
incomplete; no public release is implied.

## Local development installation check

The existing development registration was updated from 0.1.2 to 0.1.3 using
Setup's receipt/ownership-checked installer. A fresh native-messaging session
through that registered binary returned version 0.1.3 and a v6 Proton 6.5.1
`disconnected` snapshot, with `protection:unknown`. Production stayed at 0.1.1.
This confirmed the installed read path; the first check covered only disconnected state.

During the user's connected-state check, the app was reported connected but the
registered helper and a separate `scutil --nc list` check both reported the sole
saved Proton WireGuard profile as disconnected. The profile had no matching
dynamic-store state sections. This is a live-validation failure: a saved-profile
read must not be treated as a reliable report of the app's overall connection.
The active Proton protocol still needs confirmation. The extension log also
rejected status before opening native messaging (`unsupportedMethod` at
`response`), consistent with an earlier background worker; the rebuilt separate
UI/background boundary passes the saved-Proton status request in both channels.

The user subsequently used Quick Connect and observed connected status in Anon.
A direct read through the installed 0.1.3 development helper also returned a
Proton 6.5.1 `connected` snapshot. This validates that connected-state path on the
test Mac; Quick Connect does not identify which protocol Proton selected. The
cause of the earlier app/profile disagreement is still unconfirmed.

The remaining `cancelled` popup trace was a UI lifecycle race: the shared status
subscription delivered success before the explicit request reply, and adopting
that observation aborted the request. The hook now invalidates older UI results
without aborting the pending reply. Explicit cancellation, unlinking, hiding or
unmounting still aborts it. The user requested automatic discovery; the extension
now refreshes Proton status on wallet opening and periodically while linked, and
loads helper metadata without requiring the Verify button.
