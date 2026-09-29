# Network Guard on Windows

The Windows helper is the same Rust port as [Linux](linux.md), in [`rust/`](../rust),
and passes the same [conformance fixtures](../conformance/README.md). This page
covers what differs on Windows.

## Supported systems

- Windows 10 22H2 and Windows 11, x86_64 and arm64. The C runtime is linked
  statically, so no Visual C++ redistributable is needed.
- Google Chrome, Microsoft Edge, Brave and Chromium running the Chrome Web Store
  build of Anon (the extension ID is the same in all four).

## Providers

Checked against each vendor's official Windows installer in September 2026.
All four sign with EV certificates. Publishers are pinned by name, not
thumbprint, so routine certificate renewals keep working.

| Provider | Runs | Publisher (O = CN) | Pinned from | What the helper does |
| --- | --- | --- | --- | --- |
| Mullvad | `Mullvad VPN\resources\mullvad.exe` | Mullvad VPN AB | `Mullvad VPN.exe` 2026.5.0.0 | `status --json`, `connect` |
| IVPN | `IVPN Client\cli\ivpn.exe` | IVPN Limited | `ui\IVPN Client.exe` 3.15.15.0 | `status`, `connect -last` |
| NordVPN | `NordVPN\NordVPN.exe` | nordvpn s.a. | not pinned | opens the app |
| Proton VPN | `Proton\VPN\ProtonVPN.Launcher.exe` | Proton AG | not pinned | opens the app |

Paths are under Program Files. The CLIs aren't version-stamped (Mullvad's reads
0.0.0.0 and IVPN's has no version resource), so the helper verifies the CLI and
the app executable signed with it, and pins the app's version. NordVPN's
installer is a downloader that fetches the app at install time, so its in-app
path comes from NordVPN's documentation and needs a check on a real install.
Proton has no CLI on Windows.

## Trusting a provider app

Before running any provider program the helper requires all of the following,
and fails closed otherwise:

1. The program is at a fixed path under Program Files (from the shell's known
   folder, not the environment). Callers can only choose a provider.
2. No component of that path is a reparse point (symlink or junction).
3. The file and every folder above it, up to Program Files, is owned by
   Administrators, SYSTEM or TrustedInstaller, and no access rule grants write,
   delete or permission changes to Everyone, Authenticated Users, Users,
   Interactive, or the current user. So only an administrator can replace it.
4. `WinVerifyTrust` accepts its Authenticode signature, with revocation checks
   off and cached URLs only, so verification makes no network request.
5. The leaf certificate's organization and common name match the vendor's
   pinned publisher.
6. For status and connect, a file version is pinned (see Providers).

Snapshots verified this way report `installation: "verified-authenticode"`.

Children run with no shell and no console window, a minimal environment built
from the system's Windows folder (`SystemRoot`, `windir`, `SystemDrive`, `PATH`),
stdin from NUL and stderr discarded, a 3-second deadline (18 seconds for IVPN
connect) and a 64 KiB output cap. Each child runs in a kill-on-close Job Object,
so a timeout ends the whole process tree. Opening a provider's app passes a
short list of profile variables so the app finds the user's settings, and asks
Windows to start it outside Chrome's job where that's allowed, so it outlives
the helper.

Chrome passes the caller origin first and, on Windows, `--parent-window=<handle>`
(0 from a service worker). The helper accepts exactly those two arguments. By
default Chrome starts the host through `cmd.exe /d /s /c "…"` with redirected
pipes; direct `.exe` launch is behind a feature flag and an enterprise policy
that are both off by default. Rust's standard streams read and write raw bytes
on pipes, so the length-prefixed framing needs no text-mode workaround.

## Files

Setup runs as the current user. It never asks for administrator rights,
installs no service, and makes no network requests.

```
%LOCALAPPDATA%\Anon\NetworkGuard\<channel>\installation.json
%LOCALAPPDATA%\Anon\NetworkGuard\<channel>\versions\<version>-<sha256>\anon-network-helper.exe
%LOCALAPPDATA%\Anon\NetworkGuard\<channel>\hosts\<host>.json
HKCU\Software\Google\Chrome\NativeMessagingHosts\<host>     (Chrome, and Brave)
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\<host>
HKCU\Software\Chromium\NativeMessagingHosts\<host>
```

Each registry key's default value is the path of the single host manifest.
Brave has no key of its own on Windows; it reads Chromium's key, then Chrome's.
Edge reads its own key, then Chromium's, then Chrome's.
Setup registers only browsers whose `User Data` folder exists under
`%LOCALAPPDATA%`, and never creates one. The receipt, SHA-256, conflict and
no-recursive-delete rules match Linux and macOS. A registry value that points
anywhere else is another installation's, and is never replaced or removed.
Setup refuses reparse points below `%LOCALAPPDATA%`. The setup lock and the
connection lock are named mutexes in the session's `Local\` namespace.

Double-clicking `anon-network-guard-setup.exe` runs install and waits for Enter.
There is no Apps & Features entry yet: remove Network Guard with
`anon-network-guard-setup.exe uninstall` from the release folder. A signed
installer that also adds that entry is a follow-up.

## Build and release

```sh
cd rust && cargo test --locked && cd ..
node scripts/build-windows.mjs --channel production   # on Windows
node release/cli.mjs package-windows --folder dist\windows\production\anon-network-guard-<version>-windows-<arch> ^
  --version <version> --build-id <build> --out <new dir>
```

`build-windows.mjs` builds both executables, stages the release folder and
exercises the built host over real pipes, including `--parent-window`. With
`NETWORK_GUARD_SETUP_SMOKE=1` (set in CI only) it also installs, checks and
uninstalls for the current user. The Rust installer tests use a scratch HKCU key
and a temporary folder.

Stable packages need both executables signed and timestamped beforehand.
`package-windows --channel stable --signer-subject <CN>` verifies both with
`osslsigncode` against that publisher and never signs anything itself. The
catalog records `signing: {kind: "authenticode", subject, timestamped: true}`.
SmartScreen reputation builds per publisher, so sign every release with the same
identity; since 2024 an EV certificate no longer skips that warm-up.

CI builds and tests on `windows-2025` (x86_64) and `windows-11-arm` (arm64).
No provider is installed or contacted in CI. Live checks against each VPN app
are a manual release gate.
