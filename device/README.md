# Device Guard app

The Device Guard app keeps Network Guard running for the user. It replaces the
short-lived native host with a per-user app and a thin Chrome host shim. This
crate is the promoted form of the M0 spike in `spikes/device-guard` (kept as
history, with its macOS, Linux and Windows findings).

- **`anon-guard`** is the app. Only one copy runs per user. It shows a tray
  icon, can start at login, and serves a per-user socket. In **bridge mode** it
  answers wallet requests v1–v8 by running the installed helper the way Chrome
  does: one process per request, the same framing, the same origin argument.
  It relays the helper's reply bytes unchanged.
- **`anon-guard-host`** is the Chrome native-messaging host, inside the app
  bundle at `Contents/MacOS/anon-guard-host`. It answers v9 (`appStatus`,
  `openApp`) itself, even when the app is down. It relays everything else to
  the app and answers `appNotRunning` or `appStarting` when it can't. It only
  starts the app for `openApp`, which the wallet sends after a user's click.

The wire contract is [CONTRACTS.md, "Device Guard v9"](../CONTRACTS.md#device-guard-v9).
[`conformance/shim.json`](../conformance/shim.json) pins the shim's replies.

## How a request flows

```
Chrome ──stdio──▶ anon-guard-host ──socket──▶ anon-guard ──stdio──▶ installed helper
          (v9 answered here;                  (bridge: 5 s read      (Swift on macOS,
           malformed ones too)                 cache, ids swapped)    Rust elsewhere)
```

- **Malformed requests** are rejected by the helper's version router before
  any provider is reached. The shim answers them with the router's envelope,
  in every app state. The crate reuses the helper crate's router, so these
  replies are byte-identical to the Swift helper's. The
  `malformed_replies_match_the_compiled_helper_byte_for_byte` test checks this
  against a compiled helper.
- **Bytes only the helper can read.** The crate's parser (serde_json) is
  stricter than the Swift helper's (Foundation). Foundation also reads a
  byte-order mark, UTF-16 and UTF-32, trailing commas and lone surrogates,
  and keeps the first of repeated keys where serde_json keeps the last. Bytes
  that are not strict JSON, or that repeat a top-level key, are therefore the
  installed helper's to answer. While the app runs, the shim relays them and
  the helper's reply comes back unchanged. They are never v9 and never served
  from the cache. While the app can't be reached, the shim answers by its own
  reading, for example `invalidRequest` for a byte-order mark. The
  `helperResponse` cases in `conformance/shim.json` pin where the two differ.
- **A hung app.** A running app answers the socket hello at once. One that is
  alive but silent for 2 s (stopped, deadlocked, in a debugger) counts as not
  running: `appStatus` says so within about 2 s, other requests get
  `appNotRunning`, and the shim never retries into it. Only a real request's
  exchange may take up to 45 s, past the bridge's 30 s helper deadline. If
  the app hangs mid-request on a long-lived port, that one request waits; the
  next ones get a fresh connection and the 2 s bound. `anon-guard status`
  reports `appUnresponsive` (exit 4) instead of `appNotRunning` (exit 3).
- **Finding the helper.** The bridge reads the helper installer's receipt
  (`installation.json`) in its root. On macOS that root is
  `~/Library/Application Support/Anon/NetworkHelper/<channel>`. The version
  comes from `bridge.json` in the app's support directory, or else the newest.
  The helper file must be a regular file owned by the user and not writable
  by others. If none is usable, well-formed requests get `providerUnavailable`.
- **The read cache.** Status, probe, describe and capabilities replies with
  `ok:true`, the request's id and the request's `v` are kept for 5 s from
  when the helper ran, measured on both the monotonic and the wall clock so
  time asleep counts. A hit never extends an entry. A hit returns the
  helper's bytes with only the 36-character id swapped. Connects and provider
  app launches are never cached, and they clear the cache. So does a frame
  the helper may read differently (above), which could be a connect.

## Paths (per user, per channel)

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| App support, `bridge.json` | `~/Library/Application Support/Anon/DeviceGuard/<channel>` | `~/.local/state/anon/device-guard/<channel>` | `%LOCALAPPDATA%\Anon\DeviceGuard\<channel>` |
| Socket, instance and launch locks | `<support>/run`, or `anon-guard-<uid>-<c>-<hash>` in the per-user temp directory when the path is too long for a socket | `$XDG_RUNTIME_DIR/anon-device-guard-<channel>`, else `<support>/run`, else `/tmp/anon-guard-<uid>-<c>-<hash>` | pipe `anon-device-guard-<channel>-<user>`, named mutexes |
| Start at login | LaunchAgent login item in the bundle | `~/.config/autostart/<bundle id>.desktop` | `HKCU\…\CurrentVersion\Run` value |

Everything derives from `HOME` (`LOCALAPPDATA` on Windows), so tests run in a
temporary home. `anon-guard paths` prints them for the current `HOME` and
creates nothing. The tests and `scripts/dev.mjs uninstall` use it to remove a
run directory that lies outside the home. On macOS and Linux the app binds only in a run directory it
owns and has made 0700. The shim and the CLI connect only through such a
directory, and only to a server running as the same user. Another user who
takes the `/tmp` name first can stop the app from starting, but can never
answer for it. macOS login items (`SMAppService`) ignore `HOME`. The
development tooling never registers one outside the account's real home.

## Starting the app (`openApp`)

- **macOS.** If the agent login item is enabled, is this bundle's, and the shim
  runs in the account's home, the shim runs `launchctl kickstart`, so launchd
  keeps owning the process. Otherwise it runs `open -n -g --env HOME=… <bundle>`.
  A shim outside a bundle (cargo tests) starts its sibling directly.
- **Linux.** The sibling binary in a new session (`setsid`).
- **Windows.** `CreateProcessW` with no handle inheritance. The spike found that
  an inherited handle made a browser close hang for 20 s. The shim tries to
  break away from the job first. The app is a `windows_subsystem = "windows"`
  binary, so starting at login opens no console. Registering creates the
  `Run` key when a fresh profile lacks it.

The shim waits up to 10 s for the app to answer. While a launch is in
progress, a lock is held (a `flock` on `starting.lock`, or a named mutex on
Windows). Other shims, and later requests on the same port, answer
`appStarting` while it is held. An app that is alive but not answering is
waited for, not started a second time (the copy would only find it running);
if it goes away during the wait, it is started then.

## Build and test

```sh
cd device
cargo test --features development      # unit, shim fixtures, real binaries in a temp home
cargo test                             # production channel
NETWORK_GUARD_SWIFT_HELPER="$PWD/../dist/development/Anon Network Guard Setup.app/Contents/Resources/anon-network-helper" \
  cargo test --features development --test conformance   # byte parity with the Swift helper (malformed requests only)
node ../scripts/build-device.mjs --channel development   # universal (arm64 + x86_64) macOS 13+ bundle, signed ad hoc unless SIGN_IDENTITY is set
```

The bundle build is universal. It needs both Rust targets
(`rustup target add aarch64-apple-darwin x86_64-apple-darwin`), builds each for
macOS 13 (`MACOSX_DEPLOYMENT_TARGET=13.0`, matching `LSMinimumSystemVersion`) and
joins the two with `lipo`. The `cargo test` commands above build for the host only.

[The README's development install section](../README.md#development-install)
installs and switches variants. [`test/native-e2e.mjs`](test/native-e2e.mjs) drives
the installed host from Chromium with a key-pinned test extension.

## Open items from the spike

- Notarization and the quarantined-download case are still untested (they need
  a notarytool profile).
- Windows named pipe: set an explicit DACL for the current user and check the
  client's SID. On macOS and Linux both ends of the socket already check the peer UID.
- Linux stock GNOME has no tray watcher. There the app runs without an icon.
- Linux builds need an old glibc base to run on older distributions.
