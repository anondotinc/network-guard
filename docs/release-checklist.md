# Publication and release checklist

Publishing source for review is separate from approving a downloadable installer.
This repository describes a development preview; neither a green CI run nor the
Network Guard name is a network-protection guarantee.

## Public source preview

- [ ] Owner approves publication and confirms the scoped MIT code grant and
  separately licensed brand artwork. [Provenance](provenance.md) records the scope;
  do not infer that the wallet or icon has been relicensed under MIT.
- [ ] Review the exact source commit, retained history and tracked file list.
  Run source hygiene, native/setup and release-tooling tests. Inspect CI logs before
  changing visibility; squashing is not deletion of old GitHub objects.
- [ ] Confirm the private contact in [SECURITY.md](../SECURITY.md) is monitored.
- [ ] The owner changes visibility when ready. Immediately enable GitHub private
  vulnerability reporting, secret scanning/push protection where available, and
  protect `master` with review and the `Source, tests and universal builds` check.
  Restrict force pushes after the initial source-history cleanup.
- [ ] Check the repository and source links signed out. Update website access
  labels only after public access works. Do not publish a release or artifact
  merely to make the source link work.

Private vulnerability reporting is a public-repository feature; prepare the email
fallback before the visibility change. GitHub plan restrictions may also prevent
branch protection while the repository remains private. See
[GitHub's reporting setup](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Downloadable installer — separate approval

- [ ] Independently confirm provider signing identities, exact supported versions,
  commands, output parsing and provider side effects from official distributions.
  Preserve the limited IVPN and launch-only NordVPN descriptions.
- [ ] Complete the [manual acceptance matrix](testing.md#what-still-needs-manual-acceptance),
  including a clean production-only Apple-silicon Mac and a real Intel Mac.
- [ ] Approve Developer ID Application identity/key access and notarization profile.
  Sign both executable architectures, refresh the embedded payload digest, sign
  the outer app, notarize/staple and verify Gatekeeper acceptance.
- [ ] Approve external Ed25519 metadata-key custody and independently publish its
  public-key fingerprint. Test keys and upload/debug keys are not release keys.
- [ ] Build from a reviewed commit and record verified provenance. Tag only the
  approved build. Do not infer provenance from a nearby source checkout.
- [ ] Package once; calculate hashes after final packaging. Publish an immutable
  GitHub release only with explicit approval. Verify final downloaded bytes before
  activating the signed catalog and updating the site.

The release scripts cannot make unsigned local DMGs eligible for a stable catalog.
No request-blocking or browser-routing-verification feature is activated by a
source publication, installer signature or release tag.

Follow the [operator runbook](../release/OPERATOR.md) for signing, packaging,
catalog activation, repair and withdrawal. R2/APK release credentials are a
separate maintainer workflow and are never installed with Network Guard.
