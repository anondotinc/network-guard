import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { helperArtifactUrl } from '../catalog.mjs';
import { artifactKey, checksumText, jsonBytes, sha256, signCatalog, unchangedHistory, verifyArtifacts, verifyCatalogSignature } from '../lib.mjs';
import { prepareMetadataSigner, signMetadataBundle } from '../metadata.mjs';
import { publishPlan, publishVerified as publishWithRequiredPublicGate } from '../publish.mjs';
import { fixtureCatalog, testArtifact } from './fixtures.mjs';
import { fixturePublicVerifier, memoryTransport } from './memory-transport.mjs';

const cli = new URL('../cli.mjs', import.meta.url).pathname;
const freshArtifact = Buffer.from('NOT AN APK: second synthetic release integrity fixture\n');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: {} });

// One historical release (in the authenticated previous catalog) and one new release.
function releases(channel = 'test') {
  const historical = fixtureCatalog().releases[0];
  historical.channel = channel;
  const fresh = structuredClone(historical);
  Object.assign(fresh, { version: '0.0.1-test', buildId: '2' });
  Object.assign(fresh.artifacts[0], { filename: 'anon-android-0.0.1-test-2-universal.apk', bytes: freshArtifact.length, sha256: sha256(freshArtifact), location: 'https://downloads.anon.inc/android/0.0.1-test/2/anon-android-0.0.1-test-2-universal.apk' });
  return { historical, fresh };
}
async function stage(root, key, bytes) {
  const path = join(root, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}
async function scenario(t, { copies = ['fresh'], channel } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'anon-historical-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { historical, fresh } = releases(channel);
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const previousCatalog = { schemaVersion: 1, releases: [historical] };
  const nextCatalog = { schemaVersion: 1, releases: [historical, fresh] };
  const previousBytes = jsonBytes(previousCatalog); const previousSignature = signCatalog(previousBytes, privateKey);
  const bytes = jsonBytes(nextCatalog); const signatureBytes = signCatalog(bytes, privateKey);
  const keys = { historical: artifactKey(historical.artifacts[0], historical), fresh: artifactKey(fresh.artifacts[0], fresh) };
  const files = Object.fromEntries(['previous.json', 'previous.json.sig', 'catalog.json', 'catalog.json.sig', 'public.pem', 'private.pem', 'fresh.release.json'].map((name) => [name, join(dir, name)]));
  await writeFile(files['previous.json'], previousBytes); await writeFile(files['previous.json.sig'], previousSignature);
  await writeFile(files['catalog.json'], bytes); await writeFile(files['catalog.json.sig'], signatureBytes);
  await writeFile(files['public.pem'], publicKey); await writeFile(files['private.pem'], privateKey, { mode: 0o600 });
  await writeFile(files['fresh.release.json'], JSON.stringify({ ...fresh, status: 'unreleased' }));
  const artifacts = join(dir, 'artifacts'); const everything = join(dir, 'all-artifacts');
  await mkdir(artifacts);
  for (const [name, content] of [['historical', testArtifact], ['fresh', freshArtifact]]) {
    if (copies.includes(name)) await stage(artifacts, keys[name], content);
    await stage(everything, keys[name], content);
  }
  return { dir, artifacts, everything, files, keys, historical, fresh, publicKey, privateKey, previousCatalog, nextCatalog, previousBytes, previousSignature, bytes, signatureBytes };
}
const previousArgs = (s) => ['--previous', s.files['previous.json'], '--previous-signature', s.files['previous.json.sig']];

test('a previous catalog excuses only a missing copy of an unchanged release', async (t) => {
  const s = await scenario(t);
  const verified = await verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog });
  assert.deepEqual(verified.map(({ key, path }) => [key, path === null]), [[s.keys.historical, true], [s.keys.fresh, false]]);
  assert.equal(verified[1].path, join(s.artifacts, s.keys.fresh));
  assert.deepEqual([...unchangedHistory(s.previousCatalog, s.nextCatalog)], [`${s.historical.product}/${s.historical.version}/${s.historical.buildId}`]);
});
test('with every local copy present a previous catalog changes nothing', async (t) => {
  const s = await scenario(t, { copies: ['historical', 'fresh'] });
  assert.deepEqual(await verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog }), await verifyArtifacts(s.nextCatalog, s.artifacts));
});
test('without a previous catalog a missing copy fails as before', async (t) => {
  const s = await scenario(t);
  await assert.rejects(verifyArtifacts(s.nextCatalog, s.artifacts), /ENOENT/);
  await assert.rejects(verifyArtifacts(s.nextCatalog, join(s.dir, 'no-such-directory'), { previous: s.previousCatalog }), /ENOENT/);
});
test('a new artifact still needs a verified local copy', async (t) => {
  const s = await scenario(t, { copies: ['historical'] });
  await assert.rejects(verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog }), new RegExp(`Artifact ${s.keys.fresh.replaceAll('.', '\\.')} has no local copy and is not an unchanged release in the authenticated previous catalog`));
  await writeFile(join(s.artifacts, s.keys.historical), 'unrelated bytes');
  await stage(s.artifacts, s.keys.fresh, Buffer.from('changed bytes'));
  await assert.rejects(verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog }), /integrity mismatch/);
});
for (const [label, mutate] of [
  ['artifact digest', (c) => { c.releases[0].artifacts[0].sha256 = 'b'.repeat(64); }],
  ['artifact size', (c) => { c.releases[0].artifacts[0].bytes += 1; }],
  ['artifact location', (c) => { c.releases[0].artifacts[0].location = c.releases[0].artifacts[0].location.replace('downloads.anon.inc', 'release.anon.inc'); }],
  ['release date', (c) => { c.releases[0].releasedAt = '2026-01-02T00:00:00Z'; }],
  ['channel', (c) => { c.releases[0].channel = 'stable'; }],
  ['withdrawn there, live here', (c) => { c.releases[0].status = 'withdrawn'; }],
  ['other release identity', (c) => { c.releases[0].buildId = '9'; c.releases[0].artifacts[0].location = c.releases[0].artifacts[0].location.replace('/1/', '/9/'); }],
  ['no releases', (c) => { c.releases = []; }],
]) test(`a previous catalog whose release differs (${label}) does not excuse a missing copy`, async (t) => {
  const s = await scenario(t);
  const previous = structuredClone(s.previousCatalog); mutate(previous);
  await assert.rejects(verifyArtifacts(s.nextCatalog, s.artifacts, { previous }), /has no local copy and is not an unchanged release in the authenticated previous catalog/);
});
test('a present historical copy is still verified and a symbolic link is not a missing copy', async (t) => {
  const s = await scenario(t, { copies: ['historical', 'fresh'] });
  const path = join(s.artifacts, s.keys.historical);
  await verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog });
  await writeFile(path, 'corrupted');
  await assert.rejects(verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog }), /integrity mismatch/);
  await rm(path); const elsewhere = join(s.artifacts, 'elsewhere.apk'); await writeFile(elsewhere, testArtifact); await symlink(elsewhere, path);
  await assert.rejects(verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog }), /symbolic links/);
});

