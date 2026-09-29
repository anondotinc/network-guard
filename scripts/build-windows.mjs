#!/usr/bin/env node
// Builds the Windows helper and setup program for one channel (static C
// runtime), stages the folder release/cli.mjs package-windows expects, and
// exercises the built host over real pipes. With NETWORK_GUARD_SETUP_SMOKE=1
// (set in CI, never by default) it also installs, checks and uninstalls for the
// current user, which writes HKCU registration keys. No VPN provider is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--channel' || !['development', 'production'].includes(args[1])) {
  throw new Error('Usage: node scripts/build-windows.mjs --channel development|production');
}
if (process.platform !== 'win32') throw new Error('Build the Windows helper on Windows (CI runs windows-2025 and windows-11-arm).');
const channel = args[1];
const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch];
assert.ok(arch, `Unsupported build architecture: ${process.arch}`);
const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, 'rust', 'target');

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}
function must(command, argv, options) {
  const result = run(command, argv, options);
  assert.equal(result.status, 0, `${command} ${argv.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

must('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(root, 'rust', 'Cargo.toml'), ...(channel === 'development' ? ['--features', 'development'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
const built = path.join(targetDir, target, 'release');
const folder = path.join(root, 'dist', 'windows', channel, `anon-network-guard-${buildVersion.version}-windows-${arch}${channel === 'development' ? '-development' : ''}`);
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
for (const name of ['anon-network-helper.exe', 'anon-network-guard-setup.exe']) copyFileSync(path.join(built, name), path.join(folder, name));
const helper = path.join(folder, 'anon-network-helper.exe');
const helperBytes = readFileSync(helper);
assert.ok(!/vcruntime\d+\.dll/i.test(helperBytes.toString('latin1')), 'the C runtime must be linked statically');
const sha256 = createHash('sha256').update(helperBytes).digest('hex');
writeFileSync(path.join(folder, 'payload.json'), `${JSON.stringify({ schemaVersion: 1, version: buildVersion.version, channel, sha256 }, null, 2)}\n`);
writeFileSync(path.join(folder, 'LICENSE.txt'), readFileSync(path.join(root, 'LICENSE'), 'utf8').replace(/\r?\n/g, '\r\n'));
writeFileSync(path.join(folder, 'README.txt'), readme().replace(/\r?\n/g, '\r\n'));

// --- Wire checks through the built host ----------------------------------------------------
const origins = { development: 'chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/', production: 'chrome-extension://gnkbgepgknkbhnnbaihklcfkjhbclajk/' };
const other = channel === 'development' ? origins.production : origins.development;
const id = '00000000-0000-4000-8000-000000000001';
const frame = (object) => {
  const data = Buffer.from(JSON.stringify(object));
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
};
function exchange(binary, requests, extra = []) {
  const result = spawnSync(binary, [origins[channel], ...extra], { input: Buffer.concat(requests.map(frame)), timeout: 10000 });
  if (result.error) throw result.error;
  const replies = [];
  for (let offset = 0; offset < result.stdout.length;) {
    const bytes = result.stdout.readUInt32LE(offset); offset += 4;
    assert.ok(bytes > 0 && bytes <= 4096);
    replies.push(JSON.parse(result.stdout.subarray(offset, offset + bytes).toString())); offset += bytes;
  }
  return { status: result.status, stderr: result.stderr.toString(), replies };
}
assert.ok(must(helper, ['--version']).startsWith(`${buildVersion.version} (${buildVersion.build}) ${channel} windows/${arch}`));
// Chrome on Windows appends --parent-window=<handle>; it must be accepted.
const wire = exchange(helper, [{ v: 8, id, method: 'describe' }, { v: 4, id, method: 'describe' }, { v: 3, id, method: 'probe', provider: 'mullvad' }], ['--parent-window=0']);
assert.equal(wire.status, 0, wire.stderr);
assert.deepEqual(wire.replies[0], { v: 8, id, ok: true, helper: { version: buildVersion.version, build: buildVersion.build, channel, platform: 'windows', arch, protocols: [1, 2, 3, 4, 5, 8], providers: { ivpn: ['read-status', 'connect-selected'], mullvad: ['read-status', 'connect-selected'], nordvpn: ['open-app'], protonvpn: ['open-app'] } } });
assert.equal(wire.replies[1].helper.channel, channel);
// No provider is installed on CI runners: probe must fail closed, not crash.
assert.equal(wire.replies[2].ok, true);
assert.equal(wire.replies[2].availability.available, false);
const rejected = spawnSync(helper, [other], { input: Buffer.alloc(0), timeout: 10000 });
assert.equal(rejected.status, 64); assert.equal(rejected.stdout.length, 0);
assert.equal(spawnSync(helper, [origins[channel], '--not-parent-window'], { timeout: 10000 }).status, 64);
const oversized = spawnSync(helper, [origins[channel]], { input: Buffer.from([0x01, 0x10, 0, 0]), timeout: 10000 });
assert.equal(oversized.status, 65);

// --- Setup for the current user (CI only) ----------------------------------------------------
if (process.env.NETWORK_GUARD_SETUP_SMOKE === '1') {
  const host = channel === 'development' ? 'inc.anon.network_helper.dev' : 'inc.anon.network_helper';
  const local = process.env.LOCALAPPDATA;
  const chromeProfile = path.join(local, 'Google', 'Chrome', 'User Data');
  const createdProfile = !existsSync(chromeProfile);
  mkdirSync(chromeProfile, { recursive: true });
  const setup = (command) => run(path.join(folder, 'anon-network-guard-setup.exe'), [command]);
  const registered = () => run('reg', ['query', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${host}`, '/ve']);
  try {
    const install = setup('install');
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const value = registered();
    assert.equal(value.status, 0, 'Chrome registration exists');
    const manifestPath = path.join(local, 'Anon', 'NetworkGuard', channel, 'hosts', `${host}.json`);
    assert.ok(value.stdout.includes(manifestPath), value.stdout);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [origins[channel]]);
    assert.equal(exchange(manifest.path, [{ v: 8, id, method: 'describe' }]).replies[0].ok, true, 'the registered helper answers');
    assert.match(setup('check').stdout, /is installed for/);
    const uninstall = setup('uninstall');
    assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
    assert.notEqual(registered().status, 0, 'registration removed');
    assert.ok(!existsSync(path.join(local, 'Anon', 'NetworkGuard', channel)));
  } finally {
    if (createdProfile) rmSync(path.join(local, 'Google'), { recursive: true, force: true });
  }
}
console.log(`Staged ${path.relative(root, folder)} (helper sha256 ${sha256}). Wire${process.env.NETWORK_GUARD_SETUP_SMOKE === '1' ? ' and setup' : ''} checks passed.`);

function readme() {
  return `Anon Network Guard ${buildVersion.version} for Windows (${arch})${channel === 'development' ? ' - development channel, test builds of Anon only' : ''}

Network Guard lets the Anon browser extension read your VPN app's connection
status and, if you turn on auto-connect, ask it to connect. It is not a VPN. It
does not route, inspect or block traffic, and it has no network access of its own.

Install for your Windows account (no administrator rights, no background service):
double-click anon-network-guard-setup.exe, or run

  anon-network-guard-setup.exe install

This registers Network Guard with the Google Chrome, Microsoft Edge, Brave and
Chromium profiles on this account. Open the browser once before installing.

Then in Anon: Settings > Connection privacy > Allow local access > Verify Network Guard.

Check or remove it from this folder:

  anon-network-guard-setup.exe check
  anon-network-guard-setup.exe uninstall

VPN apps: Mullvad and IVPN (status and connect), NordVPN and Proton VPN (open
the app). Network Guard only uses a VPN app installed in Program Files and
signed by its publisher.

Source, checksums and verification: https://github.com/anondotinc/network-guard
Setup guide: https://anon.inc/setup/network-guard?os=windows
`;
}
