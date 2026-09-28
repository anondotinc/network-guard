# Network Guard on Linux

The Linux helper is a Rust port in [`rust/`](../rust). It speaks the same wire
protocol as the macOS helper and passes the same [conformance fixtures](../conformance/README.md).
This page covers what differs on Linux: how provider apps are trusted, where
files go, which browsers work, and how releases are built.

## Supported systems

- 64-bit x86_64 and arm64. The binaries are statically linked (musl), so they
  have no glibc requirement.
- Google Chrome, Chromium, Brave and Microsoft Edge installed from the vendor's
  `.deb`/`.rpm` or a distribution package. **Flatpak and Snap browsers are not
  supported**: their sandbox cannot start a native-messaging host, and the
  portal meant to fix this is still unfinished.
- The Chrome Web Store build of Anon. Each channel accepts exactly one extension
  ID, as on macOS.

## Providers

Checked against each vendor's official repository on Debian 12, Ubuntu 24.04
and Fedora 41, on x86_64 and arm64, in September 2026.

| Provider | Package | Trusted file | Pinned | What the helper does |
| --- | --- | --- | --- | --- |
| Mullvad | `mullvad-vpn` | `/usr/bin/mullvad` | 2026.5 | `status --json`, `connect` |
| IVPN | `ivpn` | `/usr/bin/ivpn` | 3.15.15 | `status`, `connect -last` |
| NordVPN | `nordvpn-gui` | `/opt/nordvpn-gui/nordvpn-gui` | no | opens the app |
| Proton VPN | `proton-vpn-gtk-app` | `/usr/bin/protonvpn-app` | no | opens the app |

Launch-only providers aren't version-pinned, as on macOS. Known behaviour:

- `ivpn status` exits 1 while you're logged out of IVPN, which the helper reports
  as `providerUnavailable`.
- NordVPN's `/usr/bin/nordvpn-gui` is a symlink its install script creates, so
  the package database doesn't own it; the helper uses the real file. NordVPN's
  CLI can report status on Linux, but only for users in the `nordvpn` group, so
  it isn't offered yet.
- Proton's app is a Python entry point whose code lives in root-owned
  `dist-packages`. Proton's official CLI needs a desktop session bus and keyring
  even for `status`, and Proton connections are NetworkManager connections, so
  Linux has no Proton status yet (v6 answers `unsupportedMethod`).
- Package checks confirm the owning package by name, not the repository it came
  from. Fedora's own repositories ship an unrelated, older `protonvpn-cli`; the
  helper doesn't use that name.

## Trusting a provider app

Linux apps carry no code signature the helper can check. Instead, before running
any provider program the helper requires all of the following, and fails closed
otherwise:

1. The program is at a fixed path compiled into the helper. Callers can only
   choose a provider, never a path or argument.
2. That path and every directory above it are real (no symlinks), owned by root,
   and not group- or world-writable. So only root can replace the program.
3. The system package database (`dpkg-query` or `rpm`, themselves checked the
   same way) says exactly one package owns the file, and it is the vendor's.
4. That package is installed at a pinned version whose CLI output has been
   checked against the parsers.

A snapshot verified this way reports `installation: "verified-system-package"`
(macOS reports `verified-local-signature`). This model trusts root and the
package manager. It does not detect a root-level compromise, and it does not
replace the vendor's own repository signing, which is what protects the package
on its way in.

Everything else matches macOS: no shell, a fixed environment
(`PATH=/usr/bin:/bin`, `LANG=C.UTF-8`), stdin from `/dev/null`, stderr discarded,
a 3-second deadline (18 seconds for IVPN connect), a 64 KiB output cap, and the
whole process group killed on timeout. Only the tunnel state leaves the helper;
IPs, accounts, servers and keys are discarded in-process. `protection` is always
`unknown`.

Opening a provider's desktop app is the one case that passes session variables
through (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`,
`DBUS_SESSION_BUS_ADDRESS` and a few others), so the app can reach your desktop.
The app starts in its own session and outlives the helper. Success means it
started, not that a tunnel is connected.

## Files

Setup runs as your user. It never asks for root, installs no service, and makes
no network requests.

```
~/.local/share/anon/network-guard/<channel>/installation.json
~/.local/share/anon/network-guard/<channel>/versions/<version>-<sha256>/anon-network-helper
$XDG_CONFIG_HOME/google-chrome/NativeMessagingHosts/<host>.json
$XDG_CONFIG_HOME/chromium/NativeMessagingHosts/<host>.json
$XDG_CONFIG_HOME/BraveSoftware/Brave-Browser/NativeMessagingHosts/<host>.json
$XDG_CONFIG_HOME/microsoft-edge/NativeMessagingHosts/<host>.json
```

`$XDG_CONFIG_HOME` defaults to `~/.config`, matching how Chrome finds its profile.
Setup registers only browsers whose profile folder already exists and never
creates one. If you install a browser later, `check` reports that a repair is
needed and running `install` again registers it.

The installer follows the macOS rules: it records ownership in
`installation.json` before copying anything, verifies the helper's SHA-256 after
copying, never replaces a registration it didn't write, rejects symlinked or
shared (group/world-writable) paths below your home folder, never deletes
recursively, and refuses to uninstall if an unexpected file sits in a version
folder. The connection lock and setup lock live in `$XDG_RUNTIME_DIR` (or
`/run/user/<uid>`), never in shared `/tmp`.

## Build and release

```sh
cd rust && cargo test --locked && cargo test --locked --features development && cd ..
node scripts/build-linux.mjs --channel production   # on Linux
node release/cli.mjs package-linux --folder dist/linux/production/anon-network-guard-<version>-linux-<arch> \
  --version <version> --build-id <build> --out <new dir>
```

`build-linux.mjs` builds static binaries for the host architecture, stages the
release folder, and exercises the built binaries: the wire protocol through a
real process, then install, check and uninstall in a throwaway home.
`package-linux` refuses anything but the exact staged file set, checks that both
binaries are static ELF for the same architecture and that `payload.json`
matches the helper, and writes a byte-reproducible `.tar.gz`.

A Linux artifact has no OS signature. In the release catalog it carries
`signing: {kind: "catalog-sha256"}`: the detached Ed25519 signature over the
catalog, which pins the tarball's SHA-256, is its authenticity. Verify a
download with `node release/cli.mjs verify` against the published catalog.

CI builds and tests on `ubuntu-24.04` (x86_64) and `ubuntu-24.04-arm` (arm64).
No provider is contacted in CI. Live checks against each installed VPN app are
a manual release gate.