test('a release withdrawn in the new catalog is never reported as history', async (t) => {
  const s = await scenario(t);
  const next = structuredClone(s.nextCatalog); next.releases[0].status = 'withdrawn';
  assert.equal(unchangedHistory(s.previousCatalog, next).size, 0);
  assert.deepEqual((await verifyArtifacts(next, s.artifacts)).map(({ key }) => key), [s.keys.fresh]);
});
test('signing authenticates the previous catalog with the signer key before reading artifacts or writing output', async (t) => {
  const s = await scenario(t);
  const signer = await prepareMetadataSigner({ privateKey: s.files['private.pem'], publicKey: s.files['public.pem'] });
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const out = join(s.dir, 'direct');
  await assert.rejects(signMetadataBundle({ bytes: s.bytes, artifacts: s.artifacts, out, signer, previous: { bytes: s.previousBytes, signatureBytes: signCatalog(s.previousBytes, other) } }), /Catalog signature verification failed/);
  await assert.rejects(readFile(join(out, 'catalog.json')), { code: 'ENOENT' });
  const result = await signMetadataBundle({ bytes: s.bytes, artifacts: s.artifacts, out, signer, previous: { bytes: s.previousBytes, signatureBytes: s.previousSignature } });
  assert.deepEqual([result.signed, result.activated, result.artifactsWithoutLocalCopy], [true, false, 1]);
});

