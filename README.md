# Anon Network Guard

A minimal, local bridge between the Anon wallet extension and your existing VPN
app. The wallet can check the VPN's reported connection state and, with your
separate consent, request a connection using your existing provider settings.

**Development preview · 0.1.1, build 4 · Chrome on macOS 13+**

Network Guard is not a VPN or a wallet. It holds no wallet keys or account data,
has no HTTP server, background daemon, telemetry or automatic updater, and
installs only for your macOS user without administrator privileges.

**This preview does not block wallet requests or verify browser routing.** A VPN
reporting “connected” is not proof that browser traffic uses its tunnel. Background
requests may continue while the wallet's opening screen waits for a local check.
See the [security boundaries](SECURITY.md) before relying on this tool.

[Setup guide](https://anon.inc/setup/vpn) ·
[Release status](docs/release-checklist.md) ·
[Security reporting](SECURITY.md#reporting) ·
[Contributing](CONTRIBUTING.md)

## What it does

| Provider | Supported preview | Actions and limits |
| --- | --- | --- |
| Mullvad | 2026.4; macOS 14+ | Verify the pinned installation, read local status, request the selected connection. First validation target. |
| IVPN | 3.15.15; limited validation | Read status and connect the last profile. Its daemon may refresh provider information; connecting can also enable IVPN's firewall. |
| NordVPN | Supported website-distributed app; launch only | Open the app after a click. No connection-status verification or auto-connect. |

Supported versions and signing identities are deliberately narrow. An unsupported
version needs a reviewed Guard update; do not downgrade a VPN to bypass a check.
Install the provider app and manage its account, servers, DNS and split tunneling
in that app. Network Guard never accepts provider credentials or picks a server.

## Install and use

Public source availability is separate from installer availability. Local builds
are **unsigned and not notarized**. Do not treat a successful build or this
repository as a production installer endorsement. Use only a verified release
that has passed the [distribution checklist](docs/release-checklist.md).

1. Install and configure a supported VPN app separately.
2. Open **Anon Network Guard Setup** and choose **Install / Repair**.
3. In Anon's connection settings, choose **Allow local access** and approve
   Chrome's permission prompt.
4. Choose **Verify Network Guard / Recheck** to check the helper and provider.
5. Opt into **Connect when Anon opens** separately, only if you want it.

Unlinking removes the wallet's local-access permission. Setup's **Uninstall**
removes only its owned files and matching Chrome registration. Neither action,
nor closing the wallet, disconnects your VPN or undoes an already requested
connection. Use the provider app to manage that connection.

For repair, updates and registration conflicts, follow the [setup guide](https://anon.inc/setup/vpn).
Installation does not grant Chrome permission, change wallet consent or run a VPN.

## Review the implementation

The native helper is a short-lived Chrome native-messaging process. Requests use
strict schemas, fixed operations, exact extension identities and bounded output.
There is no arbitrary shell-command or wallet-transaction interface. Signature
checks explicitly prohibit certificate-network access. Unknown state never counts
as a verified connection.

Start with these small review surfaces:

- [Security boundaries and threat model](SECURITY.md)
- [Wire protocol and provider capabilities](docs/protocol.md)
- [Native framing and enrollment](Sources/NetworkHelperCore/NativeEnrollment.swift)
- [Provider execution and redaction](Sources/NetworkHelperCore/MullvadReader.swift)
- [Provider selection and connection policy](Sources/NetworkHelperCore/ProviderRegistry.swift)
- [User-only install, repair and removal](Sources/NetworkHelperSetupCore/Installer.swift)
- [Tests and reproducible checks](docs/testing.md)
- [Source and asset provenance](docs/provenance.md)

Source review, platform signing and file hashes answer different questions.
Published source is not an independent audit or proof that a downloaded binary
matches it. [Release verification](release/README.md) describes the separate checks.

## Build and test

Build tools: macOS, Xcode or Apple's command-line tools, and Node.js 22+. The Swift
package and Node scripts use system libraries/built-ins, with no third-party
package installation. These tools are not needed by users of a packaged installer.

```sh
git clone https://github.com/anondotinc/network-guard.git
cd network-guard
node scripts/check-source.mjs
node --test release/tests/*.test.mjs scripts/*.test.mjs
node scripts/test-native.mjs
node scripts/test-native.mjs -c release
node scripts/build-setup.mjs --channel production
node scripts/test-wire.mjs --channel production
```

Output: `dist/production/Anon Network Guard Setup.app`, with both Apple-silicon and
Intel executables. Build/wire tests do not install, register or invoke a provider.
To create an unsigned engineering disk image, run
`node scripts/build-image.mjs --channel production`. Existing image bytes are
never overwritten; bump the build for a new candidate.

The same source supports development builds with `--channel development`. Each
channel currently accepts exactly one extension ID and has a separate host name
and installation root. See [integration contracts](CONTRACTS.md). A development
installer does not replace production or foreign registrations.

The [CI workflow](.github/workflows/ci.yml) tests and builds from a checkout without
signing keys, provider accounts or wallet state. It does not publish artifacts.
Cross-compilation is not a substitute for live Intel and clean-Mac acceptance.

## Versions and repository scope

[`BuildVersion.swift`](Sources/NetworkHelperCore/BuildVersion.swift) is the single
version/build source. Bump the semantic version for user-visible changes and the
build integer for each new installer candidate. See [changes](CHANGELOG.md).
The maintained branch is `master`; release tags identify approved immutable builds.

- `Sources/`, `Tests/`, `scripts/`: helper, setup app and local verification.
- `release/`: optional maintainer tooling for Guard releases and Anon's Android
  APK/catalog pipeline. It is **not installed with the helper** and is not needed
  for VPN checks. Publication is explicit and dry-run-first.
- `assets/`: the official installer icon with its separate license.

## License

Anon-owned helper, setup and tooling code is [MIT licensed](LICENSE).
The Anon icon is **not covered by that MIT grant**: its original source license
and provenance are in [assets/README.md](assets/README.md) and [assets/LICENSE](assets/LICENSE).
No trademark rights are granted. Vendor VPN apps are separately installed and are
not bundled. This repository does not change the wallet's license.
