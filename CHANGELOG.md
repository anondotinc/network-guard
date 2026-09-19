# Changelog

## 0.1.4 — build 7 — published (2026-09-17)

- Signed and notarized universal macOS production installer published to R2.
  Includes Proton app launch and read-only WireGuard status from 0.1.2/0.1.3.
- Production builds reject the SOCKS5 transport; the following RPC pilot is
  available only in development builds.

- Development-only v7 HTTP JSON-RPC transport through a user-selected SOCKS5
  proxy, with proxy-side target DNS, TLS verification and no direct fallback.
- Separate capability negotiation and bounded native frames; existing VPN
  protocols keep their 4 KiB frame limits and local-only contracts.
- Synthetic socket tests cover proxy refusal/unavailability, remote hostname
  handoff, redirect rejection and oversized responses. This is an RPC pilot,
  not wallet-wide leak protection or a production Tor integration.

## 0.1.3 — build 6 — development (2026-09-17)

- Add explicit Proton VPN 6.5.1 WireGuard status checks through macOS. Validate
  the signed app and exact profile identity, then read bounded `scutil --nc status`
  output. Return only normalized tunnel state; routing protection stays unknown.
- Add v6 Proton status without changing v1–v5. App launch remains available with
  0.1.2; status requires 0.1.3. Missing, disabled, ambiguous or unsupported profiles
  fail closed. No Proton connection command is added; the extension may refresh read-only
  status while Proton is selected and local access is allowed.
- Cover identity failures, deadlines, redaction, protocol compatibility, upgrade
  recovery and manual status transitions with injected tests.

This source candidate is not a signed, notarized or published release.

## 0.1.2 — build 5 — development (2026-09-17)

- Add installation verification and explicit app launch for Proton VPN on macOS.
  No Proton connection/status API is assumed; manage connections in Proton VPN.
- Add a narrow v5 `protonvpn` probe/open contract. v1–v4 replies and existing
  providers retain their previous schemas for installed extension compatibility.
- Pin the official Proton app identity and test fixed commands, signature failures,
  unsupported operations, old-helper rejection, and absence of auto-connect/status.

This source candidate is not a signed, notarized or published release.

## Release tooling

- Pin the dedicated Anon Ed25519 application release key and publish its public
  discovery record. Android and Network Guard use the same metadata trust root;
  platform-signing and paymaster keys are unchanged.
- Check metadata key identity before Apple submission. Explicit signed helper
  packaging now creates a verified, signed inactive catalog after final hashing.
- Add wrong-key, corrupt-file, safe-output and private-key storage regressions.
- Reject a release build number that differs from the setup app before signing
  or Apple submission; existing binaries cannot be relabeled as a new build.
- Share catalog transition checks with site importers so signed older catalogs
  cannot silently remove release history or reactivate withdrawn downloads.
- Use `downloads.anon.inc` for new Android artifacts while preserving previously
  signed legacy URLs. No VPN operation, native protocol or installer change.
- Read R2 metadata with `accept-encoding: identity`. A compressed response
  carries a weak ETag, which cannot serve as the compare-and-swap validator when
  an existing catalog is replaced; activation refused rather than overwriting.
  Only the first-ever publication, which finds no active catalog, avoided this.

## 0.1.1 — build 4 — signing candidate (2026-09-09)

- Fresh candidate for Developer ID signing and Apple notarization verification.
- No changes to VPN operations, extension enrollment or traffic-blocking limits.

Public distribution remains gated on verified artifacts and clean-Mac acceptance.
This source entry does not by itself attest to signing or notarization of a build.

## 0.1.1 — build 3 — pre-launch review (2026-09-08)

- Shared version/build metadata across native discovery, Setup and test packaging.
- Version visible in Setup; installed-versus-bundled version guidance on check.
- Anon installer icon, setup and release-information links, with separate asset
  licensing preserved.
- Receipt-owned registration repair tolerates display-name changes without
  relaxing channel, origin or ownership checks.
- Universal development/production test disk images with SHA-256 and explicit
  unsigned/non-public metadata. No automatic installation or update requests.

This is not a signed, notarized or publicly downloadable release. Version 0.1.0
remains protocol compatible; no new VPN operations or blocking were added.

## 0.1.0 — initial development preview

- Standalone user-only setup, native discovery, existing narrowly scoped provider
  adapters, release import/signing/verification tooling and channel isolation.
