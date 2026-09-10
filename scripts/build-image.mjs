#!/usr/bin/env node
// Engineering DMG only. Public packaging/signing stays in release/cli.mjs.
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertBuildOutput } from './bundle-layout.mjs';
import { buildVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--channel' || !['development', 'production'].includes(args[1]))
  throw new Error('Usage: node scripts/build-image.mjs --channel development|production');
if (process.platform !== 'darwin') throw new Error('Test disk images require macOS.');
const channel = args[1];
const { version, build } = buildVersion;
const appName = 'Anon Network Guard Setup.app';
const app = path.join(root, 'dist', channel, appName);
assertBuildOutput(root, app);
const payload = JSON.parse(readFileSync(path.join(app, 'Contents/Resources/payload.json'), 'utf8'));
const helper = readFileSync(path.join(app, 'Contents/Resources/anon-network-helper'));
if (payload.version !== version || payload.channel !== channel ||
    payload.sha256 !== createHash('sha256').update(helper).digest('hex'))
  throw new Error('Rebuild the matching setup app before packaging a disk image.');
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`Test image step failed: ${command}. ${result.stderr?.slice(0, 1000) ?? ''}`);
  return result.stdout.trim();
}
const plist = path.join(app, 'Contents/Info.plist');
for (const [key, expected] of [
  ['CFBundleShortVersionString', version], ['CFBundleVersion', String(build)],
  ['CFBundleIdentifier', `inc.anon.network-helper.setup${channel === 'development' ? '.dev' : ''}`],
]) {
  if (run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]) !== expected)
    throw new Error(`Setup ${key} does not match this candidate.`);
}
for (const executable of [path.join(app, 'Contents/MacOS/AnonNetworkHelperSetup'), path.join(app, 'Contents/Resources/anon-network-helper')])
  run('/usr/bin/lipo', [executable, '-verify_arch', 'arm64', 'x86_64']);
const filename = `anon-network-guard-${version}-${build}-${channel}-universal-UNSIGNED-TEST.dmg`;
const output = path.join(root, 'dist', channel, filename);
if (existsSync(output) || existsSync(output + '.json') || existsSync(output + '.SHA256SUMS'))
  throw new Error('This candidate already exists. Bump the build; test images are not overwritten.');
const scratchRoot = path.join(root, '.build');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, 'disk-image-'));
const imageRoot = path.join(scratch, 'image');
mkdirSync(imageRoot);
cpSync(app, path.join(imageRoot, appName), { recursive: true, force: false, errorOnExist: true });
writeFileSync(path.join(imageRoot, 'READ ME.txt'), `Anon Network Guard ${version} (build ${build})\n${channel.toUpperCase()} EXTENSION ONLY\n\nUnsigned engineering test build. Not notarized. Not a public installer.\nOpen the setup app and choose Install / Repair for this macOS user.\nThen return to Anon and verify Network Guard again. Auto-connect is a separate choice.\nInstallation does not connect a VPN, grant Chrome permission, or access your wallet.\nNo traffic blocking or browser routing verification is provided.\n\nSetup: https://anon.inc/setup/vpn\nSource: https://github.com/anondotinc/network-guard\n`);
const stagedImage = path.join(scratch, filename);
run('/usr/bin/hdiutil', ['create', '-format', 'UDZO', '-volname', `Anon Guard ${version} ${channel === 'development' ? 'DEV' : 'TEST'}`, '-srcfolder', imageRoot, stagedImage]);
run('/usr/bin/hdiutil', ['verify', stagedImage]);
copyFileSync(stagedImage, output, constants.COPYFILE_EXCL);
const bytes = readFileSync(output);
const sha256 = createHash('sha256').update(bytes).digest('hex');
writeFileSync(output + '.json', JSON.stringify({ schemaVersion: 1, version, build, channel, filename,
  byteSize: bytes.length, sha256, publishable: false, reason: 'Unsigned test disk image; not a release catalog artifact.' }, null, 2) + '\n', { flag: 'wx' });
writeFileSync(output + '.SHA256SUMS', `${sha256}  ${filename}\n`, { flag: 'wx' });
console.log(JSON.stringify({ image: output, version, build, channel, sha256, publishable: false }));
console.log('No mounting, installation, registration, VPN operation, signing, or publication performed.');
