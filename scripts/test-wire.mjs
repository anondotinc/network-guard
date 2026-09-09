#!/usr/bin/env node
// Compiled-host checks invoke only discovery/capabilities or rejected requests.
// No provider probe, status, VPN operation, or registration is performed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersion } from './version.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--channel' || !['development', 'production'].includes(args[1])) {
  throw new Error('Usage: node scripts/test-wire.mjs --channel development|production');
}
const channel = args[1];
const resources = path.join(root, 'dist', channel, 'Anon Network Guard Setup.app/Contents/Resources');
const info = readFileSync(path.join(resources, '../Info.plist'), 'utf8');
assert.ok(info.includes('<key>CFBundleDisplayName</key><string>Anon Network Guard Setup</string>'));
assert.ok(info.includes('<key>CFBundleIconFile</key><string>AnonNetworkGuard.icns</string>'));
assert.ok(info.includes(`<key>CFBundleShortVersionString</key><string>${buildVersion.version}</string>`));
assert.ok(info.includes(`<key>CFBundleVersion</key><string>${buildVersion.build}</string>`));
const icon = readFileSync(path.join(resources, 'AnonNetworkGuard.icns'));
assert.equal(icon.subarray(0, 4).toString(), 'icns');
assert.equal(icon.readUInt32BE(4), icon.length);
assert.equal(readFileSync(path.join(resources, 'BrandAssets-LICENSE'), 'utf8'), readFileSync(path.join(root, 'assets/LICENSE'), 'utf8'));
assert.ok(info.includes(`<key>CFBundleIdentifier</key><string>inc.anon.network-helper.setup${channel === 'development' ? '.dev' : ''}</string>`));
const binary = path.join(resources, 'anon-network-helper');
const payload = JSON.parse(readFileSync(path.join(resources, 'payload.json'), 'utf8'));
assert.equal(payload.version, buildVersion.version);
assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), payload.sha256);
const origins = {
  development: 'chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/',
  production: 'chrome-extension://gnkbgepgknkbhnnbaihklcfkjhbclajk/',
};
const id = '00000000-0000-4000-8000-000000000001';
function frame(object) {
  const data = Buffer.from(JSON.stringify(object));
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
function run(input, origin = origins[channel]) {
  const result = spawnSync(binary, [origin], { input, timeout: 3000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function decode(data) {
  const replies = [];
  for (let offset = 0; offset < data.length;) {
    const bytes = data.readUInt32LE(offset); offset += 4;
    assert.ok(bytes > 0 && bytes <= 4096 && offset + bytes <= data.length);
    replies.push(JSON.parse(data.subarray(offset, offset + bytes).toString())); offset += bytes;
  }
  return replies;
}
const requests = [
  { v: 4, id, method: 'describe' }, { v: 1, id, method: 'capabilities' },
  { v: 2, id, method: 'capabilities' }, { v: 4, id, method: 'status' },
  { v: 3, id, method: 'connectSelected', provider: 'not-a-provider' },
  { v: 4, id, method: 'describe', wallet: 'never accepted' },
  { v: 99, id, method: 'describe' },
];
const response = run(Buffer.concat(requests.map(frame)));
assert.equal(response.status, 0);
const replies = decode(response.stdout);
assert.equal(replies.length, requests.length);
assert.deepEqual(replies[0], { v: 4, id, ok: true, helper: {
  version: buildVersion.version, channel, protocols: [1, 2, 3, 4], providers: ['mullvad', 'ivpn', 'nordvpn'],
  capabilities: ['describe', 'read-status', 'connect-selected', 'open-provider-app'],
} });
assert.deepEqual(replies[1].capabilities, ['read-status', 'read-only-prototype']);
assert.deepEqual(replies[2].capabilities, ['connect-selected', 'development-control-pilot']);
for (const reply of replies.slice(3)) assert.equal(reply.ok, false);
assert.equal(replies[6].error, 'unsupportedVersion');
for (const origin of [origins[channel === 'development' ? 'production' : 'development'],
  'https://example.test/', origins[channel] + 'page', 'chrome-extension://*/']) {
  const rejected = run(frame(requests[0]), origin);
  assert.equal(rejected.status, 64); assert.equal(rejected.stdout.length, 0);
}
for (const invalid of [Buffer.from([1, 16, 0, 0]), Buffer.from([3, 0]), Buffer.from([3, 0, 0, 0, 65])]) {
  const rejected = run(invalid);
  assert.equal(rejected.status, 65); assert.equal(rejected.stdout.length, 0);
}
const bounded = run(Buffer.concat(Array.from({ length: 129 }, () => frame(requests[0]))));
assert.equal(bounded.status, 0); assert.equal(decode(bounded.stdout).length, 128);
console.log(`Compiled ${channel} universal helper: discovery, legacy capabilities, origin isolation, malformed framing, and session cap passed. No provider invoked.`);
