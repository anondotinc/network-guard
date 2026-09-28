import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { assertCatalog, helperArtifactUrl } from './catalog.mjs';
import { artifactKey, invariant, jsonBytes, safeToken, sha256, writeNew } from './lib.mjs';

// Exactly what scripts/build-linux.mjs stages. Anything else is refused.
export const LINUX_FILES = Object.freeze({
  'anon-network-helper': 0o755,
  'anon-network-guard-setup': 0o755,
  'payload.json': 0o644,
  'README.txt': 0o644,
  LICENSE: 0o644,
});
const ELF_MACHINES = { 62: 'x86_64', 183: 'arm64' };
export const LINUX_MINIMUM_OS = 'Linux (static, no glibc requirement)';

/** Architecture of a static 64-bit little-endian ELF executable, or an error. */
export function inspectElf(bytes) {
  invariant(bytes.length > 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'Not an ELF executable');
  invariant(bytes[4] === 2 && bytes[5] === 1, 'Expected a 64-bit little-endian ELF');
  const architecture = ELF_MACHINES[bytes.readUInt16LE(18)];
  invariant(architecture, 'Unsupported ELF machine');
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  invariant(offset + size * count <= bytes.length && size >= 56, 'Truncated ELF program headers');
  for (let index = 0; index < count; index++) {
    // PT_INTERP means a dynamic loader, so a glibc/musl runtime dependency.
    invariant(bytes.readUInt32LE(offset + index * size) !== 3, 'Linux helper binaries must be statically linked');
  }
  return architecture;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** POSIX ustar with fixed owner, mode and time, so equal inputs give equal bytes. */
export function ustar(entries, mtime) {
  const blocks = [];
  for (const { name, mode, data } of entries) {
    invariant(Buffer.byteLength(name) <= 100 && !name.includes('..'), 'Archive path too long or unsafe');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(octal(mode, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(data ? data.length : 0, 12), 124);
    header.write(octal(mtime, 12), 136);
    header.write('        ', 148);
    header.write(data ? '0' : '5', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write('root', 265);
    header.write('root', 297);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header);
    if (data) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** gzip with the OS byte fixed, since zlib records the build platform there. */
export function reproducibleGzip(bytes) {
  const compressed = gzipSync(bytes, { level: 9 });
  compressed[9] = 255;
  return compressed;
}

async function readStaged(folder) {
  invariant((await lstat(folder)).isDirectory(), 'The staged folder must be a real directory, not a symbolic link');
  const root = await realpath(folder);
  const names = (await readdir(root)).sort();
  invariant(JSON.stringify(names) === JSON.stringify(Object.keys(LINUX_FILES).sort()), `The staged folder must contain exactly: ${Object.keys(LINUX_FILES).join(', ')}`);
  const files = {};
  for (const name of names) {
    const info = await lstat(join(root, name));
    invariant(info.isFile(), `${name} must be a regular file`);
    files[name] = await readFile(join(root, name));
  }
  return files;
}

/**
 * Packages a folder staged by scripts/build-linux.mjs. Test packages are never
 * publishable. Stable packages produce an inactive release record whose
 * artifact is authenticated only by the signed catalog's SHA-256.
 */
export async function packageLinux({ folder, version, buildId, releasedAt, out, channel = 'test', notes = [] }) {
  safeToken(version, 'version'); safeToken(buildId, 'buildId');
  invariant(folder && out, 'An explicit staged folder and output directory are required');
  invariant(['test', 'stable'].includes(channel), 'Channel must be test or stable');
  const files = await readStaged(folder);
  let payload;
  try { payload = JSON.parse(files['payload.json']); } catch { throw new Error('payload.json is not JSON'); }
  invariant(JSON.stringify(Object.keys(payload).sort()) === '["channel","schemaVersion","sha256","version"]' && payload.schemaVersion === 1, 'Unexpected payload.json fields');
  invariant(payload.version === version, 'payload.json version does not match --version');
  invariant(payload.sha256 === sha256(files['anon-network-helper']), 'payload.json does not match the bundled helper');
  invariant(channel === 'test' || payload.channel === 'production', 'Only the production channel is distributable; development enrollment is test-only');
  const architecture = inspectElf(files['anon-network-helper']);
  invariant(inspectElf(files['anon-network-guard-setup']) === architecture, 'Helper and setup architectures differ');
  const directory = `anon-network-guard-${version}-linux-${architecture}${payload.channel === 'development' ? '-development' : ''}`;
  const mtime = Math.floor(Date.parse(releasedAt ?? '2026-01-01T00:00:00Z') / 1000);
  invariant(Number.isSafeInteger(mtime) && mtime > 0, 'Invalid --released-at');
  const archive = reproducibleGzip(ustar([
    { name: `${directory}/`, mode: 0o755 },
    ...Object.keys(LINUX_FILES).sort().map((name) => ({ name: `${directory}/${name}`, mode: LINUX_FILES[name], data: files[name] })),
  ], mtime));
  const filename = `anon-network-guard-${version}-${buildId}-linux-${architecture}${channel === 'stable' ? '' : '-UNSIGNED-TEST'}.tar.gz`;
  const info = { bytes: archive.length, sha256: sha256(archive) };
  if (channel === 'test') {
    await writeNew(resolve(out, filename), archive);
    const record = { schemaVersion: 1, product: 'network-helper', version, buildId, channel: 'test', publishable: false, reason: 'Local test package. Not a public download.', filename, ...info, platform: 'linux', architecture, minimumOs: LINUX_MINIMUM_OS, buildChannel: payload.channel };
    await writeNew(resolve(out, `${filename}.json`), jsonBytes(record));
    await writeNew(resolve(out, `${filename}.SHA256SUMS`), `${info.sha256}  ${filename}\n`);
    return record;
  }
  const artifact = { platform: 'linux', architecture, minimumOs: LINUX_MINIMUM_OS, filename, ...info, signing: { kind: 'catalog-sha256' }, location: helperArtifactUrl({ version, buildId }, filename) };
  const release = { product: 'network-helper', version, buildId, releasedAt, channel, status: 'unreleased', notes, artifacts: [artifact] };
  assertCatalog({ schemaVersion: 1, releases: [release] });
  await writeNew(resolve(out, artifactKey(artifact, release)), archive);
  await writeNew(resolve(out, `${filename}.SHA256SUMS`), `${info.sha256}  ${filename}\n`);
  await writeNew(resolve(out, `network-helper-${version}-${buildId}-linux-${architecture}.release.json`), jsonBytes(release));
  return release;
}