test('catalog, sign, verify and the publish dry run need only the new artifact with an authenticated previous catalog', async (t) => {
  // Same keys and catalogs; only the artifact directory differs: the new artifact alone, or every copy.
  const partial = await scenario(t); const full = { ...partial, artifacts: partial.everything };
  // catalog: byte-identical candidate, and identical output apart from the count of excused artifacts.
  const catalogArgs = (s, out, ...more) => ['catalog', '--release', s.files['fresh.release.json'], '--artifacts', s.artifacts, '--publish', '--out', join(s.dir, out), ...more];
  const withPrevious = [...previousArgs(partial), '--public-key', partial.files['public.pem']];
  const fullCatalog = run(...catalogArgs(full, 'candidate-full.json', ...previousArgs(full), '--public-key', full.files['public.pem']));
  const partialCatalog = run(...catalogArgs(partial, 'candidate.json', ...withPrevious));
  assert.equal(fullCatalog.status, 0, fullCatalog.stderr); assert.equal(partialCatalog.status, 0, partialCatalog.stderr);
  assert.deepEqual(JSON.parse(fullCatalog.stdout), { candidateCreated: true, activated: false, releases: 2 });
  assert.deepEqual(JSON.parse(partialCatalog.stdout), { candidateCreated: true, activated: false, releases: 2, artifactsWithoutLocalCopy: 1 });
  assert.deepEqual(await readFile(join(partial.dir, 'candidate.json')), partial.bytes);
  assert.deepEqual(await readFile(join(partial.dir, 'candidate-full.json')), partial.bytes);
  // sign: the same catalog, signature and checksums as with every copy present.
  const signArgs = (s, out, ...more) => ['sign', '--catalog', s.files['catalog.json'], '--artifacts', s.artifacts, '--private-key', s.files['private.pem'], '--public-key', s.files['public.pem'], '--out', join(s.dir, out), ...more];
  const fullSign = run(...signArgs(full, 'signed-full'));
  const partialSign = run(...signArgs(partial, 'signed', ...previousArgs(partial)));
  assert.equal(fullSign.status, 0, fullSign.stderr); assert.equal(partialSign.status, 0, partialSign.stderr);
  assert.equal(JSON.parse(fullSign.stdout).artifactsWithoutLocalCopy, undefined);
  assert.equal(JSON.parse(partialSign.stdout).artifactsWithoutLocalCopy, 1);
  for (const name of ['catalog.json', 'catalog.json.sig', 'SHA256SUMS', 'metadata-public-key.pem']) assert.deepEqual(await readFile(join(partial.dir, 'signed', name)), await readFile(join(partial.dir, 'signed-full', name)), name);
  assert.equal(await readFile(join(partial.dir, 'signed', 'SHA256SUMS'), 'utf8'), checksumText(partial.nextCatalog));
  // verify: the signature and checksums are checked; only the present artifact is hashed.
  const verifyArgs = (s, ...more) => ['verify', '--catalog', s.files['catalog.json'], '--signature', s.files['catalog.json.sig'], '--public-key', s.files['public.pem'], '--artifacts', s.artifacts, '--sums', join(s.dir, 'signed', 'SHA256SUMS'), ...more];
  const fullVerify = run(...verifyArgs(full)); const partialVerify = run(...verifyArgs(partial, ...previousArgs(partial)));
  assert.equal(fullVerify.status, 0, fullVerify.stderr); assert.equal(partialVerify.status, 0, partialVerify.stderr);
  assert.equal(JSON.parse(fullVerify.stdout).artifactHashesVerified, 2); assert.equal(JSON.parse(fullVerify.stdout).artifactsWithoutLocalCopy, undefined);
  assert.equal(JSON.parse(partialVerify.stdout).artifactHashesVerified, 1); assert.equal(JSON.parse(partialVerify.stdout).artifactsWithoutLocalCopy, 1);
  assert.equal(run(...verifyArgs(full, ...previousArgs(full))).stdout, fullVerify.stdout, 'a previous catalog leaves full-copy verify output byte-identical');
  // publish dry run: offline, with remote verification planned for the historical artifact only.
  const publishArgs = (s, ...more) => ['publish', '--catalog', s.files['catalog.json'], '--signature', s.files['catalog.json.sig'], '--public-key', s.files['public.pem'], '--artifacts', s.artifacts, ...more];
  const fullPlan = run(...publishArgs(full)); const partialPlan = run(...publishArgs(partial, ...previousArgs(partial)));
  assert.equal(fullPlan.status, 0, fullPlan.stderr); assert.equal(partialPlan.status, 0, partialPlan.stderr);
  assert.equal(run(...publishArgs(full, ...previousArgs(full))).stdout, fullPlan.stdout, 'a previous catalog leaves a full-copy plan byte-identical');
  const plan = JSON.parse(partialPlan.stdout);
  assert.equal(plan.networkRequests, 0); assert.equal(plan.credentialAccess, false); assert.equal(plan.artifactsWithoutLocalCopy, 1);
  assert.match(plan.artifacts[0].operation, /^remote-verification-at-execute-no-local-copy-download-and-hash-existing-r2-object-never-uploaded$/);
  assert.equal(plan.artifacts[1].operation, 'conditional-create-then-download-and-hash');
  assert.deepEqual(plan.artifacts[0].publicVerification, JSON.parse(fullPlan.stdout).artifacts[0].publicVerification);
});

