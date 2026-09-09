# Contributing

Keep changes small and auditable. This project deliberately has no third-party
runtime dependency. Preserve explicit user consent, build-channel isolation,
bounded execution, strict schemas, offline code-signature checks, and redaction.

Open a focused pull request against `master`, explaining the change, threat model
impact and test coverage. Do not include unrelated formatting or generated files.
Report security vulnerabilities privately via [SECURITY.md](SECURITY.md), not an issue.

Run `node scripts/check-source.mjs`,
`node --test release/tests/*.test.mjs scripts/*.test.mjs`,
`node scripts/test-native.mjs` and `node scripts/test-native.mjs -c release`.
Build both setup channels with `node scripts/build-setup.mjs --channel <channel>`.
Do not run real installer actions or VPN mutations as an automated test. Use
temporary homes and injected fake adapters; compiled protocol tests may invoke
`describe` / `capabilities` but never `status` or control methods against real apps.

A provider/version expansion requires vendor provenance, independent signature
identity confirmation, exact command/output review, failure fixtures, deadlines,
and an updated user-facing limitation statement. Do not learn trust pins from
arbitrary locally installed binaries or silently widen accepted versions.

Protocol additions require a versioned contract and compatibility tests. Keep
existing v1–v3 shapes stable, including their historical capability strings. The
setup process must not grant Chrome permission, change consent, connect a VPN, or
replace a foreign registration.

Never commit binaries, secrets, keystores, caches, test reports containing user
paths, wallet logs, or signing credentials. Test keys must remain clearly marked
fixtures. Publication requires the [release checklist](docs/release-checklist.md),
not just a passing build. CI uses a read-only token, pinned actions, no signing
secrets and no artifact publication. See [testing](docs/testing.md).

By contributing Anon-owned changes for inclusion here, retain the MIT notice.
Third-party code needs explicit provenance and compatible terms before inclusion;
do not transplant wallet-licensed code under the assumption this repository's MIT
license overrides the source license.
