# Releasing the Device Guard app on macOS

This is the design record for shipping the [Device Guard app](../device/README.md)
as a signed macOS download. It is a plan, not a release. The app is a
development build today, and nothing here makes it available. The
[release checklist](release-checklist.md) and the [operator runbook](../release/OPERATOR.md)
still govern every publication step.

## Goal

Ship the Device Guard app on macOS with the same assurance as the helper:
Developer ID signing, notarization, a stapled ticket, Gatekeeper acceptance, a
signed catalog, and an immutable GitHub release.

## Decisions

1. **The production app embeds its own helper and installs itself.** It runs only
   from `~/Applications` or `/Applications`. On first launch it asks once whether
   to connect Anon in Chrome and whether to start at login. **Remove** gives the
   browser registration back to a Setup-installed helper, and only if that helper
   still matches its receipt digest. The app never replaces a foreign registration.
2. **A new catalog product, `device-guard`,** shares the helper's version and tag
   (`v<version>-<build>`). Both ZIPs go on one immutable GitHub release. The app's
   asset is `anon-network-guard-app-<version>-<build>-universal.zip`. The rules
   are in [the release catalog contract](../CONTRACTS.md#release-catalog-v1) and
   [the release tooling](../release/README.md#products).
3. **The artifact is a ZIP of the stapled universal app,** the shape catalog v1
   already allows for macOS.
4. **Once the app ships,** the website offers it as the macOS download in place of
   the Setup helper. The Setup's catalog history stays: catalog history is never
   removed, only withdrawn.

## Release gates (macOS)

Each gate needs its minimal proof before a candidate is signed.

| Gate | Minimal proof |
| --- | --- |
| Bridge cache across sleep | A test in which the clock jumps over a sleep. A read cached before it is never served after it. |
| The `launchctl kickstart` path | The shim's decision to kickstart or to `open` is tested against real `launchctl print` output saved as fixtures. |
| A real end-to-end install | The native end-to-end test installs the production-mode app into a temporary home and drives it from Chromium with a key-pinned test extension. |
| Quarantine and first launch | A quarantined download of the stapled ZIP opens under Gatekeeper with no override (acceptance A1). |
| The universal build | Both slices of the app, its embedded helper and its host shim are present and signed by the same identity. |
| The stapled layout | The ticket is in `Contents/CodeResources`, in the packaged ZIP. `stapler validate` and `spctl --assess` accept the extracted app, and nothing is added to the bundle after stapling. |
| Setup coexistence | Tests in temporary homes cover no Setup, a Setup helper with a matching receipt, an edited receipt, and a foreign registration. |
| Location and the update handoff | The app refuses to run outside `~/Applications` and `/Applications`. Replacing it with the next version hands the registration over without a gap. |
| Third-party notices and security wording | The Rust crates' licences ship in the app and the repository. The README and SECURITY.md describe a background app with a tray icon and a login item, not a helper with no background process. |

The Windows named-pipe access control and the Windows static C runtime are not
macOS gates. They block a Windows release only.

## Acceptance runs

Run these on signed candidates, before publishing. Cross-compilation is not
Intel acceptance.

| Run | What it shows |
| --- | --- |
| A1 | Quarantine and Gatekeeper: a browser-downloaded ZIP extracts and opens with no override, and `spctl --assess` accepts the stapled app. |
| A2 | A clean account with the production extension: the app installs itself, asks once, and the wallet reports it connected. |
| A3 | Open from the wallet starts the app under launchd. |
| A4 | Sleep and wake: the wallet shows current state after wake, not a reply cached before sleep. |
| A5 | Migration from Setup 0.1.5: the app takes over the registration, and Remove gives it back only on a matching receipt digest. |
| A6 | Update from N to N+1 keeps the registration and the user's choices. |
| A7 | Uninstall, and trashing the app without Remove: neither leaves a registration that points at a missing app, and the wallet reports each state correctly. |
| A8 | A1 to A3 on an Intel Mac with macOS 13. |

## Plan

- **Wave 1.** Universal bundle. Sleep-safe cache. The catalog product (this
  change). Setup coexistence. `launchctl kickstart` fixtures. Third-party notices.
- **Wave 2.** The embedded helper and a bundle-mode bridge. The app owns the
  browser registration: CLI, tray, the first-launch prompt and the update
  handoff. A production mode for the native end-to-end test.
- **Wave 3.** `package-device`, sharing Apple signing code with the helper packager.
- **Wave 4.** The website's catalog code is updated and deployed. This must come
  before any activation: a validator without the product rejects the whole
  catalog, not only the new record.
- **Wave 5.** The release candidate: signing, the acceptance runs, one GitHub
  release with both ZIPs, chained catalog candidates (the helper's, then the
  app's, each built on the last) and one activation.
- **Wave 6.** The website import and setup page.

The catalog product lands in Wave 1, ahead of the packaging command, so the
website's validator can be deployed first. Accepting the product in the catalog
publishes nothing.