const commands = {
  catalog: (s, out, ...more) => ['catalog', '--release', s.files['fresh.release.json'], '--artifacts', s.artifacts, '--publish', '--out', join(s.dir, out), '--public-key', s.files['public.pem'], ...more],
  sign: (s, out, ...more) => ['sign', '--catalog', s.files['catalog.json'], '--artifacts', s.artifacts, '--private-key', s.files['private.pem'], '--public-key', s.files['public.pem'], '--out', join(s.dir, out), ...more],
  verify: (s, _out, ...more) => ['verify', '--catalog', s.files['catalog.json'], '--signature', s.files['catalog.json.sig'], '--public-key', s.files['public.pem'], '--artifacts', s.artifacts, ...more],
  publish: (s, _out, ...more) => ['publish', '--catalog', s.files['catalog.json'], '--signature', s.files['catalog.json.sig'], '--public-key', s.files['public.pem'], '--artifacts', s.artifacts, ...more],
};
for (const command of Object.keys(commands)) {
  test(`${command} refuses a previous catalog that does not authenticate or does not prove the history`, async (t) => {
    const s = await scenario(t);
    const refused = async (label, build, pattern, { writes = command === 'catalog' || command === 'sign' } = {}) => {
      const result = run(...commands[command](s, `refused-${label}`, ...build));
      assert.equal(result.status, 1, `${label}: ${result.stdout}`); assert.match(result.stderr, pattern, label); assert.equal(result.stdout, '', label);
      if (writes) await assert.rejects(readFile(join(s.dir, `refused-${label}`)), { code: 'ENOENT' }, `${label} wrote output`);
    };
    // The previous signature is invalid, or made by another key.
    const tampered = Buffer.from(s.previousSignature); tampered[0] ^= 1; await writeFile(join(s.dir, 'tampered.sig'), tampered);
    await refused('bad-signature', ['--previous', s.files['previous.json'], '--previous-signature', join(s.dir, 'tampered.sig')], /Catalog signature verification failed/);
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(join(s.dir, 'other.sig'), signCatalog(s.previousBytes, other));
    await refused('other-key', ['--previous', s.files['previous.json'], '--previous-signature', join(s.dir, 'other.sig')], /Catalog signature verification failed/);
    await refused('short-signature', ['--previous', s.files['previous.json'], '--previous-signature', s.files['public.pem']], /64 raw bytes/);
    // A signature or catalog supplied without its partner is a mistake, never silently ignored.
    await refused('orphan-signature', ['--previous-signature', s.files['previous.json.sig']], /--previous-signature requires --previous/);
    await refused('missing-signature', ['--previous', s.files['previous.json']], /Required: --previous-signature/);
    // Neither a missing new artifact nor a missing artifact without a previous catalog is excused.
    await rm(join(s.artifacts, s.keys.fresh));
    await refused('missing-new', previousArgs(s), /has no local copy and is not an unchanged release in the authenticated previous catalog/);
    await refused('no-previous', [], /ENOENT/);
    await stage(s.artifacts, s.keys.fresh, freshArtifact);
    if (command === 'catalog') return;
    // The previous catalog is genuine but describes a different release: the historical copy cannot be skipped.
    const changed = structuredClone(s.previousCatalog); changed.releases[0].artifacts[0].sha256 = 'b'.repeat(64);
    const changedBytes = jsonBytes(changed);
    await writeFile(join(s.dir, 'changed.json'), changedBytes); await writeFile(join(s.dir, 'changed.json.sig'), signCatalog(changedBytes, s.privateKey));
    await refused('differs', ['--previous', join(s.dir, 'changed.json'), '--previous-signature', join(s.dir, 'changed.json.sig')], /has no local copy and is not an unchanged release in the authenticated previous catalog/);
    const result = run(...commands[command](s, 'accepted', ...previousArgs(s)));
    assert.equal(result.status, 0, result.stderr);
  });
}
test('verify refuses a previous catalog without artifacts to check', async (t) => {
  const s = await scenario(t);
  const result = run('verify', '--catalog', s.files['catalog.json'], '--signature', s.files['catalog.json.sig'], '--public-key', s.files['public.pem'], ...previousArgs(s));
  assert.equal(result.status, 1); assert.match(result.stderr, /--previous only applies together with --artifacts/);
});
test('sign without --public-key uses the pinned release key and refuses a fixture key before any output', async (t) => {
  const s = await scenario(t);
  // The pinned production public key is not the fixture key, so no previous catalog is read or output written.
  const result = run('sign', '--catalog', s.files['catalog.json'], '--artifacts', s.artifacts, '--private-key', s.files['private.pem'], '--out', join(s.dir, 'pinned'), ...previousArgs(s));
  assert.equal(result.status, 1); assert.match(result.stderr, /does not match the trusted release public key/);
  await assert.rejects(readFile(join(s.dir, 'pinned')), { code: 'ENOENT' });
});

