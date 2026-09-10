import { generateKeyPairSync } from 'node:crypto';
import { jsonBytes, sha256, signCatalog } from '../lib.mjs';

export const TEST_SIGNER = 'a'.repeat(64);
export const testArtifact = Buffer.from('NOT AN APK: synthetic release integrity fixture\n');
export function fixtureCatalog() {
  return { schemaVersion: 1, releases: [{ product: 'android', version: '0.0.0-test', buildId: '1', releasedAt: '2026-01-01T00:00:00Z', channel: 'test', status: 'published', notes: ['TEST ONLY. This is not a real release or download.'], artifacts: [{ platform: 'android', architecture: 'universal', minimumOs: 'Android API 28+', filename: 'anon-android-0.0.0-test-1-universal.apk', bytes: testArtifact.length, sha256: sha256(testArtifact), signing: { kind: 'android', certificateSha256: TEST_SIGNER, packageName: 'com.ahloop.anon' }, location: 'https://downloads.anon.inc/android/0.0.0-test/1/anon-android-0.0.0-test-1-universal.apk' }] }] };
}
export function signedFixture(catalog = fixtureCatalog()) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const bytes = jsonBytes(catalog);
  return { catalog, bytes, signatureBytes: signCatalog(bytes, privateKey), publicKey, privateKey };
}
export const badging = "package: name='com.ahloop.anon' versionCode='1' versionName='0.0.0-test' platformBuildVersionName='36'\nsdkVersion:'28'\nnative-code: 'arm64-v8a' 'armeabi-v7a' 'x86' 'x86_64'\n";
export const verification = `Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate DN: CN=Fixture Only\nSigner #1 certificate SHA-256 digest: ${TEST_SIGNER}\n`;
