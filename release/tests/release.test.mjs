import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCatalog, assertCatalog } from '../catalog.mjs';
import { importApk, inspectApkOutput } from '../android.mjs';
import { inspectAppleSignature, packageHelper, verifyUniversalAppleSignatures } from '../helper.mjs';
import { artifactKey, checksumText, jsonBytes, parseArgs, sha256, signCatalog, verifyArtifacts, verifyCatalogSignature } from '../lib.mjs';
import { assertCatalogTransition, createPublicArtifactVerifier, createR2Transport, publishPlan, publishVerified as publishWithRequiredPublicGate } from '../publish.mjs';
import { badging, fixtureCatalog, signedFixture, testArtifact, TEST_SIGNER, verification } from './fixtures.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'anon-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function staged(t) {
  const root = await temp(t);
  const signed = signedFixture();
  const artifact = signed.catalog.releases[0].artifacts[0];
  const path = join(root, artifactKey(artifact));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, testArtifact);
  const verified = await verifyArtifacts(signed.catalog, root);
  return { ...signed, root, path, verified, sums: checksumText(signed.catalog) };
}
function memoryTransport({ failAt, corruptKey } = {}) {
  const objects = new Map(); const events = []; let revision = 0;
  return {
    objects, events,
    async get(key) { events.push(`get:${key}`); return objects.get(key) ?? null; },
    async head(key) { events.push(`head:${key}`); const item = objects.get(key); return item ? { bytes: item.bytes.length, etag: item.etag } : null; },
    async put(key, data, condition) {
      events.push(`put:${key}`);
      if (failAt === key) throw new Error('Synthetic upload failure');
      const before = objects.get(key);
      if (condition.none && before || condition.etag && before?.etag !== condition.etag) throw new Error('Synthetic conditional conflict');
      const bytes = data.file ? await readFile(data.file) : data.bytes;
      objects.set(key, { bytes: key === corruptKey ? Buffer.from('corrupt') : bytes, etag: `"revision-${++revision}"` });
    },
    async verify(key, expected) {
      events.push(`verify:${key}`);
      const item = objects.get(key);
      assert.equal(item?.bytes.length, expected.bytes, 'uploaded size mismatch');
      assert.equal(sha256(item.bytes), expected.sha256, 'uploaded hash mismatch');
    },
  };
}
function fixturePublicVerifier(transport, fetchFixture) {
  return createPublicArtifactVerifier(async (location, request) => {
    transport.events.push(`public:${location}`);
    if (fetchFixture) return fetchFixture(location, request);
    const entry = transport.objects.get(artifactKey({ location }));
    return new Response(entry?.bytes ?? 'not found', { status: entry ? 200 : 404 });
  });
}
function publishVerified(input, transport, verifier = fixturePublicVerifier(transport)) {
  return publishWithRequiredPublicGate(input, transport, verifier);
}

