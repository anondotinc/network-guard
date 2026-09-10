// Produces an explicitly synthetic, locally verifiable handoff. Never run import-apk
// on this fixture or copy this catalog into the website. Private keys remain in memory.
import { join } from 'node:path';
import { artifactKey, checksumText, jsonBytes, parseArgs, required, verifyArtifacts, writeNew } from '../lib.mjs';
import { publishPlan } from '../publish.mjs';
import { signedFixture, testArtifact } from './fixtures.mjs';

const args = parseArgs(process.argv.slice(2), { values: ['out'] });
const out = required(args, 'out');
const signed = signedFixture();
await writeNew(join(out, artifactKey(signed.catalog.releases[0].artifacts[0])), testArtifact);
await writeNew(join(out, 'catalog.json'), signed.bytes);
await writeNew(join(out, 'catalog.json.sig'), signed.signatureBytes);
await writeNew(join(out, 'metadata-public-key.TEST-ONLY.pem'), signed.publicKey);
await writeNew(join(out, 'SHA256SUMS'), checksumText(signed.catalog));
await writeNew(join(out, 'README-TEST-ONLY.txt'), 'SYNTHETIC TEST FIXTURE. Not an APK, not a release, not a download URL. Private key generated in memory and discarded. Never add this catalog to the website.\n');
const verified = await verifyArtifacts(signed.catalog, out);
await writeNew(join(out, 'publishing-dry-run.json'), jsonBytes(publishPlan({ ...signed, verified })));
console.log(JSON.stringify({ fixture: true, realArtifacts: false, privateKeyWritten: false, networkRequests: 0, catalogVerified: true }));