// publish --execute with a mocked transport: the active remote catalog is the only history.
async function execution(t, { activeCatalog = true, historicalObject = testArtifact, copies = ['fresh'], withPrevious = false } = {}) {
  const s = await scenario(t, { copies });
  const transport = memoryTransport();
  if (activeCatalog) transport.objects.set('catalog/v1.json', { bytes: jsonBytes({ schemaVersion: 1, catalogBase64: s.previousBytes.toString('base64'), signatureBase64: s.previousSignature.toString('base64') }), etag: '"active-1"' });
  if (historicalObject) transport.objects.set(s.keys.historical, { bytes: historicalObject, etag: '"stored"' });
  // As the CLI loads them: with --previous the history is classified offline, otherwise it is deferred to execute.
  const verified = await verifyArtifacts(s.nextCatalog, s.artifacts, withPrevious ? { previous: s.previousCatalog } : { deferMissing: true });
  const input = { bytes: s.bytes, signatureBytes: s.signatureBytes, catalog: s.nextCatalog, verified, publicKey: s.publicKey, sums: checksumText(s.nextCatalog) };
  const publish = (overrides = {}, verifier = fixturePublicVerifier(transport)) => publishWithRequiredPublicGate({ ...input, ...overrides }, transport, verifier);
  const writes = () => transport.events.filter((event) => event.startsWith('put:'));
  return { ...s, transport, verified, input, publish, writes, active: () => transport.objects.get('catalog/v1.json') };
}
const activated = (x) => x.writes().includes('put:catalog/v1.json');