test('empty catalog and clearly labeled test fixture validate', () => {
  assertCatalog({ schemaVersion: 1, releases: [] });
  assertCatalog(fixtureCatalog());
});
test('packaging refuses a relabeled build before copying, signing or Apple submission', async t => {
  const root = await realpath(await temp(t));
  const app = join(root, 'Fixture.app');
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await writeFile(join(app, 'Contents/Resources/payload.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.1', channel: 'production' }));
  const events = [];
  const execute = (command, args) => {
    events.push(command);
    assert.equal(command, '/usr/bin/plutil');
    return { CFBundleIdentifier: 'inc.anon.network-helper.setup', LSMinimumSystemVersion: '13.0', CFBundleShortVersionString: '0.1.1', CFBundleVersion: '4' }[args[1]];
  };
  await assert.rejects(packageHelper({ app, version: '0.1.1', buildId: '5', out: join(root, 'output') }, execute), /must match.*CFBundleVersion/);
  assert.equal(events.length, 4);
  await assert.rejects(readFile(join(root, 'output')), { code: 'ENOENT' });
});
test('current and legacy R2 origins retain exact signed URLs and the same storage key', async () => {
  const catalog = fixtureCatalog();
  const artifact = catalog.releases[0].artifacts[0];
  const key = artifactKey(artifact);
  for (const origin of ['https://release.anon.inc', 'https://downloads.anon.inc']) {
    artifact.location = `${origin}/${key}`;
    const before = JSON.stringify(catalog);
    assertCatalog(catalog);
    assert.equal(artifactKey(artifact), key);
    const requests = [];
    await createPublicArtifactVerifier(async (url) => {
      requests.push(url); return new Response(testArtifact);
    })(artifact.location, artifact);
    assert.deepEqual(requests, [`${origin}/${key}`]);
    assert.equal(JSON.stringify(catalog), before, 'validation must not rewrite signed history');
  }
  for (const location of [
    `https://downloads.anon.inc.evil.example/${key}`,
    `https://downloads.anon.inc@evil.example/${key}`,
    `https://downloads.anon.inc:443/${key}`,
    `http://downloads.anon.inc/${key}`,
    `https://downloads.anon.inc/${key}?token=unexpected`,
  ]) assert.throws(() => artifactKey({ location }), /Unexpected artifact location/);
});
for (const [label, mutate] of [
  ['unexpected root fields', (c) => { c.tracking = true; }],
  ['wrong version', (c) => { c.schemaVersion = 2; }],
  ['missing artifact', (c) => { c.releases[0].artifacts = []; }],
  ['duplicate release', (c) => { c.releases.push(structuredClone(c.releases[0])); }],
  ['invalid calendar date', (c) => { c.releases[0].releasedAt = '2026-02-31T00:00:00Z'; }],
  ['unsafe version', (c) => { c.releases[0].version = '../latest'; }],
  ['wrong origin', (c) => { c.releases[0].artifacts[0].location = 'https://evil.example/wallet.apk'; }],
  ['mutable latest URL', (c) => { c.releases[0].artifacts[0].location = 'https://downloads.anon.inc/latest.apk'; }],
  ['invented signing properties', (c) => { c.releases[0].artifacts[0].signing.uploadKey = true; }],
  ['wrong Android package', (c) => { c.releases[0].artifacts[0].signing.packageName = 'com.debug.anon'; }],
  ['invalid hash', (c) => { c.releases[0].artifacts[0].sha256 = 'A'.repeat(64); }],
  ['oversized artifact', (c) => { c.releases[0].artifacts[0].bytes = 536870913; }],
  ['premature desktop', (c) => { c.releases[0].product = 'desktop'; }],
]) test(`catalog rejects ${label}`, () => { const c = fixtureCatalog(); mutate(c); assert.equal(validateCatalog(c).valid, false); });

