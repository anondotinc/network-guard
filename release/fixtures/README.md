# Test fixtures only

The fixture factory in `tests/fixtures.mjs` produces invented versions, SHA-256
values, signing identities, and downloads.anon.inc URLs. Those URLs are syntax
fixtures, not real downloads. Never import fixtures into the lander catalog.

Ed25519 test keypairs are generated in memory per test run and discarded. There
are no production keys, private keys, APKs, installer binaries, or credentials
in this fixture directory or in Git history.
