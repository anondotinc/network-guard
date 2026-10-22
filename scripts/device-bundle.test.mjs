import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentPlist, assertBundleLayout, channels, identity, infoPlist, layout, minimumSystemVersion, missingRustTargets, rustTargets } from './device-bundle.mjs';

const rustIdentity = readFileSync(new URL('../device/src/identity.rs', import.meta.url), 'utf8');
const rustBuildInfo = readFileSync(new URL('../rust/src/build_info.rs', import.meta.url), 'utf8');

test('channels never share an identity, and match the Rust app and helper', () => {
  const dev = identity('development');
  const prod = identity('production');
  for (const key of ['bundleId', 'appName', 'agentLabel', 'hostName', 'extensionId', 'bundleName', 'agentPlist', 'shimIdentifier'])
    assert.notEqual(dev[key], prod[key], key);
  for (const id of [dev, prod]) {
    for (const value of [id.bundleId, id.appName, id.agentLabel, id.agentPlist]) assert.ok(rustIdentity.includes(`"${value}"`), value);
    assert.ok(rustBuildInfo.includes(`"${id.hostName}"`), id.hostName);
    assert.ok(rustBuildInfo.includes(`"${id.extensionId}"`), id.extensionId);
    assert.equal(id.origin, `chrome-extension://${id.extensionId}/`);
  }
  assert.throws(() => identity('staging'));
  assert.deepEqual(Object.keys(channels).sort(), ['development', 'production']);
});

test('plists name this channel only and run the bundled app', () => {
  const id = identity('development');
  const info = infoPlist(id, { version: '0.1.4', build: 7 });
  assert.match(info, /<key>CFBundleIdentifier<\/key><string>inc\.anon\.network-guard\.dev<\/string>/);
  assert.match(info, /<key>CFBundleExecutable<\/key><string>anon-guard<\/string>/);
  assert.match(info, /<key>LSUIElement<\/key><true\/>/);
  assert.match(info, /<key>CFBundleShortVersionString<\/key><string>0\.1\.4<\/string>/);
  const agent = agentPlist(id);
  assert.match(agent, /<key>Label<\/key><string>inc\.anon\.network-guard\.dev\.agent<\/string>/);
  assert.match(agent, /<key>BundleProgram<\/key><string>Contents\/MacOS\/anon-guard<\/string>/);
  assert.match(agent, /<key>SuccessfulExit<\/key><false\/>/);
  assert.doesNotMatch(agent + info, /network-guard\.agent<|network_helper</);
  assert.match(infoPlist({ ...id, appName: 'A & <B>' }, { version: '1.0.0', build: 1 }), /A &amp; &lt;B&gt;/);
});

test('rebuilding never adopts or deletes unrecognized bundle contents', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'device-bundle-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const id = identity('development');
  const bundle = path.join(base, id.bundleName);
  assert.doesNotThrow(() => assertBundleLayout(bundle, id));
  for (const file of layout(id).files) {
    mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
    writeFileSync(path.join(bundle, file), 'synthetic');
  }
  assert.doesNotThrow(() => assertBundleLayout(bundle, id));
  writeFileSync(path.join(bundle, 'Contents/MacOS/notes.txt'), 'user file');
  assert.throws(() => assertBundleLayout(bundle, id), /Unrecognized entry .*notes\.txt/);
  rmSync(path.join(bundle, 'Contents/MacOS/notes.txt'));
  rmSync(path.join(bundle, 'Contents/Resources/LICENSE'));
  symlinkSync('/etc/hosts', path.join(bundle, 'Contents/Resources/LICENSE'));
  assert.throws(() => assertBundleLayout(bundle, id), /Unrecognized entry/);
});

test('stapling may add Contents/CodeResources, and nothing else unknown', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'device-bundle-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const id = identity('production');
  const bundle = path.join(base, id.bundleName);
  for (const file of layout(id).files) {
    if (file === 'Contents/CodeResources') continue;
    mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
    writeFileSync(path.join(bundle, file), 'synthetic');
  }
  assert.doesNotThrow(() => assertBundleLayout(bundle, id));
  writeFileSync(path.join(bundle, 'Contents/CodeResources'), 'synthetic ticket');
  assert.doesNotThrow(() => assertBundleLayout(bundle, id));
  // The ticket is a file in Contents only: not a directory, a symlink or at any other path.
  rmSync(path.join(bundle, 'Contents/CodeResources'));
  mkdirSync(path.join(bundle, 'Contents/CodeResources'));
  assert.throws(() => assertBundleLayout(bundle, id), /Unrecognized entry .*Contents\/CodeResources/);
  rmSync(path.join(bundle, 'Contents/CodeResources'), { recursive: true });
  symlinkSync('/etc/hosts', path.join(bundle, 'Contents/CodeResources'));
  assert.throws(() => assertBundleLayout(bundle, id), /Unrecognized entry .*Contents\/CodeResources/);
  rmSync(path.join(bundle, 'Contents/CodeResources'));
  for (const elsewhere of ['CodeResources', 'Contents/MacOS/CodeResources', 'Contents/Resources/CodeResources']) {
    writeFileSync(path.join(bundle, elsewhere), 'synthetic ticket');
    assert.throws(() => assertBundleLayout(bundle, id), /Unrecognized entry/, elsewhere);
    rmSync(path.join(bundle, elsewhere));
  }
  assert.doesNotThrow(() => assertBundleLayout(bundle, id));
});

test('the universal build names both macOS targets and a macOS 13 floor', () => {
  assert.deepEqual(rustTargets, ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
  assert.equal(minimumSystemVersion, '13.0');
  assert.match(infoPlist(identity('production'), { version: '1.0.0', build: 1 }), /<key>LSMinimumSystemVersion<\/key><string>13\.0<\/string>/);
  assert.deepEqual(missingRustTargets('aarch64-apple-darwin\nx86_64-apple-darwin\nwasm32-unknown-unknown\n'), []);
  assert.deepEqual(missingRustTargets('aarch64-apple-darwin\nwasm32-unknown-unknown\n'), ['x86_64-apple-darwin']);
  assert.deepEqual(missingRustTargets('x86_64-apple-darwin\n'), ['aarch64-apple-darwin']);
  assert.deepEqual(missingRustTargets(''), rustTargets);
  assert.deepEqual(missingRustTargets('x86_64-apple-darwin-extra\n'), rustTargets);
});
