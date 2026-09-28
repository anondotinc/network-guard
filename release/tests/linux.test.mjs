import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCatalog, validateCatalog } from '../catalog.mjs';
import { inspectElf, LINUX_FILES, packageLinux, reproducibleGzip, ustar } from '../linux.mjs';
import { jsonBytes, sha256 } from '../lib.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'anon-linux-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal 64-bit little-endian ELF with the given machine and program header types. */
function elf(machine, types = [1], filler = 'synthetic') {
  const bytes = Buffer.alloc(64 + 56 * types.length);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(types.length, 56);
  types.forEach((type, index) => bytes.writeUInt32LE(type, 64 + index * 56));
  return Buffer.concat([bytes, Buffer.from(filler)]);
}

async function stage(t, { channel = 'production', machine = 62, extra = null, helper = elf(machine, [1], 'helper'), payloadVersion = '0.2.0' } = {}) {
  const folder = join(await temp(t), 'staged');
  await mkdir(folder);
  await writeFile(join(folder, 'anon-network-helper'), helper, { mode: 0o755 });
  await writeFile(join(folder, 'anon-network-guard-setup'), elf(machine, [1], 'setup'), { mode: 0o755 });
  await writeFile(join(folder, 'payload.json'), jsonBytes({ schemaVersion: 1, version: payloadVersion, channel, sha256: sha256(helper) }));
  await writeFile(join(folder, 'README.txt'), 'Read me\n');
  await writeFile(join(folder, 'LICENSE'), 'MIT\n');
  if (extra) await writeFile(join(folder, extra), 'unexpected');
  return folder;
}

function linuxRelease() {
  const filename = 'anon-network-guard-0.2.0-8-linux-x86_64.tar.gz';
  return {
    schemaVersion: 1,
    releases: [{
      product: 'network-helper', version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', channel: 'stable', status: 'unreleased', notes: [],
      artifacts: [{ platform: 'linux', architecture: 'x86_64', minimumOs: 'Linux (static, no glibc requirement)', filename, bytes: 10, sha256: 'a'.repeat(64),
        signing: { kind: 'catalog-sha256' }, location: `https://github.com/anondotinc/network-guard/releases/download/v0.2.0-8/${filename}` }],
    }],
  };
}

test('catalog accepts a Linux helper artifact authenticated by the signed catalog', () => {
  assertCatalog(linuxRelease());
});

for (const [label, mutate] of [
  ['an Apple signature on Linux', (a) => { a.signing = { kind: 'apple-developer-id', teamId: 'TESTTEAM00', identity: 'Developer ID Application: Test (TESTTEAM00)', notarized: true }; }],
  ['extra signing fields', (a) => { a.signing.detached = 'sig'; }],
  ['a zip for Linux', (a) => { a.filename = a.filename.replace('.tar.gz', '.zip'); a.location = a.location.replace('.tar.gz', '.zip'); }],
  ['a universal Linux build', (a) => { a.architecture = 'universal'; }],
  ['catalog-sha256 on macOS', (a) => { a.platform = 'macos'; a.architecture = 'universal'; a.filename = 'x.zip'; a.location = 'https://github.com/anondotinc/network-guard/releases/download/v0.2.0-8/x.zip'; }],
]) test(`catalog rejects ${label}`, () => {
  const catalog = linuxRelease();
  mutate(catalog.releases[0].artifacts[0]);
  assert.equal(validateCatalog(catalog).valid, false);
});

test('catalog rejects Linux artifacts on other products', () => {
  const catalog = linuxRelease();
  catalog.releases[0].product = 'android';
  assert.equal(validateCatalog(catalog).valid, false);
});

test('ELF inspection requires static 64-bit x86_64 or arm64', () => {
  assert.equal(inspectElf(elf(62)), 'x86_64');
  assert.equal(inspectElf(elf(183)), 'arm64');
  assert.throws(() => inspectElf(elf(62, [1, 3])), /statically linked/);
  assert.throws(() => inspectElf(elf(40)), /Unsupported ELF machine/);
  assert.throws(() => inspectElf(Buffer.from('#!/bin/sh\necho not elf\n'.repeat(5))), /Not an ELF/);
});

