# Testing Network Guard

Tests must not require a wallet, provider account, live VPN, signing key or Chrome
registration. Run from the repository root on macOS with Apple command-line tools
and Node.js 22+:

```sh
node scripts/check-source.mjs
node --test release/tests/*.test.mjs scripts/*.test.mjs
node scripts/test-native.mjs
node scripts/test-native.mjs -c release
node scripts/build-setup.mjs --channel production
node scripts/test-wire.mjs --channel production
node scripts/build-setup.mjs --channel development
node scripts/test-wire.mjs --channel development
```

The [CI workflow](../.github/workflows/ci.yml) runs these same checks with read-only
repository permissions and pinned actions. It does not use provider operations,
signing keys, release credentials or upload artifacts. Fork pull requests must
never run through `pull_request_target` or receive secrets.

## What the tests establish

| Layer | Coverage |
| --- | --- |
| Source hygiene | No tracked installers, credential files or obvious token/private-key patterns; local documentation targets exist. This is not a comprehensive secret scanner. |
| Native framing | Frame sizes, malformed/truncated input, session cap, UUIDs, versions, exact enrolled origins and redacted errors. |
| Provider policy | Fake adapters; fixed operations; unknown/conflicting connections; paused/error states; no silent provider fallback. Synthetic subprocesses exercise timeouts and output limits. |
| Installer | Temporary homes and fake bytes; exact registration, interrupted installation/update, repair, foreign-registration refusal, unsafe paths, ownership and bounded uninstall. |
| Build | Exact bundle contents; separate channels; arm64 and x86_64 slices; icon/license/payload/version agreement. |
| Compiled wire | Discovery, legacy capabilities and rejected requests only. No status, probe, connect or open-app call against real providers. |
| Release tooling | Synthetic APK metadata, generated test keys and fake cloud transports. See [coverage](../release/TEST-REPORT.md). |

The 0.1.1 review reran 46 native/setup tests in debug and 46 in release, alongside
the Node tooling tests and both compiled-wire suites. Check the workflow run for
the exact commit under review rather than treating a historical count as approval.

Build outputs stay under ignored `.build/` and `dist/`. Test images are explicitly
unsigned and not notarized. Creating or checking a bundle does not install it.

## What still needs manual acceptance

- A clean Mac with only production Anon, the signed installer and supported VPN;
  no developer extension, checkout, Xcode, Node or terminal registration.
- Actual Chrome permission allowed/denied/revoked, restart, missing/outdated
  helper, channel mismatch and interrupted update behavior.
- Fresh VPN status after closing/reopening the wallet, connected/disconnected
  transitions and preservation of separate auto-connect consent.
- Independent provider identity/version verification from official distributions.
- Setup keyboard and VoiceOver use; real install/repair/uninstall and ownership.
- Signed/notarized distribution and Gatekeeper acceptance on Apple silicon and
  a real Intel Mac. Cross-compilation alone does not establish Intel runtime support.

Live tests must be explicitly authorized. Do not connect/disconnect a real VPN or
change native registrations as a side effect of CI. A reported connected state
still does not prove browser routing or request blocking.
