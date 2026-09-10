import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicArtifactVerifier, publishPlan, publishVerified } from '../publish.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCatalog, helperArtifactUrl, helperReleasePage } from '../catalog.mjs';
import { artifactKey, checksumText, sha256 } from '../lib.mjs';
import { fixtureCatalog, signedFixture, testArtifact } from './fixtures.mjs';

function fixture() {
  const catalog = fixtureCatalog(); const release = catalog.releases[0]; const artifact = release.artifacts[0];
  release.product = 'network-helper'; release.channel = 'stable'; artifact.platform = 'macos'; artifact.minimumOs = 'macOS 13+'; artifact.filename = 'fixture.zip';
  artifact.signing = { kind: 'apple-developer-id', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test (TESTTEAM00)', notarized: true };
  artifact.location = helperArtifactUrl(release, artifact.filename);
  const metadata = { tag_name: `v${release.version}-${release.buildId}`, immutable: true, draft: false, prerelease: false, assets: [{ name: artifact.filename, size: artifact.bytes, digest: `sha256:${artifact.sha256}`, browser_download_url: artifact.location }] };
  return { catalog, release, artifact, metadata };
}
test('helper GitHub links are exact tagged official releases; Android stays on R2', () => {
  const f = fixture(); assertCatalog(f.catalog);
  assert.equal(helperReleasePage(f.release, f.artifact), 'https://github.com/anondotinc/network-guard/releases/tag/v0.0.0-test-1');
  assert.equal(artifactKey(f.artifact, f.release), 'network-helper/0.0.0-test/1/fixture.zip');
  assert.match(checksumText(f.catalog), /network-helper\/0.0.0-test\/1\/fixture.zip/);
  for (const bad of [f.artifact.location.replace('/network-guard/', '/network-helper/'), f.artifact.location.replace('/anondotinc/', '/attacker/'), f.artifact.location.replace('/v0.0.0-test-1/', '/latest/'), `${f.artifact.location}?other=1`]) {
    const catalog = structuredClone(f.catalog); catalog.releases[0].artifacts[0].location = bad; assert.throws(() => assertCatalog(catalog));
  }
  const android = fixtureCatalog(); android.releases[0].artifacts[0].location = f.artifact.location; assert.throws(() => assertCatalog(android));
  const signed = signedFixture(f.catalog);
  const plan = publishPlan({ ...signed, verified: [{ artifact: f.artifact, key: artifactKey(f.artifact, f.release) }] });
  assert.match(plan.artifacts[0].operation, /no-r2-artifact-upload/);
});
test('GitHub verifier requires immutable metadata and verifies CDN bytes without credentials', async () => {
  const f = fixture(); const calls = []; const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/456?temporary=token';
  const verify = createPublicArtifactVerifier(async (url, request) => {
    calls.push(url); assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'manual'); assert.equal(request.referrerPolicy, 'no-referrer'); assert.equal(request.headers.authorization, undefined);
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(url, 'https://api.github.com/repos/anondotinc/network-guard/releases/tags/v0.0.0-test-1');
      return Response.json(f.metadata);
    }
    if (url === f.artifact.location) return new Response(null, { status: 302, headers: { location: cdn } });
    assert.equal(url, cdn); return new Response(testArtifact);
  });
  await verify(f.artifact.location, f.artifact); assert.equal(calls.length, 3);
});
for (const [name, mutate] of [
  ['mutable', (f) => { f.metadata.immutable = false; }],
  ['draft', (f) => { f.metadata.draft = true; }],
  ['prerelease', (f) => { f.metadata.prerelease = true; }],
  ['wrong digest', (f) => { f.metadata.assets[0].digest = `sha256:${'b'.repeat(64)}`; }],
  ['duplicate filename', (f) => { f.metadata.assets.push(f.metadata.assets[0]); }],
  ['wrong tag', (f) => { f.metadata.tag_name = 'latest'; }],
]) test(`GitHub ${name} is rejected before asset download`, async () => {
  const f = fixture(); mutate(f); let calls = 0;
  await assert.rejects(createPublicArtifactVerifier(async (url) => { calls++; assert.match(url, /api.github.com/); return Response.json(f.metadata); })(f.artifact.location, f.artifact));
  assert.equal(calls, 1);
});
for (const location of ['https://attacker.example/file', 'http://release-assets.githubusercontent.com/github-production-release-asset/1', 'https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/1', 'https://release-assets.githubusercontent.com:8443/github-production-release-asset/1']) test(`rejects unsafe GitHub redirect: ${new URL(location).host}`, async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(createPublicArtifactVerifier(async (url) => {
    calls++; return url.startsWith('https://api.github.com/') ? Response.json(f.metadata) : new Response(null, { status: 302, headers: { location } });
  })(f.artifact.location, f.artifact), /redirect/);
  assert.equal(calls, 2);
});
test('corrupt GitHub download bytes cannot pass', async () => {
  const f = fixture();
  await assert.rejects(createPublicArtifactVerifier(async (url) => url.startsWith('https://api.github.com/') ? Response.json(f.metadata) : new Response('corrupted'))(f.artifact.location, f.artifact), /hash\/size/);
});

test('new GitHub helper publication verifies its bytes but never uploads its binary to R2', async (t) => {
  const f = fixture(); const signed = signedFixture(f.catalog);
  const root = await mkdtemp(join(tmpdir(), 'anon-github-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip'); await writeFile(path, testArtifact);
  const puts = []; const objects = new Map();
  const transport = {
    get: async () => null,
    head: async () => null,
    put: async (key, data) => { puts.push(key); objects.set(key, data.file ? await readFile(data.file) : data.bytes); },
    verify: async (key, expected) => { assert.equal(sha256(objects.get(key)), expected.sha256); },
  };
  const verifier = createPublicArtifactVerifier(async (url) => url.startsWith('https://api.github.com/') ? Response.json(f.metadata) : new Response(testArtifact));
  await publishVerified({ ...signed, verified: [{ artifact: f.artifact, release: f.release, key: artifactKey(f.artifact, f.release), path }], sums: checksumText(f.catalog) }, transport, verifier);
  assert.equal(puts.some((key) => key.startsWith('network-helper/')), false);
  assert.equal(puts.at(-1), 'catalog/v1.json');
});
