# Device Guard M0 spike

This is throwaway code that answers the questions the Device Guard v1 plan said only real builds could answer. It is not the shipping app, and nothing here is wired to the wallet's real host names.

## Pieces

- **`anon-guard`** is the app. Only one copy runs per user.
  - On Unix, single instance is a `flock` on `guard.lock`. On Windows it is the first pipe instance.
  - It shows a tray icon: `tray-icon` with `tao` on macOS and Windows, `ksni` on Linux.
  - It has a per-user socket. On macOS that is `~/Library/Application Support/Anon/NetworkGuardSpike/run/guard.sock` in a 0700 directory. On Linux it is `$XDG_RUNTIME_DIR/anon-network-guard-spike/guard.sock`.
  - Commands: `anon-guard status`, `anon-guard quit`, and on macOS `anon-guard login-item status|register|unregister [main|agent]`.
- **`anon-guard-host`** is the Chrome host shim, at `Contents/MacOS/anon-guard-host` inside the app bundle.
  - It relays each frame to the app and passes the reply back byte for byte.
  - It answers `shimDescribe` itself.
  - When the app is down it replies `appNotRunning`.
  - It starts the app only for `openGuard`.
- **Wire on the socket:** Chrome's framing (u32 length in native order, then JSON). The first frame is a hello carrying `ipc: 1`, the role, and the caller's origin.
- **`test/native-e2e.mjs`** runs a key-pinned test extension in Playwright's Chromium.

## Run it (macOS)

```bash
SIGN_IDENTITY="Developer ID Application: …" scripts/build-macos.sh   # ad hoc without it
ditto "out/Anon Network Guard Spike.app" ~/Applications/"Anon Network Guard Spike.app"
APP=~/Applications/"Anon Network Guard Spike.app"
PLAYWRIGHT_MODULE=…/scripts/artifact-video-exporter/node_modules/playwright \
  node test/native-e2e.mjs --headless --shim "$APP/Contents/MacOS/anon-guard-host" \
  --app-bin "$APP/Contents/MacOS/anon-guard" --start "open -g '$APP'"
scripts/notarize-macos.sh <notarytool-profile>   # operator step: notarize, staple, quarantine test
```

## Results, macOS 26.5.2 (arm64), Chromium 1234 headless, 2026-10-08

### Transport

All five checks passed in 3 of 3 runs.

