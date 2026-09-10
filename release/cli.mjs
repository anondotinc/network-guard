#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importApk } from './android.mjs';
import { packageHelper } from './helper.mjs';
import { assertCatalog } from './catalog.mjs';
import { checksumText, invariant, jsonBytes, loadVerifiedCatalog, parseArgs, required, verifyArtifacts, writeNew } from './lib.mjs';
import { createPublicArtifactVerifier, createR2Transport, publishPlan, publishVerified } from './publish.mjs';
import { prepareMetadataSigner, signMetadataBundle } from './metadata.mjs';
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
catalog --release FILE --artifacts DIR --out FILE [--publish]
  [--previous FILE --previous-signature FILE --public-key FILE]
withdraw --catalog FILE --signature FILE --public-key FILE --product PRODUCT
  --version VERSION --build-id ID --reason TEXT --out FILE
sign --catalog FILE --artifacts DIR --private-key FILE [--public-key FILE] --out DIR
  Public key defaults to the pinned Anon release-metadata key, never a derived trust key.
verify --catalog FILE --signature FILE --public-key FILE [--artifacts DIR] [--sums FILE]
publish --catalog FILE --signature FILE --public-key FILE --artifacts DIR
  [--execute --account-id ID --bucket NAME --confirm-dedicated-bucket NAME]

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
  } else if (command === 'catalog') {
    const args = parseArgs(tail, { values: ['release', 'artifacts', 'out', 'previous', 'previous-signature', 'public-key'], booleans: ['publish'] });
    const release = JSON.parse(await readFile(required(args, 'release'), 'utf8'));
    assertCatalog({ schemaVersion: 1, releases: [release] });
    invariant(release.status === 'unreleased', 'Only a newly inspected unreleased record may be added');
    const base = args.previous ? (await loadVerifiedCatalog({ catalog: args.previous, signature: required(args, 'previous-signature'), publicKey: required(args, 'public-key') })).catalog : { schemaVersion: 1, releases: [] };
    const catalog = assertCatalog({ ...base, releases: [...base.releases, { ...release, status: args.publish ? 'published' : 'unreleased' }] });
    await verifyArtifacts(catalog, required(args, 'artifacts'));
    await writeNew(required(args, 'out'), jsonBytes(catalog));
    console.log(JSON.stringify({ candidateCreated: true, activated: false, releases: catalog.releases.length }));
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
    const args = parseArgs(tail, { values: ['catalog', 'artifacts', 'private-key', 'public-key', 'out'] });
    const bytes = await readFile(required(args, 'catalog'));
    const signer = await prepareMetadataSigner({ privateKey: required(args, 'private-key'), publicKey: args['public-key'] });
    console.log(JSON.stringify(await signMetadataBundle({ bytes, artifacts: required(args, 'artifacts'), out: required(args, 'out'), signer })));
  } else if (command === 'verify' || command === 'publish') {
    const args = parseArgs(tail, { values: ['catalog', 'signature', 'public-key', 'artifacts', ...(command === 'verify' ? ['sums'] : ['account-id', 'bucket', 'confirm-dedicated-bucket'])], booleans: command === 'publish' ? ['execute'] : [] });
    const publicKeyPath = required(args, 'public-key');
    const loaded = await loadVerifiedCatalog({ catalog: required(args, 'catalog'), signature: required(args, 'signature'), publicKey: publicKeyPath, artifacts: command === 'publish' ? required(args, 'artifacts') : args.artifacts });
    if (command === 'verify') {
      if (args.sums) invariant(await readFile(args.sums, 'utf8') === checksumText(loaded.catalog), 'SHA256SUMS does not match authenticated metadata');
      console.log(JSON.stringify({ signatureVerified: true, schemaVerified: true, artifactHashesVerified: args.artifacts ? loaded.verified.length : null, offline: true, note: 'Artifact hashes authenticate the signed catalog. Platform installer/signature trust must also be checked on the target OS.' }));
    } else if (!args.execute) console.log(JSON.stringify(publishPlan(loaded), null, 2));
    else {
      invariant(loaded.catalog.releases.every((r) => r.channel === 'stable'), 'Live release publishing refuses test catalogs and fixture channels');
      const bucket = required(args, 'bucket');
      invariant(required(args, 'confirm-dedicated-bucket') === bucket, 'Confirm the dedicated release bucket name exactly');
      const transport = createR2Transport({ accountId: required(args, 'account-id'), bucket, accessKeyId: process.env.ANON_RELEASE_R2_ACCESS_KEY_ID, secretAccessKey: process.env.ANON_RELEASE_R2_SECRET_ACCESS_KEY });
      console.log(JSON.stringify(await publishVerified({ ...loaded, publicKey: await readFile(publicKeyPath), sums: checksumText(loaded.catalog) }, transport, createPublicArtifactVerifier())));
    }
  } else throw new Error('Unknown command. Run release/cli.mjs help.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`Release operation refused: ${error.message}`); process.exitCode = 1; });
}
