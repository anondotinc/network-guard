# Changelog

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