test('publish --execute defers a missing historical copy to the active remote catalog and stays offline until credentials', async (t) => {
  const s = await scenario(t, { channel: 'stable' });
  const execute = ['--execute', '--account-id', 'a'.repeat(32), '--bucket', 'anon-test-releases', '--confirm-dedicated-bucket', 'anon-test-releases'];
  // Local verification no longer fails on the missing copy, so the run reaches the R2 credential requirement without any request.
  for (const extra of [[], previousArgs(s)]) {
    const result = run(...commands.publish(s, '', ...execute, ...extra));
    assert.equal(result.status, 1); assert.match(result.stderr, /Dedicated R2 release credentials are required/);
  }
  // A missing NEW artifact is refused offline when --previous is given; without it, publishVerified refuses before any upload.
  await rm(join(s.artifacts, s.keys.fresh));
  const refused = run(...commands.publish(s, '', ...execute, ...previousArgs(s)));
  assert.equal(refused.status, 1); assert.match(refused.stderr, /has no local copy and is not an unchanged release in the authenticated previous catalog/);
  // The same missing copy without --previous passes local checks too, because only the active remote catalog can decide.
  assert.match(run(...commands.publish(s, '', ...execute)).stderr, /Dedicated R2 release credentials are required/);
});
test('execute verifies a historical R2 object against the signed hash and never uploads it', async (t) => {
  const x = await execution(t);
  assert.equal(x.verified[0].path, null);
  assert.equal((await x.publish()).activated, true);
  const { events } = x.transport; const location = (r) => r.artifacts[0].location;
  assert.ok(events.includes(`head:${x.keys.historical}`)); assert.ok(events.includes(`verify:${x.keys.historical}`));
  assert.equal(events.includes(`put:${x.keys.historical}`), false);
  assert.ok(events.includes(`put:${x.keys.fresh}`));
  // Stored bytes were read before anything was written; the public gate covers both artifacts.
  assert.ok(events.indexOf(`verify:${x.keys.historical}`) < events.findIndex((event) => event.startsWith('put:')));
  for (const release of x.nextCatalog.releases) assert.ok(events.includes(`public:${location(release)}`), `public gate skipped ${location(release)}`);
  assert.ok(events.indexOf(`public:${location(x.historical)}`) < events.indexOf('put:catalog/v1.json'));
  const envelope = JSON.parse(x.active().bytes);
  assert.deepEqual(verifyCatalogSignature(Buffer.from(envelope.catalogBase64, 'base64'), Buffer.from(envelope.signatureBase64, 'base64'), x.publicKey), x.nextCatalog);
});
test('execute refuses a historical R2 object missing from the bucket before any write', async (t) => {
  const x = await execution(t, { historicalObject: null });
  await assert.rejects(x.publish(), /is not in the release bucket and has no local copy; supply the verified local copy/);
  assert.deepEqual(x.writes(), []);
  assert.equal(x.active().etag, '"active-1"');
});
for (const [label, stored, pattern] of [
  ['different size', Buffer.from('short'), /differs from the signed catalog/],
  ['same size, different bytes', Buffer.alloc(testArtifact.length, 7), /hash mismatch/],
]) test(`execute refuses a historical R2 object with ${label} before any write`, async (t) => {
  const x = await execution(t, { historicalObject: stored });
  await assert.rejects(x.publish(), pattern);
  assert.deepEqual(x.writes(), []); assert.equal(x.active().etag, '"active-1"');
});
test('execute still uploads a historical artifact whose local copy is present, as before', async (t) => {
  const x = await execution(t, { copies: ['historical', 'fresh'], historicalObject: null });
  assert.ok(x.verified.every((entry) => entry.path !== null));
  await x.publish();
  assert.ok(x.writes().includes(`put:${x.keys.historical}`));
  assert.equal(x.transport.objects.get(x.keys.historical).bytes.equals(testArtifact), true);
});
test('execute refuses a previous catalog that is not the active remote catalog', async (t) => {
  const x = await execution(t, { withPrevious: true });
  const count = x.transport.events.length;
  const lookalike = Buffer.from(`${x.previousBytes.toString('utf8')} `);
  await assert.rejects(x.publish({ previousCatalogBytes: lookalike }), /--previous must be byte-identical to the authenticated active catalog/);
  assert.deepEqual(x.transport.events.slice(count), ['get:catalog/v1.json']);
  assert.equal(x.active().etag, '"active-1"');
  // With no active catalog there is nothing a previous catalog could equal.
  const first = await execution(t, { activeCatalog: false, withPrevious: true });
  await assert.rejects(first.publish({ previousCatalogBytes: first.previousBytes }), /byte-identical/);
  assert.deepEqual(first.writes(), []);
  // The genuine previous catalog is accepted.
  assert.equal((await x.publish({ previousCatalogBytes: x.previousBytes })).activated, true);
});
test('execute proves history from the active catalog, not from the caller', async (t) => {
  // No active catalog: nothing is unchanged history, so the missing local copy cannot be excused.
  const first = await execution(t, { activeCatalog: false });
  await assert.rejects(first.publish(), new RegExp(`Artifact ${first.keys.historical.replaceAll('.', '\\.')} has no local copy and is not an unchanged release in the authenticated active catalog`));
  assert.deepEqual(first.transport.events, ['get:catalog/v1.json']);
  // A new artifact reported without a local copy is refused although another release is genuine history.
  const x = await execution(t, { copies: ['historical'] });
  assert.equal(x.verified[1].path, null);
  await assert.rejects(x.publish(), /Artifact android\/0\.0\.1-test\/2\/.* has no local copy and is not an unchanged release in the authenticated active catalog/);
  assert.deepEqual(x.transport.events, ['get:catalog/v1.json']);
  // The caller's list must cover every signed artifact.
  const partial = await execution(t);
  await assert.rejects(partial.publish({ verified: partial.verified.slice(1) }), /was not verified/);
  assert.deepEqual(partial.writes(), []);
});
test('execute downloads every historical artifact from its public URL and activates nothing when that fails', async (t) => {
  const x = await execution(t);
  const historicalLocation = x.historical.artifacts[0].location;
  const gate = fixturePublicVerifier(x.transport, async (location) => location === historicalLocation ? new Response('not found', { status: 404 }) : new Response(freshArtifact));
  await assert.rejects(x.publish({}, gate), /Public download must return HTTP 200.*catalog not activated/);
  assert.ok(x.transport.events.includes(`public:${historicalLocation}`));
  assert.equal(activated(x), false); assert.equal(x.writes().some((event) => event.startsWith('put:catalogs/')), false);
  assert.equal(x.active().etag, '"active-1"');
  const corrupt = fixturePublicVerifier(x.transport, async (location) => new Response(location === historicalLocation ? Buffer.alloc(testArtifact.length, 1) : freshArtifact));
  await assert.rejects(x.publish({}, corrupt), /hash\/size mismatch; catalog not activated/);
  assert.equal(activated(x), false);
});

