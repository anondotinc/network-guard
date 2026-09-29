import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCatalog, validateCatalog } from '../catalog.mjs';
import { inspectAuthenticode, inspectPe, packageWindows, reproducibleZip, WINDOWS_FILES } from '../windows.mjs';
import { jsonBytes, sha256 } from '../lib.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'anon-windows-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal PE: MZ stub, PE signature at 0x40, machine field, optional filler. */
function pe(machine, filler = 'synthetic') {
  const bytes = Buffer.alloc(0x40 + 24);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write('PE\0\0', 0x40, 'latin1');
  bytes.writeUInt16LE(machine, 0x44);
  return Buffer.concat([bytes, Buffer.from(filler)]);
}

const signedOutput = (cn) => `Current PE checksum   : 00000000
Signer's certificate:
\t\tSigner #0:
\t\t\tSubject: /C=SE/L=Gothenburg/O=${cn}/CN=${cn}
\t\t\tIssuer : /C=US/O=DigiCert, Inc./CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1
Timestamp time: Sep 20 12:00:00 2026 GMT
Signature verification: ok
`;

async function stage(t, { channel = 'production', machine = 0x8664, helper = pe(machine, 'helper'), extra = null } = {}) {
  const folder = join(await temp(t), 'staged');
  await mkdir(folder);
  await writeFile(join(folder, 'anon-network-helper.exe'), helper);
  await writeFile(join(folder, 'anon-network-guard-setup.exe'), pe(machine, 'setup'));
  await writeFile(join(folder, 'payload.json'), jsonBytes({ schemaVersion: 1, version: '0.2.0', channel, sha256: sha256(helper) }));
  await writeFile(join(folder, 'README.txt'), 'Read me\r\n');
  await writeFile(join(folder, 'LICENSE.txt'), 'MIT\r\n');
  if (extra) await writeFile(join(folder, extra), 'unexpected');
  return folder;
}

function windowsRelease() {
  const filename = 'anon-network-guard-0.2.0-8-windows-x86_64.zip';
  return { schemaVersion: 1, releases: [{ product: 'network-helper', version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', channel: 'stable', status: 'unreleased', notes: [],
    artifacts: [{ platform: 'windows', architecture: 'x86_64', minimumOs: 'Windows 10 22H2 or Windows 11', filename, bytes: 10, sha256: 'a'.repeat(64),
      signing: { kind: 'authenticode', subject: 'AHLOOP LLC', timestamped: true }, location: `https://github.com/anondotinc/network-guard/releases/download/v0.2.0-8/${filename}` }] }] };
}

test('catalog accepts a signed Windows helper artifact', () => { assertCatalog(windowsRelease()); });

for (const [label, mutate] of [
  ['an untimestamped signature', (a) => { a.signing.timestamped = false; }],
  ['catalog-only signing on Windows', (a) => { a.signing = { kind: 'catalog-sha256' }; }],
  ['a tarball for Windows', (a) => { a.filename = a.filename.replace('.zip', '.tar.gz'); a.location = a.location.replace('.zip', '.tar.gz'); }],
  ['a universal Windows build', (a) => { a.architecture = 'universal'; }],
  ['an empty publisher', (a) => { a.signing.subject = ''; }],
]) test(`catalog rejects ${label}`, () => {
  const catalog = windowsRelease();
  mutate(catalog.releases[0].artifacts[0]);
  assert.equal(validateCatalog(catalog).valid, false);
});

test('PE inspection requires x86_64 or arm64 and a static C runtime', () => {
  assert.equal(inspectPe(pe(0x8664)), 'x86_64');
  assert.equal(inspectPe(pe(0xaa64)), 'arm64');
  assert.throws(() => inspectPe(pe(0x14c)), /Unsupported PE machine/);
  assert.throws(() => inspectPe(pe(0x8664, 'imports VCRUNTIME140.dll')), /statically/);
  assert.throws(() => inspectPe(Buffer.from('#!/bin/sh\n'.repeat(20))), /Not a Windows executable/);
});

