# Changelog

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
