import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactKey, jsonBytes, sha256, verifyCatalogSignature } from '../lib.mjs';
import { prepareMetadataSigner, privateKeyOutsideRepositories, signMetadataBundle, trustedMetadataKeyPath } from '../metadata.mjs';
import { fixtureCatalog, testArtifact } from './fixtures.mjs';

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anon-metadata-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const privateKey = join(root, 'fixture-private.pem');
  const publicKey = join(root, 'fixture-public.pub');
  await writeFile(privateKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(publicKey, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  return { root, privateKey, publicKey };
}
test('pinned public discovery matches the Ed25519 SPKI key', async () => {
  const record = JSON.parse(await readFile(new URL('../trust/anon-releases.json', import.meta.url)));
  const key = createPublicKey(await readFile(trustedMetadataKeyPath));
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(record.keys.length, 1);
  assert.equal(record.keys[0].spkiSha256, sha256(key.export({ type: 'spki', format: 'der' })));
  assert.equal(record.purpose, 'anon-application-release-metadata');
});
test('signs exact verified artifact metadata, detects tampering, refuses output overwrite', async t => {
  const config = await setup(t);
  const signer = await prepareMetadataSigner(config);
  const bytes = jsonBytes(fixtureCatalog());
  const catalog = fixtureCatalog();
  const artifact = join(config.root, artifactKey(catalog.releases[0].artifacts[0]));
  await mkdir(join(artifact, '..'), { recursive: true });
  await writeFile(artifact, testArtifact);
  const out = join(config.root, 'metadata');
  const result = await signMetadataBundle({ bytes, artifacts: config.root, out, signer });
  assert.equal(result.activated, false);
  const signature = await readFile(join(out, 'catalog.json.sig'));
  assert.deepEqual(verifyCatalogSignature(bytes, signature, signer.publicKey), catalog);
  assert.throws(() => verifyCatalogSignature(Buffer.concat([bytes, Buffer.from(' ')]), signature, signer.publicKey), /verification failed/);
  await assert.rejects(signMetadataBundle({ bytes, artifacts: config.root, out, signer }), /EEXIST/);
  await writeFile(artifact, 'corrupted');
  await assert.rejects(signMetadataBundle({ bytes, artifacts: config.root, out: join(config.root, 'corrupted'), signer }));
});
test('wrong metadata key and default official pin fail before any signing output', async t => {
  const config = await setup(t);
  const other = await setup(t);
  await assert.rejects(prepareMetadataSigner({ ...config, publicKey: other.publicKey }), /does not match/);
  await assert.rejects(prepareMetadataSigner({ privateKey: config.privateKey }), /does not match/);
});
test('private keys cannot be symlinked, shared or inside a checkout', async t => {
  const config = await setup(t);
  const link = join(config.root, 'link.pem');
  await symlink(config.privateKey, link);
  await assert.rejects(privateKeyOutsideRepositories(link), /symlink/);
  await chmod(config.privateKey, 0o644);
  await assert.rejects(privateKeyOutsideRepositories(config.privateKey), /owner/);
  await chmod(config.privateKey, 0o600);
  await mkdir(join(config.root, '.git'));
  await assert.rejects(privateKeyOutsideRepositories(config.privateKey), /outside every Git/);
});
test('signed package CLI checks metadata trust before touching an app or invoking Apple', async t => {
  const config = await setup(t);
  const cli = new URL('../cli.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'package-helper', '--execute-signing', '--metadata-private-key', config.privateKey, '--app', join(config.root, 'absent.app'), '--out', join(config.root, 'absent-output')], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the trusted release public key/);
});