test('Authenticode output must verify, be timestamped and name the publisher', () => {
  assert.deepEqual(inspectAuthenticode(signedOutput('AHLOOP LLC'), 'AHLOOP LLC'), { kind: 'authenticode', subject: 'AHLOOP LLC', timestamped: true });
  assert.throws(() => inspectAuthenticode(signedOutput('Someone Else'), 'AHLOOP LLC'), /approved publisher/);
  assert.throws(() => inspectAuthenticode(signedOutput('AHLOOP LLC').replace('ok', 'failed'), 'AHLOOP LLC'), /did not verify/);
  assert.throws(() => inspectAuthenticode(signedOutput('AHLOOP LLC').replace('Timestamp time: Sep 20 12:00:00 2026 GMT\n', ''), 'AHLOOP LLC'), /timestamped/);
  assert.throws(() => inspectAuthenticode(signedOutput('AHLOOP LLC'), ''), /explicit signer subject/);
});

test('zips are reproducible and extract with standard tools', async (t) => {
  const entries = [{ name: 'dir/a.txt', data: Buffer.from('alpha\n') }, { name: 'dir/b.bin', data: Buffer.alloc(5000, 7) }];
  const date = new Date('2026-10-01T00:00:00Z');
  const zip = reproducibleZip(entries, date);
  assert.deepEqual(zip, reproducibleZip(entries, date));
  const dir = await temp(t);
  await writeFile(join(dir, 'x.zip'), zip);
  const unzip = spawnSync('unzip', ['-o', 'x.zip'], { cwd: dir, encoding: 'utf8' });
  if (unzip.error) return t.skip('unzip is not installed');
  assert.equal(unzip.status, 0, unzip.stderr);
  assert.equal(await readFile(join(dir, 'dir/a.txt'), 'utf8'), 'alpha\n');
  assert.deepEqual(await readFile(join(dir, 'dir/b.bin')), Buffer.alloc(5000, 7));
});

test('test packages are unsigned, reproducible and never publishable', async (t) => {
  const folder = await stage(t);
  const out = await temp(t);
  const record = await packageWindows({ folder, version: '0.2.0', buildId: '8', out });
  assert.equal(record.publishable, false);
  assert.equal(record.filename, 'anon-network-guard-0.2.0-8-windows-x86_64-UNSIGNED-TEST.zip');
  const again = await packageWindows({ folder, version: '0.2.0', buildId: '8', out: await temp(t) });
  assert.equal(again.sha256, record.sha256);
  assert.equal(sha256(await readFile(join(out, record.filename))), record.sha256);
});

test('stable packages verify both executables against the named publisher', async (t) => {
  const folder = await stage(t, { machine: 0xaa64 });
  const seen = [];
  const verifier = (command, args) => { seen.push([command, args[0], args[2].split(/[\\/]/).at(-1)]); return signedOutput('AHLOOP LLC'); };
  const release = await packageWindows({ folder, version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', out: await temp(t), channel: 'stable', signerSubject: 'AHLOOP LLC' }, verifier);
  assert.deepEqual(seen, [['osslsigncode', 'verify', 'anon-network-helper.exe'], ['osslsigncode', 'verify', 'anon-network-guard-setup.exe']]);
  assert.deepEqual(release.artifacts[0].signing, { kind: 'authenticode', subject: 'AHLOOP LLC', timestamped: true });
  assert.equal(release.artifacts[0].architecture, 'arm64');
  await assert.rejects(packageWindows({ folder, version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', out: await temp(t), channel: 'stable', signerSubject: 'AHLOOP LLC' }, () => signedOutput('Impostor')), /approved publisher/);
});

test('packaging refuses mismatched or unsafe inputs', async (t) => {
  const out = await temp(t);
  await assert.rejects(packageWindows({ folder: await stage(t, { extra: 'install.bat' }), version: '0.2.0', buildId: '8', out }), /exactly/);
  await assert.rejects(packageWindows({ folder: await stage(t, { channel: 'development' }), version: '0.2.0', buildId: '8', releasedAt: '2026-10-01T00:00:00Z', out, channel: 'stable', signerSubject: 'AHLOOP LLC' }, () => signedOutput('AHLOOP LLC')), /production channel/);
  await assert.rejects(packageWindows({ folder: await stage(t), version: '0.2.0', buildId: '8', out, signerSubject: 'AHLOOP LLC' }), /unsigned/);
  const tampered = await stage(t);
  await writeFile(join(tampered, 'anon-network-helper.exe'), pe(0x8664, 'changed'));
  await assert.rejects(packageWindows({ folder: tampered, version: '0.2.0', buildId: '8', out }), /does not match the bundled helper/);
  assert.equal(WINDOWS_FILES.length, 5);
});
