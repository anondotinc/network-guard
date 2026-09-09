import { resolve } from 'node:path';
import { assertCatalog } from './catalog.mjs';
import { artifactKey, copyNew, fileInfo, invariant, jsonBytes, run, safeToken, writeNew } from './lib.mjs';

export function normalizeFingerprint(value) {
  invariant(typeof value === 'string', 'Expected release signing-certificate SHA-256 is required');
  const normalized = value.replaceAll(':', '').toLowerCase();
  invariant(/^[0-9a-f]{64}$/.test(normalized), 'Expected signer must be a SHA-256 certificate fingerprint');
  return normalized;
}
export function inspectApkOutput(badging, verification, expected) {
  const packageInfo = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  invariant(packageInfo, 'aapt did not return package/version metadata');
  invariant(packageInfo[1] === 'com.ahloop.anon', 'APK package is not com.ahloop.anon');
  invariant(!/^package:.*\bsplit='/m.test(badging) && !/^uses-split:/m.test(badging), 'Split APKs cannot be distributed as a standalone wallet APK');
  invariant(packageInfo[2] === expected.buildId && packageInfo[3] === expected.version, 'APK version/build does not match the explicitly selected release');
  invariant(/^\d+$/.test(packageInfo[2]), 'APK versionCode must be numeric');
  invariant(!/^application-debuggable/m.test(badging), 'Debuggable APKs cannot be released');
  const minSdk = badging.match(/^sdkVersion:'(\d+)'/m)?.[1];
  invariant(minSdk && Number(minSdk) >= 1, 'APK minimum SDK is missing');
  const abiLine = badging.match(/^native-code:(.*)$/m)?.[1];
  const abis = abiLine ? [...abiLine.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort() : [];
  const known = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
  invariant(abis.every((abi) => known.includes(abi)) && new Set(abis).size === abis.length, 'APK has unsupported or duplicate native ABIs');
  let architecture;
  if (!abis.length || JSON.stringify(abis) === JSON.stringify([...known].sort())) architecture = 'universal';
  else if (JSON.stringify(abis) === JSON.stringify(['arm64-v8a', 'x86_64'])) architecture = 'arm64-x86_64';
  else if (abis.length === 1 && abis[0] === 'arm64-v8a') architecture = 'arm64';
  else if (abis.length === 1 && abis[0] === 'x86_64') architecture = 'x86_64';
  else throw new Error('APK ABI set is not representable by catalog v1; do not mislabel a partial APK as universal');
  invariant(/^Verifies\s*$/m.test(verification), 'apksigner did not confirm a valid APK signature');
  const fingerprints = [...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)\s*$/gm)].map((match) => match[1].toLowerCase());
  invariant(fingerprints.length === 1 && fingerprints[0] === normalizeFingerprint(expected.signer), 'APK release signer does not match the approved app-signing certificate');
  invariant(!/CN=Android Debug/i.test(verification), 'Android debug certificates cannot be released');
  return { packageName: packageInfo[1], version: packageInfo[3], buildId: packageInfo[2], minimumOs: `Android API ${minSdk}+`, architecture, abis, certificateSha256: fingerprints[0] };
}
export async function importApk({ apk, signer, version, buildId, releasedAt, channel = 'stable', out, aapt = 'aapt2', apksigner = 'apksigner', notes = [] }, execute = run) {
  invariant(apk && out, 'An explicit APK path and output directory are required');
  safeToken(version, 'version'); safeToken(buildId, 'buildId'); normalizeFingerprint(signer);
  const source = resolve(apk);
  const before = await fileInfo(source);
  const badging = execute(aapt, ['dump', 'badging', source]);
  const verification = execute(apksigner, ['verify', '--verbose', '--print-certs', '-Werr', source]);
  const metadata = inspectApkOutput(badging, verification, { version, buildId, signer });
  const after = await fileInfo(source);
  invariant(before.sha256 === after.sha256 && before.bytes === after.bytes, 'APK changed during inspection');
  const filename = `anon-android-${version}-${buildId}-${metadata.architecture}.apk`;
  const artifact = { platform: 'android', architecture: metadata.architecture, minimumOs: metadata.minimumOs, filename, ...after, signing: { kind: 'android', certificateSha256: metadata.certificateSha256, packageName: metadata.packageName }, location: `https://downloads.anon.inc/android/${version}/${buildId}/${filename}` };
  const release = { product: 'android', version, buildId, releasedAt, channel, status: 'unreleased', notes, artifacts: [artifact] };
  assertCatalog({ schemaVersion: 1, releases: [release] });
  const destination = resolve(out, artifactKey(artifact));
  await copyNew(source, destination);
  invariant((await fileInfo(destination)).sha256 === artifact.sha256, 'Imported APK changed during copying');
  await writeNew(resolve(out, `android-${version}-${buildId}.release.json`), jsonBytes(release));
  await writeNew(resolve(out, `android-${version}-${buildId}.inspection.json`), jsonBytes({ schemaVersion: 1, product: 'android', ...metadata, ...after, checks: { signatureVerified: true, expectedReleaseSignerMatched: true, debugRejected: true }, publishable: true }));
  return release;
}
