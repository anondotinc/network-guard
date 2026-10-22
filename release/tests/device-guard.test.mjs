import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCatalog, assertCatalogTransition, GITHUB_RELEASE_PRODUCTS, helperArtifactUrl, helperReleasePage, validateCatalog } from '../catalog.mjs';
import { artifactKey, checksumText, sha256 } from '../lib.mjs';
import { createPublicArtifactVerifier, publishPlan } from '../publish.mjs';
import { fixtureCatalog, signedFixture, testArtifact } from './fixtures.mjs';

const APPLE = { kind: 'apple-developer-id', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test (TESTTEAM00)', notarized: true };
const VERSION = '0.2.0';
const BUILD = '9';
const APP_ZIP = `anon-network-guard-app-${VERSION}-${BUILD}-universal.zip`;
const SETUP_ZIP = `anon-network-guard-${VERSION}-${BUILD}-universal.zip`;

function release(product, filename, overrides = {}) {
  const base = { product, version: VERSION, buildId: BUILD };
  return {
    ...base, releasedAt: '2026-10-22T00:00:00Z', channel: 'stable', status: 'published', notes: ['TEST ONLY.'],
    artifacts: [{ platform: 'macos', architecture: 'universal', minimumOs: 'macOS 13+', filename, bytes: testArtifact.length, sha256: sha256(testArtifact), signing: APPLE, location: helperArtifactUrl(base, filename), ...overrides }],
  };
}
const catalogOf = (...releases) => ({ schemaVersion: 1, releases });
const guard = (overrides) => release('device-guard', APP_ZIP, overrides);
const withArtifact = (mutate) => { const r = guard(); mutate(r.artifacts[0], r); return catalogOf(r); };

test('device-guard is a GitHub release product beside the helper', () => {
  assert.deepEqual([...GITHUB_RELEASE_PRODUCTS], ['network-helper', 'device-guard']);
  assert.throws(() => { GITHUB_RELEASE_PRODUCTS.push('android'); }, TypeError);
});

test('a device-guard record with an official GitHub release asset validates', () => {
  const c = catalogOf(guard());
  assertCatalog(c);
  const r = c.releases[0]; const a = r.artifacts[0];
  assert.equal(a.location, `https://github.com/anondotinc/network-guard/releases/download/v${VERSION}-${BUILD}/${APP_ZIP}`);
  assert.equal(helperReleasePage(r, a), `https://github.com/anondotinc/network-guard/releases/tag/v${VERSION}-${BUILD}`);
});

test('a device-guard record at its versioned R2 path validates and has no release page', () => {
  for (const origin of ['https://downloads.anon.inc', 'https://release.anon.inc']) {
    const c = catalogOf(guard({ location: `${origin}/device-guard/${VERSION}/${BUILD}/${APP_ZIP}` }));
    assertCatalog(c);
    assert.equal(helperReleasePage(c.releases[0], c.releases[0].artifacts[0]), undefined);
    assert.equal(artifactKey(c.releases[0].artifacts[0], c.releases[0]), `device-guard/${VERSION}/${BUILD}/${APP_ZIP}`);
  }
});

test('device-guard accepts every status and channel the helper does, and an unreleased record needs no artifact', () => {
  const unreleased = guard(); unreleased.status = 'unreleased'; unreleased.artifacts = [];
  assertCatalog(catalogOf(unreleased));
  const test_ = guard(); test_.channel = 'test'; assertCatalog(catalogOf(test_));
  const withdrawn = guard(); withdrawn.status = 'withdrawn'; assertCatalog(catalogOf(withdrawn));
  const published = guard(); published.artifacts = []; assert.equal(validateCatalog(catalogOf(published)).valid, false);
});

for (const [label, mutate] of [
  ['a Linux artifact', (a) => { a.platform = 'linux'; a.architecture = 'x86_64'; a.filename = 'app.tar.gz'; a.signing = { kind: 'catalog-sha256' }; a.location = helperArtifactUrl({ version: VERSION, buildId: BUILD }, 'app.tar.gz'); }],
  ['a Windows artifact', (a) => { a.platform = 'windows'; a.architecture = 'x86_64'; a.signing = { kind: 'authenticode', subject: 'Test', timestamped: true }; }],
  ['an Android artifact', (a) => { a.platform = 'android'; }],
  ['an arm64-only macOS artifact', (a) => { a.architecture = 'arm64'; }],
  ['an x86_64-only macOS artifact', (a) => { a.architecture = 'x86_64'; }],
  ['an arm64-x86_64 artifact', (a) => { a.architecture = 'arm64-x86_64'; }],
  ['an unsigned macOS artifact', (a) => { a.signing = { kind: 'catalog-sha256' }; }],
  ['a macOS artifact that is not notarized', (a) => { a.signing = { ...APPLE, notarized: false }; }],
  ['a macOS artifact that is not a zip', (a, r) => { a.filename = 'anon.dmg'; a.location = helperArtifactUrl(r, a.filename); }],
  ['a GitHub asset on the wrong tag', (a) => { a.location = a.location.replace(`/v${VERSION}-${BUILD}/`, '/latest/'); }],
  ['a GitHub asset from another repository', (a) => { a.location = a.location.replace('/anondotinc/', '/attacker/'); }],
  ['a GitHub asset with a query', (a) => { a.location = `${a.location}?other=1`; }],
  ['an R2 path for another product', (a) => { a.location = `https://downloads.anon.inc/network-helper/${VERSION}/${BUILD}/${APP_ZIP}`; }],
  ['an unrelated host', (a) => { a.location = `https://example.com/device-guard/${VERSION}/${BUILD}/${APP_ZIP}`; }],
]) test(`device-guard rejects ${label}`, () => {
  const result = validateCatalog(withArtifact(mutate));
  assert.equal(result.valid, false);
  assert.throws(() => assertCatalog(withArtifact(mutate)));
});

test('device-guard rejects non-macOS and non-universal artifacts with a clear reason', () => {
  for (const mutate of [(a) => { a.platform = 'linux'; a.architecture = 'x86_64'; }, (a) => { a.platform = 'windows'; a.architecture = 'arm64'; }, (a) => { a.architecture = 'arm64'; }]) {
    assert.ok(validateCatalog(withArtifact(mutate)).errors.some((e) => /Device Guard artifacts must be universal macOS/.test(e)));
  }
});

test('an unknown product is still rejected', () => {
  for (const product of ['device_guard', 'Device-Guard', 'device-guards', 'network-guard', 'device-guard ', '']) {
    const r = guard(); r.product = product;
    assert.ok(validateCatalog(catalogOf(r)).errors.some((e) => /unsupported product/.test(e)), JSON.stringify(product));
  }
});

test('desktop is still unavailable and the other products still validate unchanged', () => {
  const desktop = guard(); desktop.product = 'desktop'; assert.equal(validateCatalog(catalogOf(desktop)).valid, false);
  assertCatalog(fixtureCatalog());
  assertCatalog(catalogOf(release('network-helper', SETUP_ZIP)));
  assertCatalog(catalogOf(release('network-helper', SETUP_ZIP, { architecture: 'arm64' })));
  assertCatalog(catalogOf(release('network-helper', SETUP_ZIP, { platform: 'linux', architecture: 'arm64', filename: 'anon-network-guard-0.2.0-9-linux-arm64.tar.gz', signing: { kind: 'catalog-sha256' }, location: helperArtifactUrl({ version: VERSION, buildId: BUILD }, 'anon-network-guard-0.2.0-9-linux-arm64.tar.gz') })));
  assertCatalog(catalogOf(release('network-helper', SETUP_ZIP, { platform: 'windows', architecture: 'x86_64', signing: { kind: 'authenticode', subject: 'Test', timestamped: true } })));
  // A network-helper still cannot claim an Android platform, and Android cannot use a GitHub release.
  assert.equal(validateCatalog(catalogOf(release('network-helper', SETUP_ZIP, { platform: 'android' }))).valid, false);
  const android = fixtureCatalog(); android.releases[0].artifacts[0].location = helperArtifactUrl({ version: VERSION, buildId: BUILD }, 'a.apk');
  assert.equal(validateCatalog(android).valid, false);
});

test('artifactKey shapes for existing products are unchanged and device-guard follows the same shape', () => {
  const setup = release('network-helper', SETUP_ZIP); const app = guard();
  assert.equal(artifactKey(setup.artifacts[0], setup), `network-helper/${VERSION}/${BUILD}/${SETUP_ZIP}`);
  assert.equal(artifactKey(app.artifacts[0], app), `device-guard/${VERSION}/${BUILD}/${APP_ZIP}`);
  // R2 keys come from the signed URL for every product, as before.
  assert.equal(artifactKey({ location: `https://downloads.anon.inc/android/0.0.0-test/1/a.apk` }), 'android/0.0.0-test/1/a.apk');
  assert.equal(artifactKey({ location: `https://release.anon.inc/network-helper/0.1.1/4/setup.zip` }), 'network-helper/0.1.1/4/setup.zip');
  assert.equal(artifactKey({ location: `https://downloads.anon.inc/device-guard/${VERSION}/${BUILD}/${APP_ZIP}` }), `device-guard/${VERSION}/${BUILD}/${APP_ZIP}`);
  const fixtureAndroid = fixtureCatalog().releases[0];
  assert.equal(artifactKey(fixtureAndroid.artifacts[0], fixtureAndroid), 'android/0.0.0-test/1/anon-android-0.0.0-test-1-universal.apk');
  // Without a release, a GitHub location has no key. An Android release never gets one.
  assert.throws(() => artifactKey({ location: app.artifacts[0].location }), /Unexpected artifact location/);
  assert.throws(() => artifactKey(app.artifacts[0], { ...app, product: 'android' }), /Unexpected artifact location/);
  assert.throws(() => artifactKey({ ...app.artifacts[0], filename: '../x.zip', location: helperArtifactUrl(app, '../x.zip') }, app), /Unsafe artifact filename|Unexpected artifact location/);
});

test('one release tag carries both ZIPs, and the checksums list each under its own product', () => {
  const c = catalogOf(release('network-helper', SETUP_ZIP), guard());
  assertCatalog(c);
  assert.equal(c.releases[0].artifacts[0].location.split('/').at(-2), c.releases[1].artifacts[0].location.split('/').at(-2));
  assert.equal(helperReleasePage(c.releases[0], c.releases[0].artifacts[0]), helperReleasePage(c.releases[1], c.releases[1].artifacts[0]));
  assert.equal(checksumText(c), [`${sha256(testArtifact)}  device-guard/${VERSION}/${BUILD}/${APP_ZIP}\n`, `${sha256(testArtifact)}  network-helper/${VERSION}/${BUILD}/${SETUP_ZIP}\n`].join(''));
  // The same filename cannot be claimed by both products on one tag.
  assert.ok(validateCatalog(catalogOf(release('network-helper', APP_ZIP), guard())).errors.some((e) => /duplicate artifact location/.test(e)));
});

test('catalog history rules apply to device-guard records', () => {
  const before = catalogOf(release('network-helper', SETUP_ZIP));
  const chained = catalogOf(release('network-helper', SETUP_ZIP), guard());
  assertCatalogTransition(before, chained);
  assert.throws(() => assertCatalogTransition(chained, before), /history/);
  const changed = structuredClone(chained); changed.releases[1].artifacts[0].sha256 = 'b'.repeat(64);
  assert.throws(() => assertCatalogTransition(chained, changed), /cannot change/);
  const withdrawn = structuredClone(chained); withdrawn.releases[1].status = 'withdrawn';
  assertCatalogTransition(chained, withdrawn);
  assert.throws(() => assertCatalogTransition(withdrawn, chained), /cannot be reactivated/);
});

test('publishing treats a device-guard GitHub asset exactly as a helper asset', async () => {
  const r = guard(); const a = r.artifacts[0]; const c = catalogOf(r);
  const metadata = { tag_name: `v${VERSION}-${BUILD}`, immutable: true, draft: false, prerelease: false, assets: [{ name: APP_ZIP, size: a.bytes, digest: `sha256:${a.sha256}`, browser_download_url: a.location }] };
  const seen = [];
  const verify = createPublicArtifactVerifier(async (url) => { seen.push(url); return url.startsWith('https://api.github.com/') ? Response.json(metadata) : new Response(testArtifact); });
  await verify(a.location, a);
  assert.deepEqual(seen, [`https://api.github.com/repos/anondotinc/network-guard/releases/tags/v${VERSION}-${BUILD}`, a.location]);
  const mutable = structuredClone(metadata); mutable.immutable = false;
  await assert.rejects(createPublicArtifactVerifier(async () => Response.json(mutable))(a.location, a), /immutable/);
  const plan = publishPlan({ ...signedFixture(c), verified: [{ artifact: a, key: artifactKey(a, r) }] });
  assert.equal(plan.artifacts[0].key, `device-guard/${VERSION}/${BUILD}/${APP_ZIP}`);
  assert.match(plan.artifacts[0].operation, /no-r2-artifact-upload/);
});

// The website validates with catalog.mjs and external tools validate with the
// schema. There is no schema engine in this dependency-free repository, so this
// pins the facts the two must agree on.
test('the schema and the validator agree on the device-guard product', async () => {
  const schema = JSON.parse(await readFile(new URL('../catalog.schema.json', import.meta.url), 'utf8'));
  const releaseSchema = schema.$defs.release;
  for (const product of releaseSchema.properties.product.enum) {
    const r = guard(); r.product = product;
    assert.ok(!validateCatalog(catalogOf(r)).errors.some((e) => /unsupported product/.test(e)), `${product} is in the schema but not the validator`);
  }
  assert.deepEqual([...releaseSchema.properties.product.enum].sort(), ['android', 'desktop', 'device-guard', 'network-helper']);
  const rule = releaseSchema.allOf.find((entry) => entry.if?.properties?.product?.const === 'device-guard');
  assert.deepEqual(rule?.then, { properties: { artifacts: { items: { properties: { platform: { const: 'macos' }, architecture: { const: 'universal' } } } } } });
  assert.match(schema.description, /Device Guard/);
  // GitHub asset locations in the schema are not limited to one product's name.
  assert.match(helperArtifactUrl({ version: VERSION, buildId: BUILD }, APP_ZIP), new RegExp(schema.$defs.artifact.properties.location.pattern));
  assert.match(`https://downloads.anon.inc/device-guard/${VERSION}/${BUILD}/${APP_ZIP}`, new RegExp(schema.$defs.artifact.properties.location.pattern));
});