test('archives are byte-for-byte reproducible', () => {
  const entries = [{ name: 'dir/', mode: 0o755 }, { name: 'dir/file', mode: 0o644, data: Buffer.from('x') }];
  const first = reproducibleGzip(ustar(entries, 1_790_000_000));
  const second = reproducibleGzip(ustar(entries, 1_790_000_000));
  assert.deepEqual(first, second);
  assert.equal(first[9], 255, 'gzip OS byte is fixed');
});

test('test packages extract to the exact layout with executable binaries', async (t) => {
  const folder = await stage(t);
  const out = await temp(t);
  const record = await packageLinux({ folder, version: '0.2.0', buildId: '8', out });
  assert.equal(record.publishable, false);
  assert.equal(record.architecture, 'x86_64');
  assert.equal(record.filename, 'anon-network-guard-0.2.0-8-linux-x86_64-UNSIGNED-TEST.tar.gz');
  const archive = join(out, record.filename);
  assert.equal(sha256(await readFile(archive)), record.sha256);
  const listing = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const extract = await temp(t);
  assert.equal(spawnSync('tar', ['-xzf', archive, '-C', extract]).status, 0);
  const root = join(extract, 'anon-network-guard-0.2.0-linux-x86_64');
  for (const [name, mode] of Object.entries(LINUX_FILES)) {
    assert.equal((await stat(join(root, name))).mode & 0o777, mode, name);
  }
  const again = await temp(t);
  const repeat = await packageLinux({ folder, version: '0.2.0', buildId: '8', out: again });
  assert.equal(repeat.sha256, record.sha256, 'same inputs, same archive');
});

test('stable packages produce an inactive catalog release', async (t) => {
  const folder = await stage(t, { machine: 183 });
  const out = await temp(t);
  const release = await packageLinux({ folder, version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', out, channel: 'stable' });
  assert.equal(release.status, 'unreleased');
  assert.deepEqual(release.artifacts[0].signing, { kind: 'catalog-sha256' });
  assert.equal(release.artifacts[0].location, 'https://github.com/anondotinc/network-guard/releases/download/v0.2.0-8/anon-network-guard-0.2.0-8-linux-arm64.tar.gz');
  assert.equal(sha256(await readFile(join(out, 'network-helper/0.2.0/8/anon-network-guard-0.2.0-8-linux-arm64.tar.gz'))), release.artifacts[0].sha256);
});

test('packaging refuses mismatched or unsafe inputs', async (t) => {
  const out = await temp(t);
  await assert.rejects(packageLinux({ folder: await stage(t, { channel: 'development' }), version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', out, channel: 'stable' }), /production channel/);
  await assert.rejects(packageLinux({ folder: await stage(t, { extra: 'install.sh' }), version: '0.2.0', buildId: '8', out }), /exactly/);
  await assert.rejects(packageLinux({ folder: await stage(t, { payloadVersion: '0.1.9' }), version: '0.2.0', buildId: '8', out }), /version/);
  await assert.rejects(packageLinux({ folder: await stage(t, { helper: elf(62, [1, 3]) }), version: '0.2.0', buildId: '8', out }), /statically linked/);
  const mixed = await stage(t);
  await writeFile(join(mixed, 'anon-network-guard-setup'), elf(183));
  await assert.rejects(packageLinux({ folder: mixed, version: '0.2.0', buildId: '8', out }), /architectures differ/);
  const tampered = await stage(t);
  await writeFile(join(tampered, 'anon-network-helper'), elf(62, [1], 'changed'));
  await assert.rejects(packageLinux({ folder: tampered, version: '0.2.0', buildId: '8', out }), /does not match the bundled helper/);
});