test('unsigned or non-notarized helper cannot enter public catalog', () => {
  const c = fixtureCatalog(); const r = c.releases[0]; const a = r.artifacts[0];
  r.product = 'network-helper'; a.platform = 'macos'; a.filename = 'setup.zip'; a.location = 'https://downloads.anon.inc/network-helper/0.0.0-test/1/setup.zip';
  a.signing = { kind: 'apple-developer-id', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test Only (TESTTEAM00)', notarized: false };
  assert.equal(validateCatalog(c).valid, false);
  a.signing.notarized = true; assertCatalog(c);
  a.signing.teamId = 'WRONGTEAM0'; assert.equal(validateCatalog(c).valid, false);
});

test('APK metadata requires expected package, signer and explicit version', () => {
  const metadata = inspectApkOutput(badging, verification, { version: '0.0.0-test', buildId: '1', signer: TEST_SIGNER });
  assert.equal(metadata.architecture, 'universal'); assert.equal(metadata.packageName, 'com.ahloop.anon');
  assert.throws(() => inspectApkOutput(badging, verification, { version: '1.0', buildId: '1', signer: TEST_SIGNER }), /version\/build/);
  assert.throws(() => inspectApkOutput(badging, verification, { version: '0.0.0-test', buildId: '2', signer: TEST_SIGNER }), /version\/build/);
  assert.throws(() => inspectApkOutput(badging, verification, { version: '0.0.0-test', buildId: '1', signer: 'b'.repeat(64) }), /signer/);
  assert.throws(() => inspectApkOutput(badging.replace('com.ahloop.anon', 'com.debug.wallet'), verification, { version: '0.0.0-test', buildId: '1', signer: TEST_SIGNER }), /package/);
  assert.throws(() => inspectApkOutput(`${badging}\napplication-debuggable\n`, verification, { version: '0.0.0-test', buildId: '1', signer: TEST_SIGNER }), /Debuggable/);
  assert.throws(() => inspectApkOutput(badging, verification.replace('Fixture Only', 'Android Debug'), { version: '0.0.0-test', buildId: '1', signer: TEST_SIGNER }), /debug/);
});
test('APK failed signatures, multiple signers and ambiguous ABI sets are rejected', () => {
  const expected = { version: '0.0.0-test', buildId: '1', signer: TEST_SIGNER };
  assert.throws(() => inspectApkOutput(badging, verification.replace('Verifies', 'DOES NOT VERIFY'), expected), /valid APK/);
  assert.throws(() => inspectApkOutput(badging, `${verification}Signer #2 certificate SHA-256 digest: ${TEST_SIGNER}\n`, expected), /signer/);
  assert.throws(() => inspectApkOutput(badging.replace(" 'x86' 'x86_64'", ''), verification, expected), /ABI set/);
  assert.throws(() => inspectApkOutput(badging.replace('x86_64', 'mips'), verification, expected), /unsupported/);
  assert.equal(inspectApkOutput(badging.replace(/native-code:.*/, "native-code: 'arm64-v8a'"), verification, expected).architecture, 'arm64');
  assert.throws(() => inspectApkOutput(badging.replace(" platformBuildVersionName=", " split='config.arm64_v8a' platformBuildVersionName="), verification, expected), /Split APKs/);
});
test('APK import does not overwrite input or duplicate immutable output', async (t) => {
  const root = await temp(t); const apk = join(root, 'explicit.apk'); await writeFile(apk, testArtifact);
  const calls = [];
  const execute = (command, args) => { calls.push([command, args]); return command === 'aapt2' ? badging : verification; };
  const options = { apk, signer: TEST_SIGNER, version: '0.0.0-test', buildId: '1', releasedAt: '2026-01-01T00:00:00Z', channel: 'test', out: join(root, 'out') };
  const imported = await importApk(options, execute);
  assert.equal(imported.status, 'unreleased');
  assert.equal(calls[1][1].includes('-Werr'), true);
  assert.equal(sha256(await readFile(apk)), sha256(testArtifact));
  await assert.rejects(importApk(options, execute), /EEXIST/);
  await assert.rejects(importApk({ ...options, apk: undefined }, execute), /explicit APK path/);
});
test('failed apksigner execution never produces an imported record', async (t) => {
  const root = await temp(t); const apk = join(root, 'explicit.apk'); await writeFile(apk, testArtifact);
  await assert.rejects(importApk({ apk, out: root, signer: TEST_SIGNER, version: '0.0.0-test', buildId: '1', releasedAt: '2026-01-01T00:00:00Z' }, () => { throw new Error('signature tool rejected artifact'); }), /rejected artifact/);
});
test('Developer ID inspection rejects ad-hoc, wrong team and missing runtime/timestamp', () => {
  const team = 'TESTTEAM00'; const identity = 'Developer ID Application: Test Only (TESTTEAM00)';
  const valid = `Authority=${identity}\nTeamIdentifier=${team}\nTimestamp=Jan 1, 2026\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1\n`;
  assert.equal(inspectAppleSignature(valid, team, identity).identity, identity);
  assert.equal(Object.hasOwn(inspectAppleSignature(valid, team, identity), 'notarized'), false);
  assert.throws(() => inspectAppleSignature('Signature=adhoc\nTeamIdentifier=not set', team, identity), /identity/);
  assert.throws(() => inspectAppleSignature(valid.replace('Timestamp=', 'Unsigned='), team, identity), /Timestamped/);
  assert.throws(() => inspectAppleSignature(valid.replace('runtime', 'none'), team, identity), /runtime/);
});
test('universal signing verification explicitly checks both binaries and both slice identities', () => {
  const options = { app: '/fixture/Setup.app', helper: '/fixture/Setup.app/Contents/Resources/anon-network-helper', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test Only (TESTTEAM00)' };
  const output = `Authority=${options.identity}\nTeamIdentifier=${options.teamId}\nTimestamp=Jan 1, 2026\nCodeDirectory flags=0x10000(runtime)\n`;
  const calls = [];
  assert.equal(verifyUniversalAppleSignatures(options, (command, args) => { calls.push({ command, args }); return output; }).identity, options.identity);
  const verification = calls.filter(({ args }) => args.includes('--verify'));
  assert.equal(verification.length, 2);
  assert.ok(verification.every(({ command, args }) => command === '/usr/bin/codesign' && args.includes('--all-architectures') && args.includes('--strict')));
  assert.equal(verification[0].args.at(-1), options.app);
  assert.equal(verification[1].args.at(-1), options.helper);
  assert.ok(verification[0].args.includes('--deep'));
  const displays = calls.filter(({ args }) => args.includes('--display'));
  assert.deepEqual(displays.map(({ args }) => [args.at(-1), args[args.indexOf('--architecture') + 1]]), [[options.app, 'arm64'], [options.app, 'x86_64'], [options.helper, 'arm64'], [options.helper, 'x86_64']]);
});
test('an Intel-only helper signing identity mismatch fails universal release verification', () => {
  const options = { app: '/fixture/Setup.app', helper: '/fixture/Setup.app/Contents/Resources/anon-network-helper', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test Only (TESTTEAM00)' };
  const output = `Authority=${options.identity}\nTeamIdentifier=${options.teamId}\nTimestamp=Jan 1, 2026\nCodeDirectory flags=0x10000(runtime)\n`;
  assert.throws(() => verifyUniversalAppleSignatures(options, (_command, args) => args.includes('--display') && args.includes('x86_64') && args.at(-1) === options.helper ? output.replaceAll('TESTTEAM00', 'WRONGTEAM0') : output), /identity does not match/);
});
test('an invalid non-native signature fails before any helper identity display', () => {
  const options = { app: '/fixture/Setup.app', helper: '/fixture/Setup.app/Contents/Resources/anon-network-helper', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test Only (TESTTEAM00)' };
  const output = `Authority=${options.identity}\nTeamIdentifier=${options.teamId}\nTimestamp=Jan 1, 2026\nCodeDirectory flags=0x10000(runtime)\n`;
  const calls = [];
  assert.throws(() => verifyUniversalAppleSignatures(options, (_command, args) => {
    calls.push(args);
    if (args.includes('--verify') && args.at(-1) === options.helper) { assert.ok(args.includes('--all-architectures')); throw new Error('Synthetic x86_64 signature failure'); }
    return output;
  }), /x86_64 signature failure/);
  assert.equal(calls.some((args) => args.includes('--display') && args.at(-1) === options.helper), false);
});

test('Ed25519 verifies exact metadata bytes before parsing', () => {
  const s = signedFixture();
  assert.deepEqual(verifyCatalogSignature(s.bytes, s.signatureBytes, s.publicKey), s.catalog);
  assert.throws(() => verifyCatalogSignature(Buffer.concat([s.bytes, Buffer.from(' ')]), s.signatureBytes, s.publicKey), /signature verification/);
  assert.throws(() => verifyCatalogSignature(Buffer.from('malformed JSON'), s.signatureBytes, s.publicKey), /signature verification/);
  assert.throws(() => verifyCatalogSignature(s.bytes, s.signatureBytes.subarray(1), s.publicKey), /64 raw bytes/);
  assert.throws(() => verifyCatalogSignature(s.bytes, s.signatureBytes, signedFixture().publicKey), /signature verification/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signCatalog(s.bytes, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' })), /Ed25519/);
});
test('corrupted local artifacts and path symlinks cannot pass verification', async (t) => {
  const s = await staged(t);
  await writeFile(s.path, Buffer.from('broken'));
  await assert.rejects(verifyArtifacts(s.catalog, s.root), /integrity/);
  await rm(s.path); const another = join(s.root, 'elsewhere.apk'); await writeFile(another, testArtifact); await symlink(another, s.path);
  await assert.rejects(verifyArtifacts(s.catalog, s.root), /symbolic links/);
});
test('argument parser refuses guessed paths, unknown flags, duplicates', () => {
  assert.throws(() => parseArgs(['--latest'], { values: ['apk'] }), /Unknown/);
  assert.throws(() => parseArgs(['--apk'], { values: ['apk'] }), /Missing/);
  assert.throws(() => parseArgs(['--apk', 'one', '--apk', 'two'], { values: ['apk'] }), /Duplicate/);
});

test('dry-run plan has no network or credential operations', async (t) => {
  const s = await staged(t); const plan = publishPlan(s);
  assert.equal(plan.mode, 'dry-run'); assert.equal(plan.networkRequests, 0); assert.equal(plan.credentialAccess, false);
  assert.equal(plan.artifacts[0].key, artifactKey(s.catalog.releases[0].artifacts[0]));
  assert.equal(plan.artifacts[0].publicVerification.location, s.catalog.releases[0].artifacts[0].location);
  assert.equal(plan.artifacts[0].publicVerification.redirects, 'rejected');
  assert.equal(plan.artifacts[0].publicVerification.timeoutMs, 60_000);
});
test('publish requires a public verifier before any storage request', async (t) => {
  const s = await staged(t); const transport = memoryTransport();
  await assert.rejects(publishWithRequiredPublicGate(s, transport), /explicit public download verifier/);
  assert.deepEqual(transport.events, []);
});
test('public verifier hashes exact unauthenticated immutable URL with bounded no-redirect policy', async () => {
  const artifact = fixtureCatalog().releases[0].artifacts[0]; const calls = [];
  await createPublicArtifactVerifier(async (location, request) => {
    calls.push({ location, request }); return new Response(testArtifact, { headers: { 'content-length': String(testArtifact.length) } });
  })(artifact.location, artifact);
  assert.equal(calls.length, 1); assert.equal(calls[0].location, artifact.location);
  const request = calls[0].request;
  assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'manual'); assert.equal(request.credentials, 'omit');
  assert.equal(request.referrerPolicy, 'no-referrer'); assert.equal(request.cache, 'no-store');
  assert.deepEqual(Object.keys(request.headers).sort(), ['accept', 'accept-encoding']);
  assert.equal(request.headers['accept-encoding'], 'identity');
  assert.ok(request.signal instanceof AbortSignal); assert.equal(request.signal.aborted, false);
});
test('public verifier refuses alternate host, query, traversal and invalid expected size before fetch', async () => {
  const artifact = fixtureCatalog().releases[0].artifacts[0]; let calls = 0;
  const verify = createPublicArtifactVerifier(async () => { calls++; return new Response(testArtifact); });
  for (const location of [artifact.location.replace('downloads.anon.inc', 'attacker.example'), `${artifact.location}?cache=1`, 'https://downloads.anon.inc/android/../1/test.apk']) {
    await assert.rejects(verify(location, artifact));
  }
  await assert.rejects(verify(artifact.location, { ...artifact, bytes: 536870913 }), /expected public artifact/);
  assert.equal(calls, 0);
});
for (const [label, fetchFixture] of [
  ['wrong public bytes', async () => new Response(Buffer.alloc(testArtifact.length, 1))],
  ['missing public artifact', async () => new Response('not found', { status: 404 })],
  ['missing hostname or timeout', async () => { throw new Error('Synthetic ENOTFOUND or abort'); }],
  ['redirect', async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/file.apk' } })],
  ['partial response', async () => new Response(testArtifact, { status: 206 })],
  ['oversized body', async () => new Response(Buffer.concat([testArtifact, Buffer.from('extra')]))],
  ['truncated body', async () => new Response(testArtifact.subarray(1))],
  ['encoded body', async () => new Response(testArtifact, { headers: { 'content-encoding': 'gzip' } })],
]) test(`${label} prevents catalog metadata upload and activation`, async (t) => {
  const s = await staged(t); const transport = memoryTransport();
  await assert.rejects(publishVerified(s, transport, fixturePublicVerifier(transport, fetchFixture)), /catalog not activated/);
  assert.ok(transport.events.includes(`verify:${s.verified[0].key}`), 'R2 artifact readback was already successful');
  assert.equal(transport.events.some((event) => event.startsWith('put:catalogs/') || event === 'put:catalog/v1.json'), false);
});
test('public body stream failure is sanitized and cannot activate catalog', async (t) => {
  const s = await staged(t); const transport = memoryTransport();
  const verifier = fixturePublicVerifier(transport, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Sensitive transport detail must not escape')); } })));
  await assert.rejects(publishVerified(s, transport, verifier), /Public download failed or timed out while reading bytes; catalog not activated/);
  assert.equal(transport.events.includes('put:catalog/v1.json'), false);
});
test('public delivery failure preserves an already active catalog unchanged', async (t) => {
  const s = await staged(t); const transport = memoryTransport(); await publishVerified(s, transport);
  const previous = transport.objects.get('catalog/v1.json'); const count = transport.events.length;
  await assert.rejects(publishVerified(s, transport, fixturePublicVerifier(transport, async () => new Response(null, { status: 404 }))), /catalog not activated/);
  assert.deepEqual(transport.objects.get('catalog/v1.json'), previous);
  assert.equal(transport.events.slice(count).includes('put:catalog/v1.json'), false);
});
test('publish activates only after every artifact and metadata object is downloaded and hashed', async (t) => {
  const s = await staged(t); const transport = memoryTransport();
  const result = await publishVerified(s, transport);
  assert.equal(result.activated, true);
  const activation = transport.events.indexOf('put:catalog/v1.json');
  const verifies = transport.events.filter((e) => e.startsWith('verify:') && e !== 'verify:catalog/v1.json');
  assert.equal(verifies.length, 4);
  assert.ok(verifies.every((e) => transport.events.indexOf(e) < activation));
  const publicCheck = transport.events.indexOf(`public:${s.catalog.releases[0].artifacts[0].location}`);
  assert.ok(publicCheck > transport.events.indexOf(`verify:${s.verified[0].key}`));
  assert.ok(publicCheck < activation);
  assert.ok(publicCheck < transport.events.findIndex((event) => event.startsWith('put:catalogs/')));
  const envelope = JSON.parse(transport.objects.get('catalog/v1.json').bytes);
  verifyCatalogSignature(Buffer.from(envelope.catalogBase64, 'base64'), Buffer.from(envelope.signatureBase64, 'base64'), s.publicKey);
});
test('failed artifact upload and corrupt remote bytes prevent catalog activation', async (t) => {
  const s = await staged(t); const key = s.verified[0].key;
  for (const transport of [memoryTransport({ failAt: key }), memoryTransport({ corruptKey: key })]) {
    await assert.rejects(publishVerified(s, transport));
    assert.equal(transport.events.includes('put:catalog/v1.json'), false);
  }
});
test('matching immutable artifact can resume; conflicting bytes cannot overwrite', async (t) => {
  const s = await staged(t); const transport = memoryTransport(); const key = s.verified[0].key;
  transport.objects.set(key, { bytes: testArtifact, etag: '"existing"' });
  await publishVerified(s, transport); assert.equal(transport.events.includes(`put:${key}`), false);
  const conflict = memoryTransport(); conflict.objects.set(key, { bytes: Buffer.from('different'), etag: '"existing"' });
  await assert.rejects(publishVerified(s, conflict), /Immutable version/);
  assert.equal(conflict.events.includes(`put:${key}`), false);
  assert.equal(conflict.events.includes('put:catalog/v1.json'), false);
});
test('metadata upload failure prevents activation and source artifact changes are detected', async (t) => {
  const s = await staged(t);
  const transport = memoryTransport({ failAt: `catalogs/${sha256(s.bytes)}/catalog.json.sig` });
  await assert.rejects(publishVerified(s, transport), /upload failure/);
  assert.equal(transport.events.includes('put:catalog/v1.json'), false);
  await writeFile(s.path, Buffer.from('changed after validation'));
  await assert.rejects(publishVerified(s, memoryTransport()), /changed after validation/);
});
test('catalog transition preserves history, immutable bytes and withdrawals', () => {
  const before = fixtureCatalog();
  assert.throws(() => assertCatalogTransition(before, { schemaVersion: 1, releases: [] }), /history/);
  const change = structuredClone(before); change.releases[0].artifacts[0].sha256 = 'b'.repeat(64);
  assert.throws(() => assertCatalogTransition(before, change), /cannot change/);
  const withdrawn = structuredClone(before); withdrawn.releases[0].status = 'withdrawn'; assertCatalogTransition(before, withdrawn);
  assert.throws(() => assertCatalogTransition(withdrawn, before), /cannot be reactivated/);
});
test('active catalog must authenticate and match expected revision before replacement', async (t) => {
  const s = await staged(t); const transport = memoryTransport(); await publishVerified(s, transport);
  transport.objects.get('catalog/v1.json').bytes = jsonBytes({ schemaVersion: 1, catalogBase64: s.bytes.toString('base64'), signatureBase64: Buffer.alloc(64).toString('base64') });
  const count = transport.events.length;
  await assert.rejects(publishVerified(s, transport), /signature verification/);
  assert.equal(transport.events.slice(count).some((e) => e.startsWith('put:')), false);
});
test('concurrent activation change fails compare-and-swap without overwriting it', async (t) => {
  const s = await staged(t); const transport = memoryTransport(); await publishVerified(s, transport);
  const originalPut = transport.put;
  transport.put = async (key, data, condition) => {
    if (key === 'catalog/v1.json') transport.objects.get(key).etag = '"concurrent-operator"';
    return originalPut(key, data, condition);
  };
  await assert.rejects(publishVerified(s, transport), /conditional conflict/);
  assert.equal(transport.objects.get('catalog/v1.json').etag, '"concurrent-operator"');
});
test('withdrawal needs no removed artifact and retains immutable release history', async (t) => {
  const s = await staged(t); const transport = memoryTransport(); await publishVerified(s, transport);
  const withdrawn = structuredClone(s.catalog); withdrawn.releases[0].status = 'withdrawn'; withdrawn.releases[0].notes.push('Withdrawn: test failure');
  const bytes = jsonBytes(withdrawn);
  await rm(s.path);
  const verified = await verifyArtifacts(withdrawn, s.root); assert.equal(verified.length, 0);
  await publishVerified({ ...s, bytes, catalog: withdrawn, signatureBytes: signCatalog(bytes, s.privateKey), verified, sums: checksumText(withdrawn) }, transport);
  const active = JSON.parse(transport.objects.get('catalog/v1.json').bytes);
  assert.equal(verifyCatalogSignature(Buffer.from(active.catalogBase64, 'base64'), Buffer.from(active.signatureBase64, 'base64'), s.publicKey).releases[0].status, 'withdrawn');
});
test('R2 transport is fixed-host, scoped and conditional with no broad operations', async () => {
  const calls = [];
  const transport = createR2Transport({ accountId: 'a'.repeat(32), bucket: 'anon-test-releases', accessKeyId: 'TEST_ONLY', secretAccessKey: 'TEST_ONLY' }, async (url, request) => { calls.push([url, request]); return new Response('', { status: 200, headers: { etag: '"fixture"' } }); });
  await transport.put('android/0.0.0-test/1/test.apk', { bytes: Buffer.from('a'), payloadHash: sha256('a') });
  assert.match(calls[0][0], /^https:\/\/a{32}\.r2\.cloudflarestorage\.com\/anon-test-releases\//);
  assert.equal(calls[0][1].headers['if-none-match'], '*');
  assert.match(calls[0][1].headers.authorization, /SignedHeaders=.*if-none-match/);
  assert.equal(calls[0][1].redirect, 'manual');
  await assert.rejects(transport.put('../unsafe', { bytes: Buffer.from('a') }), /Unsafe/);
  await assert.rejects(transport.put('catalog/v1.json', { bytes: Buffer.from('a') }, {}), /Every PUT/);
  assert.deepEqual(Object.keys(transport).sort(), ['get', 'head', 'put', 'verify']);
});
test('CLI offline verification and default publish dry run run with no credentials', async (t) => {
  const s = await staged(t);
  await writeFile(join(s.root, 'catalog.json'), s.bytes); await writeFile(join(s.root, 'catalog.json.sig'), s.signatureBytes); await writeFile(join(s.root, 'public.pem'), s.publicKey); await writeFile(join(s.root, 'SHA256SUMS'), s.sums);
  const cli = new URL('../cli.mjs', import.meta.url).pathname;
  const args = ['--catalog', join(s.root, 'catalog.json'), '--signature', join(s.root, 'catalog.json.sig'), '--public-key', join(s.root, 'public.pem'), '--artifacts', s.root];
  const verify = spawnSync(process.execPath, [cli, 'verify', ...args, '--sums', join(s.root, 'SHA256SUMS')], { encoding: 'utf8', env: {} });
  assert.equal(verify.status, 0, verify.stderr); assert.equal(JSON.parse(verify.stdout).offline, true);
  const publish = spawnSync(process.execPath, [cli, 'publish', ...args], { encoding: 'utf8', env: {} });
  assert.equal(publish.status, 0, publish.stderr); assert.equal(JSON.parse(publish.stdout).networkRequests, 0);
  const execute = spawnSync(process.execPath, [cli, 'publish', ...args, '--execute'], { encoding: 'utf8', env: {} });
  assert.equal(execute.status, 1); assert.match(execute.stderr, /refuses test catalogs/);
});
