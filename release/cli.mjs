#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importApk } from './android.mjs';
import { packageHelper } from './helper.mjs';
import { packageLinux } from './linux.mjs';
import { packageWindows } from './windows.mjs';
import { assertCatalog } from './catalog.mjs';
import { checksumText, invariant, jsonBytes, loadVerifiedCatalog, parseArgs, required, verifyArtifacts, writeNew } from './lib.mjs';
import { createPublicArtifactVerifier, createR2Transport, publishPlan, publishVerified } from './publish.mjs';
import { prepareMetadataSigner, signMetadataBundle, trustedMetadataKeyPath } from './metadata.mjs';
export { privateKeyOutsideRepositories } from './metadata.mjs';

const help = `Anon release tooling (Node 22+, no npm dependencies)

import-apk --apk PATH --expected-signer SHA256 --version VERSION --build-id CODE
  --released-at UTC --out DIR [--aapt PATH] [--apksigner PATH] [--channel stable|test] [--notes FILE]
package-helper --app PATH --version VERSION --build-id ID --out DIR
  [--channel test]  (unsigned local test archive only)
  Production signing additionally requires --execute-signing --identity NAME --team-id TEAM
  --notary-profile KEYCHAIN_PROFILE --released-at UTC --channel stable
  --metadata-private-key FILE [--metadata-public-key FILE]
  Signed packaging also verifies artifacts and signs inactive metadata in OUT/metadata.
package-linux --folder PATH --version VERSION --build-id ID --out DIR
  [--channel test]  (local test archive only)
  Stable packaging requires --channel stable --released-at UTC and signs inactive
  metadata with --metadata-private-key FILE [--metadata-public-key FILE].
  PATH is a folder staged by scripts/build-linux.mjs. Linux artifacts carry no OS
  signature; the signed catalog's SHA-256 is their authenticity.
package-windows --folder PATH --version VERSION --build-id ID --out DIR
  [--channel test]  (unsigned local test archive only)
  Stable packaging requires --channel stable --released-at UTC --signer-subject CN
  and --metadata-private-key FILE [--metadata-public-key FILE]. Both executables
  must already be Authenticode-signed and timestamped by that publisher; this
  command verifies them with osslsigncode and never signs anything.
catalog --release FILE --artifacts DIR --out FILE [--publish]
  [--previous FILE --previous-signature FILE --public-key FILE]
withdraw --catalog FILE --signature FILE --public-key FILE --product PRODUCT
  --version VERSION --build-id ID --reason TEXT --out FILE
sign --catalog FILE --artifacts DIR --private-key FILE [--public-key FILE] --out DIR
  [--previous FILE --previous-signature FILE]
  Public key defaults to the pinned Anon release-metadata key, never a derived trust key.
verify --catalog FILE --signature FILE --public-key FILE [--artifacts DIR] [--sums FILE]
  [--previous FILE --previous-signature FILE]
publish --catalog FILE --signature FILE --public-key FILE --artifacts DIR
  [--previous FILE --previous-signature FILE]
  [--execute --account-id ID --bucket NAME --confirm-dedicated-bucket NAME]

Every artifact needs a verified local copy under --artifacts, except unchanged history:
with an earlier catalog that verifies under the trusted public key (--previous and its
detached --previous-signature, authenticated by --public-key; for sign, the signing
public key), a release whose artifacts, releasedAt and channel are identical in that
catalog and not withdrawn here may omit its local copy. A copy that is present is still
verified, and new or changed artifacts always need one. publish --execute never uploads
such an artifact: it verifies the stored R2 object against the signed hash, refuses if
it is absent, and still downloads every artifact from its public URL. Execute takes its
history from the authenticated active remote catalog; a --previous must equal that.

All output paths must be new. Nothing downloads, uploads, signs an app, or invokes
Apple notarization unless the corresponding explicit execution option is supplied.
publish defaults to an offline dry run and does not read credentials.
`;
async function notesFrom(args) {
  if (!args.notes) return [];
  const notes = JSON.parse(await readFile(args.notes, 'utf8'));
  invariant(Array.isArray(notes), '--notes must point to a JSON string array');
  return notes;
}
// An optional earlier catalog that must verify under the command's trusted public key (a path). Only an
// authenticated catalog may excuse a missing local copy of a historical artifact.
async function previousFrom(args, publicKey) {
  if (!args.previous) { invariant(!args['previous-signature'], '--previous-signature requires --previous'); return undefined; }
  const signature = required(args, 'previous-signature');
  invariant(publicKey, 'Required: --public-key');
  return loadVerifiedCatalog({ catalog: args.previous, signature, publicKey });
}
// Present only when some artifacts were excused from a local copy, so full-copy output is unchanged.
const withoutLocalCopy = (verified) => { const count = verified.filter((entry) => entry.path === null).length; return count ? { artifactsWithoutLocalCopy: count } : {}; };
export async function main(argv) {
  const [command, ...tail] = argv;
  if (!command || command === 'help' || command === '--help') { console.log(help); return; }
  if (command === 'import-apk') {
    const args = parseArgs(tail, { values: ['apk', 'expected-signer', 'version', 'build-id', 'released-at', 'out', 'aapt', 'apksigner', 'channel', 'notes'] });
    const release = await importApk({ apk: required(args, 'apk'), signer: required(args, 'expected-signer'), version: required(args, 'version'), buildId: required(args, 'build-id'), releasedAt: required(args, 'released-at'), out: required(args, 'out'), aapt: args.aapt, apksigner: args.apksigner, channel: args.channel, notes: await notesFrom(args) });
    console.log(JSON.stringify({ imported: true, status: release.status, product: release.product, version: release.version, buildId: release.buildId, signatureVerified: true }));
  } else if (command === 'package-helper') {
    const args = parseArgs(tail, { values: ['app', 'version', 'build-id', 'released-at', 'out', 'channel', 'identity', 'team-id', 'notary-profile', 'notes', 'metadata-private-key', 'metadata-public-key'], booleans: ['execute-signing'] });
    invariant(args['execute-signing'] || (!args['metadata-private-key'] && !args['metadata-public-key']), 'Metadata signing requires a signed, notarized helper');
    const signer = args['execute-signing'] ? await prepareMetadataSigner({ privateKey: required(args, 'metadata-private-key'), publicKey: args['metadata-public-key'] }) : null;
    const result = await packageHelper({ app: required(args, 'app'), version: required(args, 'version'), buildId: required(args, 'build-id'), releasedAt: args['released-at'], out: required(args, 'out'), channel: args.channel, identity: args.identity, teamId: args['team-id'], notaryProfile: args['notary-profile'], executeSigning: !!args['execute-signing'], notes: await notesFrom(args) });
    const metadata = signer ? await signMetadataBundle({ bytes: jsonBytes({ schemaVersion: 1, releases: [result] }), artifacts: args.out, out: join(args.out, 'metadata'), signer }) : null;
    console.log(JSON.stringify({ packaged: true, publicCatalogEligible: result.publishable !== false, filename: result.filename ?? result.artifacts[0].filename, metadata }));
  } else if (command === 'package-linux') {
    const args = parseArgs(tail, { values: ['folder', 'version', 'build-id', 'released-at', 'out', 'channel', 'notes', 'metadata-private-key', 'metadata-public-key'] });
    const stable = args.channel === 'stable';
    invariant(stable || (!args['metadata-private-key'] && !args['metadata-public-key']), 'Metadata signing is only for stable packages');
    const signer = stable ? await prepareMetadataSigner({ privateKey: required(args, 'metadata-private-key'), publicKey: args['metadata-public-key'] }) : null;
    const result = await packageLinux({ folder: required(args, 'folder'), version: required(args, 'version'), buildId: required(args, 'build-id'), releasedAt: stable ? required(args, 'released-at') : args['released-at'], out: required(args, 'out'), channel: args.channel, notes: await notesFrom(args) });
    const metadata = signer ? await signMetadataBundle({ bytes: jsonBytes({ schemaVersion: 1, releases: [result] }), artifacts: args.out, out: join(args.out, 'metadata'), signer }) : null;
    console.log(JSON.stringify({ packaged: true, publicCatalogEligible: result.publishable !== false, filename: result.filename ?? result.artifacts[0].filename, metadata }));
  } else if (command === 'package-windows') {
    const args = parseArgs(tail, { values: ['folder', 'version', 'build-id', 'released-at', 'out', 'channel', 'notes', 'signer-subject', 'metadata-private-key', 'metadata-public-key'] });
    const stable = args.channel === 'stable';
    invariant(stable || (!args['metadata-private-key'] && !args['metadata-public-key']), 'Metadata signing is only for stable packages');
    const signer = stable ? await prepareMetadataSigner({ privateKey: required(args, 'metadata-private-key'), publicKey: args['metadata-public-key'] }) : null;
    const result = await packageWindows({ folder: required(args, 'folder'), version: required(args, 'version'), buildId: required(args, 'build-id'), releasedAt: stable ? required(args, 'released-at') : args['released-at'], out: required(args, 'out'), channel: args.channel, notes: await notesFrom(args), signerSubject: stable ? required(args, 'signer-subject') : args['signer-subject'] });
    const metadata = signer ? await signMetadataBundle({ bytes: jsonBytes({ schemaVersion: 1, releases: [result] }), artifacts: args.out, out: join(args.out, 'metadata'), signer }) : null;
    console.log(JSON.stringify({ packaged: true, publicCatalogEligible: result.publishable !== false, filename: result.filename ?? result.artifacts[0].filename, metadata }));
  } else if (command === 'catalog') {
    const args = parseArgs(tail, { values: ['release', 'artifacts', 'out', 'previous', 'previous-signature', 'public-key'], booleans: ['publish'] });
    const release = JSON.parse(await readFile(required(args, 'release'), 'utf8'));
    assertCatalog({ schemaVersion: 1, releases: [release] });
    invariant(release.status === 'unreleased', 'Only a newly inspected unreleased record may be added');
    const previous = await previousFrom(args, args['public-key']);
    const base = previous ? previous.catalog : { schemaVersion: 1, releases: [] };
    const catalog = assertCatalog({ ...base, releases: [...base.releases, { ...release, status: args.publish ? 'published' : 'unreleased' }] });
    const verified = await verifyArtifacts(catalog, required(args, 'artifacts'), { previous: previous?.catalog });
    await writeNew(required(args, 'out'), jsonBytes(catalog));
    console.log(JSON.stringify({ candidateCreated: true, activated: false, releases: catalog.releases.length, ...withoutLocalCopy(verified) }));
  } else if (command === 'withdraw') {
    const args = parseArgs(tail, { values: ['catalog', 'signature', 'public-key', 'product', 'version', 'build-id', 'reason', 'out'] });
    const loaded = await loadVerifiedCatalog({ catalog: required(args, 'catalog'), signature: required(args, 'signature'), publicKey: required(args, 'public-key') });
    const reason = required(args, 'reason');
    const target = loaded.catalog.releases.find((r) => r.product === required(args, 'product') && r.version === required(args, 'version') && r.buildId === required(args, 'build-id'));
    invariant(target && target.status === 'published', 'Exact published release not found');
    target.status = 'withdrawn'; target.notes.push(`Withdrawn: ${reason}`);
    assertCatalog(loaded.catalog);
    await writeNew(required(args, 'out'), jsonBytes(loaded.catalog));
    console.log(JSON.stringify({ withdrawalCandidateCreated: true, activated: false }));
  } else if (command === 'sign') {
    const args = parseArgs(tail, { values: ['catalog', 'artifacts', 'private-key', 'public-key', 'out', 'previous', 'previous-signature'] });
    const bytes = await readFile(required(args, 'catalog'));
    const publicKey = args['public-key'] ?? trustedMetadataKeyPath;
    const signer = await prepareMetadataSigner({ privateKey: required(args, 'private-key'), publicKey });
    // The previous catalog is authenticated with the same trusted key that signs, inside signMetadataBundle.
    const previous = await previousFrom(args, publicKey);
    console.log(JSON.stringify(await signMetadataBundle({ bytes, artifacts: required(args, 'artifacts'), out: required(args, 'out'), signer, previous })));
  } else if (command === 'verify' || command === 'publish') {
    const args = parseArgs(tail, { values: ['catalog', 'signature', 'public-key', 'artifacts', 'previous', 'previous-signature', ...(command === 'verify' ? ['sums'] : ['account-id', 'bucket', 'confirm-dedicated-bucket'])], booleans: command === 'publish' ? ['execute'] : [] });
    const publicKeyPath = required(args, 'public-key');
    invariant(command === 'publish' || !args.previous || args.artifacts, '--previous only applies together with --artifacts');
    const previous = await previousFrom(args, publicKeyPath);
    // Execute alone cannot yet know the history: the active remote catalog is authenticated inside publishVerified,
    // which refuses any artifact lacking both a local copy and proof of being unchanged, before any upload.
    const loaded = await loadVerifiedCatalog({ catalog: required(args, 'catalog'), signature: required(args, 'signature'), publicKey: publicKeyPath, artifacts: command === 'publish' ? required(args, 'artifacts') : args.artifacts, previous: previous?.catalog, deferMissing: !previous && !!args.execute });
    if (command === 'verify') {
      if (args.sums) invariant(await readFile(args.sums, 'utf8') === checksumText(loaded.catalog), 'SHA256SUMS does not match authenticated metadata');
      console.log(JSON.stringify({ signatureVerified: true, schemaVerified: true, artifactHashesVerified: args.artifacts ? loaded.verified.filter((entry) => entry.path !== null).length : null, offline: true, note: 'Artifact hashes authenticate the signed catalog. Platform installer/signature trust must also be checked on the target OS.', ...withoutLocalCopy(loaded.verified) }));
    } else if (!args.execute) console.log(JSON.stringify(publishPlan(loaded), null, 2));
    else {
      invariant(loaded.catalog.releases.every((r) => r.channel === 'stable'), 'Live release publishing refuses test catalogs and fixture channels');
      const bucket = required(args, 'bucket');
      invariant(required(args, 'confirm-dedicated-bucket') === bucket, 'Confirm the dedicated release bucket name exactly');
      const transport = createR2Transport({ accountId: required(args, 'account-id'), bucket, accessKeyId: process.env.ANON_RELEASE_R2_ACCESS_KEY_ID, secretAccessKey: process.env.ANON_RELEASE_R2_SECRET_ACCESS_KEY });
      console.log(JSON.stringify(await publishVerified({ ...loaded, publicKey: await readFile(publicKeyPath), sums: checksumText(loaded.catalog), previousCatalogBytes: previous?.bytes }, transport, createPublicArtifactVerifier())));
    }
  } else throw new Error('Unknown command. Run release/cli.mjs help.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`Release operation refused: ${error.message}`); process.exitCode = 1; });
}