// A historical helper asset on GitHub is never an R2 object: its immutable-release checks remain the gate.
async function githubHistory(t) {
  const helper = fixtureCatalog().releases[0];
  Object.assign(helper, { product: 'network-helper', channel: 'stable' });
  Object.assign(helper.artifacts[0], { platform: 'macos', minimumOs: 'macOS 13+', filename: 'fixture.zip', signing: { kind: 'apple-developer-id', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test (TESTTEAM00)', notarized: true } });
  helper.artifacts[0].location = helperArtifactUrl(helper, 'fixture.zip');
  const { fresh } = releases();
  const s = await scenario(t);
  const previousCatalog = { schemaVersion: 1, releases: [helper] }; const nextCatalog = { schemaVersion: 1, releases: [helper, fresh] };
  const previousBytes = jsonBytes(previousCatalog); const bytes = jsonBytes(nextCatalog);
  const transport = memoryTransport();
  transport.objects.set('catalog/v1.json', { bytes: jsonBytes({ schemaVersion: 1, catalogBase64: previousBytes.toString('base64'), signatureBase64: signCatalog(previousBytes, s.privateKey).toString('base64') }), etag: '"active-1"' });
  const metadata = { tag_name: 'v0.0.0-test-1', immutable: true, draft: false, prerelease: false, assets: [{ name: 'fixture.zip', size: testArtifact.length, digest: `sha256:${sha256(testArtifact)}`, browser_download_url: helper.artifacts[0].location }] };
  const verified = await verifyArtifacts(nextCatalog, s.artifacts, { deferMissing: true });
  const fetchFixture = (override = {}) => async (location) => {
    if (location.startsWith('https://api.github.com/')) return Response.json({ ...metadata, ...override });
    if (location === helper.artifacts[0].location) return new Response(testArtifact);
    return new Response(freshArtifact);
  };
  const publish = (override) => publishWithRequiredPublicGate({ bytes, signatureBytes: signCatalog(bytes, s.privateKey), catalog: nextCatalog, verified, publicKey: s.publicKey, sums: checksumText(nextCatalog) }, transport, fixturePublicVerifier(transport, fetchFixture(override)));
  return { transport, helper, verified, publish, plan: publishPlan({ bytes, signatureBytes: Buffer.alloc(64), catalog: nextCatalog, verified }), key: artifactKey(helper.artifacts[0], helper) };
}
test('a historical GitHub asset is verified through its immutable release and never read or written in R2', async (t) => {
  const g = await githubHistory(t);
  assert.equal(g.verified[0].path, null);
  assert.equal(g.plan.artifacts[0].operation, 'remote-verification-at-execute-no-local-copy-immutable-github-release-no-r2-artifact-upload');
  assert.equal((await g.publish()).activated, true);
  assert.equal(g.transport.events.some((event) => event.endsWith(g.key)), false);
  assert.ok(g.transport.events.includes(`public:${g.helper.artifacts[0].location}`));
  assert.ok(g.transport.events.includes('public:https://api.github.com/repos/anondotinc/network-guard/releases/tags/v0.0.0-test-1'));
});
test('a historical GitHub asset in a mutable release is refused and nothing is activated', async (t) => {
  const g = await githubHistory(t);
  await assert.rejects(g.publish({ immutable: false }), /immutable; catalog not activated/);
  assert.equal(g.transport.events.includes('put:catalog/v1.json'), false);
  assert.equal(g.transport.objects.get('catalog/v1.json').etag, '"active-1"');
});

test('publish plan marks only artifacts without a local copy and leaves full-copy plans unchanged', async (t) => {
  const s = await scenario(t);
  const partial = publishPlan({ bytes: s.bytes, signatureBytes: s.signatureBytes, catalog: s.nextCatalog, verified: await verifyArtifacts(s.nextCatalog, s.artifacts, { previous: s.previousCatalog }) });
  assert.equal(partial.networkRequests, 0); assert.equal(partial.artifactsWithoutLocalCopy, 1);
  assert.match(partial.historicalAuthority, /byte-identical to the authenticated active catalog/);
  const full = await scenario(t, { copies: ['historical', 'fresh'] });
  const plan = publishPlan({ bytes: full.bytes, signatureBytes: full.signatureBytes, catalog: full.nextCatalog, verified: await verifyArtifacts(full.nextCatalog, full.artifacts) });
  assert.equal(Object.hasOwn(plan, 'artifactsWithoutLocalCopy'), false); assert.equal(Object.hasOwn(plan, 'historicalAuthority'), false);
  assert.deepEqual(plan.artifacts.map((entry) => entry.operation), ['conditional-create-then-download-and-hash', 'conditional-create-then-download-and-hash']);
});
