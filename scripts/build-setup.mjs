#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertBuildOutput } from './bundle-layout.mjs';
import { buildIcon } from './build-icon.mjs';
import { buildVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--channel' || !['development', 'production'].includes(args[1])) {
  throw new Error('Usage: node scripts/build-setup.mjs --channel development|production');
}
if (process.platform !== 'darwin') throw new Error('Setup app builds require macOS and the Apple command-line tools.');
const channel = args[1];
const configuration = channel === 'development' ? 'debug' : 'release';
const output = path.join(root, 'dist', channel);
const app = path.join(output, 'Anon Network Guard Setup.app');
const contents = path.join(app, 'Contents');
const macOS = path.join(contents, 'MacOS');
const resources = path.join(contents, 'Resources');
assertBuildOutput(root, app);
if (!existsSync(path.join(root, 'LICENSE'))) throw new Error('The scoped helper LICENSE is required in every setup bundle.');
for (const directory of [macOS, resources]) mkdirSync(directory, { recursive: true });
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env: {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: path.join(root, '.build', 'module-cache'),
    SWIFTPM_MODULECACHE_OVERRIDE: path.join(root, '.build', 'module-cache'),
  } });
  if (result.error || result.status !== 0) throw new Error(`Build step failed: ${command}`);
}
const bins = [];
for (const architecture of ['arm64', 'x86_64']) {
  const scratch = path.join(root, '.build', channel, architecture);
  run('/usr/bin/xcrun', ['swift', 'build', '--package-path', root, '--scratch-path', scratch,
    '--disable-sandbox', '--cache-path', path.join(root, '.build', 'cache'),
    '--config-path', path.join(root, '.build', 'config'), '--security-path', path.join(root, '.build', 'security'),
    '--configuration', configuration, '--arch', architecture]);
  bins.push(path.join(scratch, `${architecture}-apple-macosx`, configuration));
}
for (const [name, destination] of [
  ['anon-network-helper', path.join(resources, 'anon-network-helper')],
  ['AnonNetworkHelperSetup', path.join(macOS, 'AnonNetworkHelperSetup')],
]) {
  run('/usr/bin/xcrun', ['lipo', '-create', ...bins.map(bin => path.join(bin, name)), '-output', destination]);
  chmodSync(destination, 0o755);
  run('/usr/bin/xcrun', ['lipo', destination, '-verify_arch', 'arm64', 'x86_64']);
}
const { version, build } = buildVersion;
const sha256 = createHash('sha256').update(readFileSync(path.join(resources, 'anon-network-helper'))).digest('hex');
writeFileSync(path.join(resources, 'payload.json'), JSON.stringify({ schemaVersion: 1, version, channel, sha256 }, null, 2) + '\n');
const bundleID = `inc.anon.network-helper.setup${channel === 'development' ? '.dev' : ''}`;
writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Anon Network Guard Setup</string>
<key>CFBundleDisplayName</key><string>Anon Network Guard Setup</string>
<key>CFBundleIdentifier</key><string>${bundleID}</string>
<key>CFBundleExecutable</key><string>AnonNetworkHelperSetup</string>
<key>CFBundleIconFile</key><string>AnonNetworkGuard.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
copyFileSync(path.join(root, 'LICENSE'), path.join(resources, 'LICENSE'));
copyFileSync(path.join(root, 'assets/LICENSE'), path.join(resources, 'BrandAssets-LICENSE'));
buildIcon(root, path.join(resources, 'AnonNetworkGuard.icns'));
assertBuildOutput(root, app);
writeFileSync(path.join(output, 'installation-manifest.json'), JSON.stringify({
  schemaVersion: 1, version, build, channel, architectures: ['arm64', 'x86_64'], minimumMacOS: '13.0',
  bundleIdentifier: bundleID, executable: 'AnonNetworkHelperSetup',
  helperSha256: sha256,
  nativeHost: channel === 'development' ? 'inc.anon.network_helper.dev' : 'inc.anon.network_helper',
  extensionOrigin: `chrome-extension://${channel === 'development' ? 'foghepoakbdbpbjknofnhbhpiehpmdac' : 'gnkbgepgknkbhnnbaihklcfkjhbclajk'}/`,
  installRoot: `~/Library/Application Support/Anon/NetworkHelper/${channel}/`,
  registrationRoot: '~/Library/Application Support/Google/Chrome/NativeMessagingHosts/',
  releaseReady: false, reason: 'Local test build; Developer ID signing, notarization and clean-Mac acceptance required.',
}, null, 2) + '\n');
console.log(`Built universal local test app: ${app}`);
console.log('No installation, Chrome registration, VPN operation, signing, or upload was performed.');
