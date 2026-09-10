import { cp, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCatalog, helperArtifactUrl } from './catalog.mjs';
import { artifactKey, copyNew, fileInfo, invariant, jsonBytes, run, safeToken, writeNew } from './lib.mjs';

export function inspectAppleSignature(output, expectedTeam, expectedIdentity) {
  invariant(/^[A-Z0-9]{10}$/.test(expectedTeam ?? ''), 'Expected Apple team ID is required');
  invariant(expectedIdentity?.startsWith('Developer ID Application: ') && expectedIdentity.endsWith(`(${expectedTeam})`), 'A matching Developer ID Application identity is required');
  const team = output.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const identity = output.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
  invariant(team === expectedTeam && identity === expectedIdentity, 'Apple signing identity does not match the approved team');
  invariant(/^Timestamp=/m.test(output) && /flags=.*runtime/m.test(output), 'Timestamped hardened-runtime signing is required');
  return { kind: 'apple-developer-id', teamId: team, identity };
}
export function verifyUniversalAppleSignatures({ app, helper, teamId, identity }, execute = run) {
  let signing;
  for (const target of [app, helper]) {
    // Be explicit even though current codesign defaults verification to all slices.
    // Resources/ helpers also receive their own strict verification; --deep is not
    // relied on to discover arbitrary executable resources as nested code.
    execute('/usr/bin/codesign', ['--verify', '--all-architectures', ...(target === app ? ['--deep'] : []), '--strict', '--verbose=2', target]);
    for (const architecture of ['arm64', 'x86_64']) {
      // Display defaults to the host architecture, unlike verification. Inspect
      // each slice's approved identity, timestamp and hardened runtime explicitly.
      signing = inspectAppleSignature(execute('/usr/bin/codesign', ['--display', '--architecture', architecture, '--verbose=4', target]), teamId, identity);
    }
  }
  return signing;
}
async function checkAppTree(path) {
  const root = await realpath(path);
  invariant(root === resolve(path) && root.endsWith('.app'), 'App must be a real .app directory, not a symbolic link');
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      invariant(!entry.isSymbolicLink(), 'Setup app must not contain symbolic links');
      const item = join(dir, entry.name);
      if (entry.isDirectory()) await visit(item);
      else invariant((await lstat(item)).isFile(), 'Unexpected special file in setup app');
    }
  }
  await visit(root);
  return root;
}
function inspectArchitectures(execute, path) {
  const archs = execute('/usr/bin/lipo', ['-archs', path]).trim().split(/\s+/).sort();
  invariant(JSON.stringify(archs) === JSON.stringify(['arm64', 'x86_64']), 'Setup app and helper must both be universal arm64 + x86_64');
}
export async function packageHelper({ app, version, buildId, releasedAt, out, channel = 'test', identity, teamId, notaryProfile, executeSigning = false, notes = [] }, execute = run) {
  safeToken(version, 'version'); safeToken(buildId, 'buildId');
  invariant(process.platform === 'darwin' || execute !== run, 'App packaging requires macOS');
  invariant(app && out, 'An explicit app path and output directory are required');
  if (executeSigning) invariant(identity && teamId && notaryProfile, 'Signing requires identity, team ID, and an existing notarytool keychain profile');
  else invariant(!identity && !teamId && !notaryProfile && channel === 'test', 'Unsigned packaging is test-only; signing requires --execute-signing');
  if (executeSigning) assertCatalog({ schemaVersion: 1, releases: [{ product: 'network-helper', version, buildId, releasedAt, channel, status: 'unreleased', notes, artifacts: [] }] });
  const source = await checkAppTree(app);
  const originalPayload = JSON.parse(await readFile(join(source, 'Contents/Resources/payload.json'), 'utf8'));
  invariant(originalPayload.schemaVersion === 1 && originalPayload.version === version && originalPayload.channel === 'production', 'Package the production-channel app with a matching version; development enrollment is not distributable');
  const expectedBundle = 'inc.anon.network-helper.setup';
  const bundleId = execute('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(source, 'Contents/Info.plist')]).trim();
  const minimum = execute('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', join(source, 'Contents/Info.plist')]).trim();
  const appVersion = execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(source, 'Contents/Info.plist')]).trim();
  const appBuild = execute('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', join(source, 'Contents/Info.plist')]).trim();
  invariant(bundleId === expectedBundle && /^13(?:\.0){0,2}$/.test(minimum) && appVersion === version, 'Unexpected setup bundle identity, version, or minimum macOS version');
  invariant(appBuild === buildId, 'Release build ID must match the setup app CFBundleVersion; rebuild the app instead of relabeling it');
  const staging = await mkdtemp(join(tmpdir(), 'anon-helper-package-'));
  const stagedApp = join(staging, basename(source));
  await cp(source, stagedApp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const helper = join(stagedApp, 'Contents/Resources/anon-network-helper');
  const executable = join(stagedApp, 'Contents/MacOS/AnonNetworkHelperSetup');
  inspectArchitectures(execute, helper); inspectArchitectures(execute, executable);
  invariant((await fileInfo(helper)).sha256 === originalPayload.sha256, 'Embedded helper does not match the installation manifest');
  let signing;
  if (executeSigning) {
    invariant(identity.startsWith('Developer ID Application: ') && identity.endsWith(`(${teamId})`), 'Expected Developer ID Application identity and team must match');
    execute('/usr/bin/codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, helper]);
    // Codesigning changes the embedded helper; bind the installer manifest to final bytes.
    await writeFile(join(stagedApp, 'Contents/Resources/payload.json'), jsonBytes({ ...originalPayload, sha256: (await fileInfo(helper)).sha256 }));
    execute('/usr/bin/codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, stagedApp]);
    signing = verifyUniversalAppleSignatures({ app: stagedApp, helper, teamId, identity }, execute);
    const submission = join(staging, 'notary-submission.zip');
    execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, submission]);
    // Explicit operator command only. Keychain credentials never appear in arguments or logs.
    const response = execute('/usr/bin/xcrun', ['notarytool', 'submit', submission, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], { timeout: 20 * 60_000 });
    let status; try { status = JSON.parse(response).status; } catch { throw new Error('Notary response was not valid JSON'); }
    invariant(status === 'Accepted', 'Apple notarization was not accepted');
    execute('/usr/bin/xcrun', ['stapler', 'staple', stagedApp]);
    execute('/usr/bin/xcrun', ['stapler', 'validate', stagedApp]);
    execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', stagedApp]);
    signing = { ...verifyUniversalAppleSignatures({ app: stagedApp, helper, teamId, identity }, execute), notarized: true };
  }
  const filename = `anon-network-guard-${version}-${buildId}-universal${executeSigning ? '' : '-UNSIGNED-TEST'}.zip`;
  const zip = join(staging, filename);
  execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, zip]);
  // Hash only the final, notarized/stapled package. Never publish the submission archive.
  const info = await fileInfo(zip);
  if (!executeSigning) {
    await copyNew(zip, resolve(out, filename));
    const record = { schemaVersion: 1, product: 'network-helper', version, buildId, channel: 'test', publishable: false, reason: 'Unsigned local test package. Not notarized; not a public download.', filename, ...info, architecture: 'universal', minimumOs: 'macOS 13+', buildChannel: 'production' };
    await writeNew(resolve(out, `${filename}.json`), jsonBytes(record));
    await writeNew(resolve(out, `${filename}.SHA256SUMS`), `${info.sha256}  ${filename}\n`);
    return record;
  }
  const artifact = { platform: 'macos', architecture: 'universal', minimumOs: 'macOS 13+', filename, ...info, signing, location: helperArtifactUrl({ version, buildId }, filename) };
  const release = { product: 'network-helper', version, buildId, releasedAt, channel, status: 'unreleased', notes, artifacts: [artifact] };
  assertCatalog({ schemaVersion: 1, releases: [release] });
  await copyNew(zip, resolve(out, artifactKey(artifact, release)));
  await writeNew(resolve(out, `network-helper-${version}-${buildId}.release.json`), jsonBytes(release));
  return release;
}
