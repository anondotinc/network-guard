#!/usr/bin/env node
// Builds the Device Guard app bundle (device/) for this Mac's architecture:
//   dist/device/<channel>/<App name>.app
// Signed inside out (the nested host shim with its own identifier, then the
// bundle; never --deep), ad hoc unless SIGN_IDENTITY names a "Developer ID
// Application: …" identity. Nothing is installed, registered or started.
//
//   node scripts/build-device.mjs --channel development|production [--out <dir>]
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildIcon } from './build-icon.mjs';
import { agentPlist, assertBundleLayout, identity, infoPlist } from './device-bundle.mjs';
import { buildVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (result.error || result.status !== 0) throw new Error(`Build step failed: ${command} ${args.join(' ')}`);
  return result;
}

export function buildDevice({ channel, out = path.join(root, 'dist', 'device', channel), signIdentity = process.env.SIGN_IDENTITY }) {
  if (process.platform !== 'darwin') throw new Error('The Device Guard bundle is built on macOS.');
  const id = identity(channel);
  const manifest = path.join(root, 'device', 'Cargo.toml');
  const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, 'device', 'target');
  run('cargo', ['build', '--release', '--locked', '--manifest-path', manifest, '--target-dir', targetDir,
    ...(channel === 'development' ? ['--features', 'development'] : [])]);
  const binaries = path.join(targetDir, 'release');

  const bundle = path.join(out, id.bundleName);
  assertBundleLayout(bundle, id);
  rmSync(bundle, { recursive: true, force: true });
  const contents = path.join(bundle, 'Contents');
  for (const dir of ['MacOS', 'Resources', 'Library/LaunchAgents']) mkdirSync(path.join(contents, dir), { recursive: true });
  writeFileSync(path.join(contents, 'Info.plist'), infoPlist(id, buildVersion));
  writeFileSync(path.join(contents, 'Library/LaunchAgents', id.agentPlist), agentPlist(id));
  for (const name of ['anon-guard', 'anon-guard-host']) {
    copyFileSync(path.join(binaries, name), path.join(contents, 'MacOS', name));
    chmodSync(path.join(contents, 'MacOS', name), 0o755);
  }
  copyFileSync(path.join(root, 'LICENSE'), path.join(contents, 'Resources/LICENSE'));
  copyFileSync(path.join(root, 'assets/LICENSE'), path.join(contents, 'Resources/BrandAssets-LICENSE'));
  buildIcon(root, path.join(contents, 'Resources/AnonNetworkGuard.icns'));

  const identityArgs = signIdentity ? ['--timestamp', '--sign', signIdentity] : ['--sign', '-'];
  const sign = (...args) => run('/usr/bin/codesign', ['--force', '--options', 'runtime', ...identityArgs, ...args]);
  sign('--identifier', id.shimIdentifier, path.join(contents, 'MacOS/anon-guard-host'));
  sign(bundle);
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle]);
  assertBundleLayout(bundle, id);
  return { bundle, id, version: buildVersion.version, build: buildVersion.build, signedAdHoc: !signIdentity };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const channel = value('--channel');
  if (!['development', 'production'].includes(channel)) {
    console.error('Usage: node scripts/build-device.mjs --channel development|production [--out <dir>]');
    process.exit(64);
  }
  const result = buildDevice({ channel, out: value('--out') ? path.resolve(value('--out')) : undefined });
  console.log(`Built ${result.id.appName} ${result.version} (${result.build}), ${result.signedAdHoc ? 'signed ad hoc' : 'signed'}: ${result.bundle}`);
  console.log('Nothing was installed, registered or started.');
}
