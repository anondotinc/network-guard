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
