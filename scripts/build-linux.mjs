#!/usr/bin/env node
// Builds the static Linux helper and setup program for one channel, stages the
// release folder that release/cli.mjs package-linux expects, then exercises the
// built binaries: wire protocol through a real process, and install / check /
// uninstall in a throwaway home. No VPN provider is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--channel' || !['development', 'production'].includes(args[1])) {
  throw new Error('Usage: node scripts/build-linux.mjs --channel development|production');
}
if (process.platform !== 'linux') throw new Error('Build the Linux helper on Linux (CI runs ubuntu-24.04 and ubuntu-24.04-arm).');
const channel = args[1];
const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch];
assert.ok(arch, `Unsupported build architecture: ${process.arch}`);
const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, 'rust/target');

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

must('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(root, 'rust/Cargo.toml'), ...(channel === 'development' ? ['--features', 'development'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
const built = path.join(targetDir, target, 'release');
const folder = path.join(root, 'dist/linux', channel, `anon-network-guard-${buildVersion.version}-linux-${arch}${channel === 'development' ? '-development' : ''}`);
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
for (const name of ['anon-network-helper', 'anon-network-guard-setup']) {
  copyFileSync(path.join(built, name), path.join(folder, name));
  chmodSync(path.join(folder, name), 0o755);
}
const helper = path.join(folder, 'anon-network-helper');
const sha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
writeFileSync(path.join(folder, 'payload.json'), `${JSON.stringify({ schemaVersion: 1, version: buildVersion.version, channel, sha256 }, null, 2)}\n`, { mode: 0o644 });
copyFileSync(path.join(root, 'LICENSE'), path.join(folder, 'LICENSE'));
writeFileSync(path.join(folder, 'README.txt'), readme(), { mode: 0o644 });

// --- Wire checks through the built host --------------------------------------------------
const origins = { development: 'chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/', production: 'chrome-extension://gnkbgepgknkbhnnbaihklcfkjhbclajk/' };
const other = channel === 'development' ? origins.production : origins.development;
const id = '00000000-0000-4000-8000-000000000001';
const frame = (object) => {
  const data = Buffer.from(JSON.stringify(object));
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
};
function exchange(binary, requests, origin = origins[channel]) {
  const result = spawnSync(binary, [origin], { input: Buffer.concat(requests.map(frame)), timeout: 5000 });
  if (result.error) throw result.error;
  const replies = [];
  for (let offset = 0; offset < result.stdout.length;) {
    const bytes = result.stdout.readUInt32LE(offset); offset += 4;
    assert.ok(bytes > 0 && bytes <= 4096);
    replies.push(JSON.parse(result.stdout.subarray(offset, offset + bytes).toString())); offset += bytes;
  }
  return { status: result.status, stderr: result.stderr.toString(), replies };
}
const version = must(helper, ['--version']);
assert.ok(version.startsWith(`${buildVersion.version} (${buildVersion.build}) ${channel} linux/${arch}`), version);
const wire = exchange(helper, [{ v: 8, id, method: 'describe' }, { v: 4, id, method: 'describe' }, { v: 1, id, method: 'capabilities' }, { v: 3, id, method: 'connectSelected', provider: 'not-a-provider' }]);
assert.equal(wire.status, 0, wire.stderr);
assert.deepEqual(wire.replies[0], { v: 8, id, ok: true, helper: { version: buildVersion.version, build: buildVersion.build, channel, platform: 'linux', arch, protocols: [1, 2, 3, 4, 5, 8], providers: { ivpn: ['read-status', 'connect-selected'], mullvad: ['read-status', 'connect-selected'], nordvpn: ['open-app'], protonvpn: ['open-app'] } } });
assert.deepEqual(wire.replies[1].helper, { version: buildVersion.version, channel, protocols: [1, 2, 3, 4], providers: ['mullvad', 'ivpn', 'nordvpn'], capabilities: ['describe', 'read-status', 'connect-selected', 'open-provider-app'] });
assert.deepEqual(wire.replies[2], { v: 1, id, ok: true, capabilities: ['read-status', 'read-only-prototype'] });
assert.deepEqual(wire.replies[3], { v: 3, ok: false, error: 'invalidRequest' });
// The host refuses before reading stdin, so this sends no input.
const rejected = spawnSync(helper, [other], { input: Buffer.alloc(0), timeout: 5000 });
assert.equal(rejected.status, 64); assert.equal(rejected.stdout.length, 0);
assert.equal(rejected.stderr.toString(), 'Native caller is not enrolled. Read-only local check: --inspect\n');
assert.equal(spawnSync(helper, [origins[channel], 'extra'], { timeout: 5000 }).status, 64, 'unexpected arguments are refused');
const oversized = spawnSync(helper, [origins[channel]], { input: Buffer.from([0x01, 0x10, 0, 0]), timeout: 5000 });
assert.equal(oversized.status, 65); assert.equal(oversized.stderr.toString(), 'Native protocol ended.\n');

// --- Setup in a throwaway home ------------------------------------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), 'network-guard-linux-setup-'));
try {
  const home = path.join(sandbox, 'home'); const runtime = path.join(sandbox, 'run');
  mkdirSync(path.join(home, '.config/google-chrome'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, '.config/BraveSoftware/Brave-Browser'), { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime };
  const setup = (command) => run(path.join(folder, 'anon-network-guard-setup'), [command], { env });
  const host = channel === 'development' ? 'inc.anon.network_helper.dev' : 'inc.anon.network_helper';
  assert.match(setup('check').stdout, /not installed/);
  const install = setup('install');
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /for Google Chrome, Brave\./);
  const manifest = JSON.parse(readFileSync(path.join(home, '.config/google-chrome/NativeMessagingHosts', `${host}.json`), 'utf8'));
  assert.equal(manifest.path, path.join(home, '.local/share/anon/network-guard', channel, 'versions', `${buildVersion.version}-${sha256}`, 'anon-network-helper'));
  assert.deepEqual(manifest.allowed_origins, [origins[channel]]);
  assert.ok(existsSync(path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts', `${host}.json`)));
  assert.ok(!existsSync(path.join(home, '.config/chromium')), 'setup never creates a browser profile');
  assert.equal(exchange(manifest.path, [{ v: 8, id, method: 'describe' }]).replies[0].ok, true, 'the registered helper answers');
  assert.match(setup('check').stdout, new RegExp(`Network Guard ${buildVersion.version.replaceAll('.', '\\.')} is installed for Google Chrome, Brave\\.`));
  const uninstall = setup('uninstall');
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(path.join(home, '.local/share/anon')));
  assert.ok(!existsSync(manifest.path));
  assert.equal(setup('bogus').status, 2);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
console.log(`Staged ${path.relative(root, folder)} (helper sha256 ${sha256}). Wire and setup checks passed.`);

function readme() {
  return `Anon Network Guard ${buildVersion.version} for Linux (${arch})${channel === 'development' ? ' - development channel, test builds of Anon only' : ''}

Network Guard lets the Anon browser extension read your VPN app's connection
status and, if you turn on auto-connect, ask it to connect. It is not a VPN. It
does not route, inspect or block traffic, and it has no network access of its own.

Install for your user (no root, no background service):

  ./anon-network-guard-setup install

This registers Network Guard with the Google Chrome, Chromium, Brave and
Microsoft Edge profiles in your home folder. Open the browser once before
installing. Browsers installed as a Flatpak or Snap cannot start Network Guard.

Then in Anon: Settings > Connection privacy > Allow local access > Verify Network Guard.

Check or remove it:

  ./anon-network-guard-setup check
  ./anon-network-guard-setup uninstall

VPN apps: Mullvad and IVPN (status and connect), NordVPN and Proton VPN (open
the app). Network Guard only uses a VPN app installed by its official package.

Source, checksums and verification: https://github.com/anondotinc/network-guard
Setup guide: https://anon.inc/setup/network-guard
`;
}