| Check | Result |
| --- | --- |
| One-shot message (Chrome starts a fresh shim each time) | 20/20 ok. p50 2.2–3.2 ms, p90 5.4–6.8 ms |
| Long-lived port | 50/50 ok. p50 0.1 ms, max 1.3–1.8 ms |
| App restarts under an open port | ok. The shim reconnects on the next message, and the port stays up |
| App stopped, background read | `appNotRunning` in about 2 ms. The app is not started |
| `openGuard` (a user's click) | The app starts through LaunchServices in 94–103 ms, then answers |

### Lifecycle

| Check | Result |
| --- | --- |
| The app outlives Chrome closing | yes |
| Five copies started at once | 1 serving, 4 exit "already running" |
| Stale socket after SIGKILL | reclaimed by the next start |
| Idle footprint after 30 s | about 35 MB RSS, 0.0% CPU, 0.11 s CPU total |
| Binary sizes (release, arm64) | app 0.94 MB, shim 0.37 MB |

### Login items (SMAppService)

| Check | Result |
| --- | --- |
| Main-app login item from `~/Applications`, Developer ID signed, not notarized | `register` → `enabled` at once, with no approval prompt |
| LaunchAgent login item (`Contents/Library/LaunchAgents`, `BundleProgram`) | `register` → `enabled`. launchd starts the app within 0.04 s |
| Crash under the agent (SIGKILL) | launchd relaunches it in 5.1 s, which is its throttle |
| Quit under the agent (exit 0) | stays down until the next login |

### Gatekeeper and notarization

- Not notarized: `spctl` rejects the bundle as "Unnotarized Developer ID". It runs locally because nothing quarantined it.
- Notarizing, and the quarantined-download case, are waiting on `scripts/notarize-macos.sh`. That needs a notarytool profile, and this Mac's keychain has none.

### Findings for v1

1. **Prefer the agent login item over the main-app one.**
   - The agent starts the app the moment the user turns it on. A main-app item only starts it at the next login.
   - It restarts the app after a crash, and a clean Quit stays down.
   - The cost: in System Settings it is listed under "Allow in the Background", not "Open at Login".
   - When the app is registered as an agent, the shim's `openGuard` should `launchctl kickstart` the agent, not `open` the bundle, so launchd keeps owning the process.
2. **Status `notFound` means "never registered".** Before the first registration, SMAppService reports `notFound`, not `notRegistered`. The UI should treat both as off.
3. **macOS socket permissions.** macOS can't `fchmod` a socket before `bind`, so `interprocess`'s `mode()` returns Unsupported. On macOS the protection is the 0700 run directory plus the peer-UID check (`getpeereid`). Linux also gets a 0600 socket.
4. **The socket alone can't be the single-instance lock on Unix.** Clearing a stale socket means unlinking it, and two copies starting together could each unlink the other's. A `flock`ed lock file closes that gap. On Windows the first pipe instance is atomic, so no lock file is needed there.
5. **The socket path has a length limit.** `sun_path` is 104 bytes on macOS. The Application Support path is 75 bytes for a short username. v1 should use a shorter directory, or fall back when the path is too long.
6. **Chromium finds a host manifest in `<user-data-dir>/NativeMessagingHosts`.** That made the tests independent of the user's Chrome. Branded Chrome on macOS reads `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`, as today's installer assumes.
7. **The nested shim signs cleanly.** Signing inside-out (shim with its own identifier, then the bundle, never `--deep`) passes `codesign --verify --strict --deep`, and both login-item kinds register. Notarization is still the open half.

## Results, Linux arm64 (Docker), 2026-10-08

The Linux runs used:
- Debian trixie with GNOME Shell 48.7, run as a real `gnome-session` under systemd and logind, with `gnome-shell --headless --virtual-monitor`.
- Ubuntu 24.04 with GNOME Shell 46, to repeat the GNOME checks.
- Chromium: Debian Chromium 154 and Playwright's Chromium 156.

`dbus-run-session -- gnome-shell --headless` alone does not start, because gnome-shell needs logind on the system bus.

### Tray on stock GNOME

| Check | Result |
| --- | --- |
| Stock GNOME, no extension | No `org.kde.StatusNotifierWatcher`. The app prints "tray unavailable" and keeps serving |
| Indicator extension on (Debian and Ubuntu ship it as `ubuntu-appindicators@ubuntu.com`, off by default) | The watcher appears and our item is registered. gnome-shell reads the item and its dbusmenu, and Quit through the menu works |
| App started at login (XDG autostart) | **Before the fix: no tray in 5 of 5 logins.** gnome-session starts the app about 0.8 s before the shell's extension owns the watcher, and ksni gave up after one try. **With `assume_sni_available(true)`: tray in 5 of 5**, Debian and Ubuntu alike. It also recovers when the extension is turned off and on again |
| Stale item after a quit or SIGKILL | dropped by the shell in about 0.5 s |

### Native messaging

The harness, run headless on Chromium, passes every check in all three setups below:

| Setup | One-shot p50 | Port p50 |
| --- | --- | --- |
| GNOME session with a tray | 3–4.6 ms | 0.3–0.4 ms |
| Session bus, no watcher | 2.6–7.4 ms | 0.3–0.6 ms |
| No session bus, `XDG_RUNTIME_DIR` unset (socket falls back to `~/.local/state`) | 2.5–3.8 ms | 0.3 ms |

The remaining harness checks pass in every setup:
- `openGuard` launches the app in about 54 ms through `setsid`, and the app survives the browser closing.
- Single instance holds: 1 of 5 copies keeps running.
- The stale socket is reclaimed.

### Autostart, sizes and manifests

- **Autostart file.** `~/.config/autostart/*.desktop` with `NoDisplay=true` and `X-GNOME-Autostart-enabled=true` passes `desktop-file-validate`. gnome-session 48 and 46 start the app at login, and `X-GNOME-Autostart-enabled=false` stops it.
- **Sizes.** The app is 2.3 MB and the shim 0.4 MB. Neither links libdbus or GTK; they need only libc, libgcc_s and libm. The glibc floor is the build host's, so ship from an older base image for Debian 12 and Ubuntu 22.04.
- **Manifest lookup.** Chromium reads per-user manifests from `<user-data-dir>/NativeMessagingHosts`. That is `~/.config/chromium/…` only for the default profile. System directories differ by build: Chromium uses `/etc/chromium/…`, and Chrome for Testing uses `/etc/opt/chrome_for_testing/…`. Branded Chrome (`~/.config/google-chrome/…`) and snap Chromium were not tested.

### Findings for v1

1. **The tray must wait for the indicator watcher.** At login the app starts before the shell is ready. Without `assume_sni_available(true)`, a login-started app on GNOME never shows its icon. The fix is in this branch.
2. **Stock GNOME, Fedora and Debian have no indicator extension enabled.** There the app is a background process with no icon; the only way to quit is `anon-guard quit` or the wallet. This needs a product decision: either the wallet becomes the UI there, or setup offers to enable the extension.
3. **The Linux build needs an old glibc base** to run on older distributions.

## Windows

`.github/workflows/device-guard-spike.yml` runs the same harness on `windows-2025` and `windows-11-arm`. It writes the HKCU registration a per-user installer would write, and checks whether the app escapes Chrome's job object.

The first two runs only exposed harness bugs, and the Rust build passed on both runners each time:
- A `D:\` path was taken as a package name.
- A `start`ed app inherited the harness's pipes, so the harness waited for it forever.

Results pending.
