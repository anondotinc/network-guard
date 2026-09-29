import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { assertCatalog, helperArtifactUrl } from './catalog.mjs';
import { artifactKey, invariant, jsonBytes, run, safeToken, sha256, writeNew } from './lib.mjs';

// Exactly what scripts/build-windows.mjs stages. Anything else is refused.
export const WINDOWS_FILES = Object.freeze(['LICENSE.txt', 'README.txt', 'anon-network-guard-setup.exe', 'anon-network-helper.exe', 'payload.json']);
const EXECUTABLES = ['anon-network-helper.exe', 'anon-network-guard-setup.exe'];
const PE_MACHINES = { 0x8664: 'x86_64', 0xaa64: 'arm64' };
export const WINDOWS_MINIMUM_OS = 'Windows 10 22H2 or Windows 11';

/** Architecture of a 64-bit PE executable that doesn't need the VC++ runtime. */
export function inspectPe(bytes) {
  invariant(bytes.length > 0x40 && bytes.toString('latin1', 0, 2) === 'MZ', 'Not a Windows executable');
  const header = bytes.readUInt32LE(0x3c);
  invariant(header + 24 < bytes.length && bytes.toString('latin1', header, header + 4) === 'PE\0\0', 'Missing PE header');
  const architecture = PE_MACHINES[bytes.readUInt16LE(header + 4)];
  invariant(architecture, 'Unsupported PE machine');
  invariant(!/vcruntime\d+\.dll/i.test(bytes.toString('latin1')), 'Windows binaries must link the C runtime statically');
  return architecture;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(date) {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/** Deflated zip with fixed times and attributes, so equal inputs give equal bytes. */
export function reproducibleZip(entries, date) {
  const { time, day } = dosTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(day, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Parses `osslsigncode verify` output: the signature must verify, be
 * timestamped, and the leaf signer's CN must equal `subject`.
 */
export function inspectAuthenticode(output, subject) {
  invariant(typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && !/[\u0000-\u001f\u007f,=/]/.test(subject), 'An explicit signer subject (certificate common name) is required');
  invariant(/^Signature verification: ok$/m.test(output), 'Authenticode signature did not verify');
  invariant(/Timestamp/i.test(output) && !/No timestamp/i.test(output), 'Authenticode signature must be timestamped');
  const signer = output.split(/Signer's certificate:|Signer certificate:/i)[1] ?? '';
  const cn = signer.match(/Subject:\s*[^\n]*?CN\s*=\s*([^,/\n]+)/)?.[1]?.trim();
  invariant(cn === subject, 'Authenticode signer does not match the approved publisher');
  return { kind: 'authenticode', subject, timestamped: true };
}

async function readStaged(folder) {
  invariant((await lstat(folder)).isDirectory(), 'The staged folder must be a real directory, not a symbolic link');
  const root = await realpath(folder);
  const names = (await readdir(root)).sort();
  invariant(JSON.stringify(names) === JSON.stringify([...WINDOWS_FILES].sort()), `The staged folder must contain exactly: ${WINDOWS_FILES.join(', ')}`);
  const files = {};
  for (const name of names) {
    invariant((await lstat(join(root, name))).isFile(), `${name} must be a regular file`);
    files[name] = await readFile(join(root, name));
  }
  return { root, files };
}

/**
 * Packages a folder staged by scripts/build-windows.mjs. Test packages are
 * never publishable. Stable packages require both executables to verify with a
 * timestamped Authenticode signature from `signerSubject`.
 */
export async function packageWindows({ folder, version, buildId, releasedAt, out, channel = 'test', notes = [], signerSubject }, execute = run) {
  safeToken(version, 'version'); safeToken(buildId, 'buildId');
  invariant(folder && out, 'An explicit staged folder and output directory are required');
  invariant(['test', 'stable'].includes(channel), 'Channel must be test or stable');
  const { root, files } = await readStaged(folder);
  let payload;
  try { payload = JSON.parse(files['payload.json']); } catch { throw new Error('payload.json is not JSON'); }
  invariant(JSON.stringify(Object.keys(payload).sort()) === '["channel","schemaVersion","sha256","version"]' && payload.schemaVersion === 1, 'Unexpected payload.json fields');
  invariant(payload.version === version, 'payload.json version does not match --version');
  invariant(payload.sha256 === sha256(files['anon-network-helper.exe']), 'payload.json does not match the bundled helper');
  invariant(channel === 'test' || payload.channel === 'production', 'Only the production channel is distributable; development enrollment is test-only');
  const architecture = inspectPe(files['anon-network-helper.exe']);
  invariant(inspectPe(files['anon-network-guard-setup.exe']) === architecture, 'Helper and setup architectures differ');
  let signing;
  if (channel === 'stable') {
    for (const name of EXECUTABLES) signing = inspectAuthenticode(execute('osslsigncode', ['verify', '-in', join(root, name)]), signerSubject);
  } else {
    invariant(!signerSubject, 'Test packages are unsigned; --signer-subject is for stable packages');
  }
  const directory = `anon-network-guard-${version}-windows-${architecture}${payload.channel === 'development' ? '-development' : ''}`;
  const date = new Date(releasedAt ?? '2026-01-01T00:00:00Z');
  invariant(Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1980, 'Invalid --released-at');
  const archive = reproducibleZip([...WINDOWS_FILES].sort().map((name) => ({ name: `${directory}/${name}`, data: files[name] })), date);
  const filename = `anon-network-guard-${version}-${buildId}-windows-${architecture}${channel === 'stable' ? '' : '-UNSIGNED-TEST'}.zip`;
  const info = { bytes: archive.length, sha256: sha256(archive) };
  if (channel === 'test') {
    await writeNew(resolve(out, filename), archive);
    const record = { schemaVersion: 1, product: 'network-helper', version, buildId, channel: 'test', publishable: false, reason: 'Unsigned local test package. Not a public download.', filename, ...info, platform: 'windows', architecture, minimumOs: WINDOWS_MINIMUM_OS, buildChannel: payload.channel };
    await writeNew(resolve(out, `${filename}.json`), jsonBytes(record));
    await writeNew(resolve(out, `${filename}.SHA256SUMS`), `${info.sha256}  ${filename}\n`);
    return record;
  }
  const artifact = { platform: 'windows', architecture, minimumOs: WINDOWS_MINIMUM_OS, filename, ...info, signing, location: helperArtifactUrl({ version, buildId }, filename) };
  const release = { product: 'network-helper', version, buildId, releasedAt, channel, status: 'unreleased', notes, artifacts: [artifact] };
  assertCatalog({ schemaVersion: 1, releases: [release] });
  await writeNew(resolve(out, artifactKey(artifact, release)), archive);
  await writeNew(resolve(out, `${filename}.SHA256SUMS`), `${info.sha256}  ${filename}\n`);
  await writeNew(resolve(out, `network-helper-${version}-${buildId}-windows-${architecture}.release.json`), jsonBytes(release));
  return release;
}
