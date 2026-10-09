import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEV, Dev, canonical, classifyManifest, decodeFrames, encodeFrame, layoutFor, loadState, previousSwiftVersion, writePrivate } from './dev.mjs';

// Temporary homes only; nothing here runs a helper, the app or an installer.
function home(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'anon-dev-test-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, 'home'), { mode: 0o700 });
  return path.join(base, 'home');
}

const manifest = (target, origins = [DEV.origin], name = DEV.hostName) =>
  ({ name, description: 'Anon Network Guard', path: target, type: 'stdio', allowed_origins: origins });

test('every development path derives from the given home and applications folder', t => {
  const root = home(t);
  const layout = layoutFor({ home: root });
  for (const value of Object.values(layout)) assert.ok(value.startsWith(root), value);
  assert.equal(layout.manifest, path.join(root, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/inc.anon.network_helper.dev.json'));
  assert.equal(layout.helperRoot, path.join(root, 'Library/Application Support/Anon/NetworkHelper/development'));
  assert.equal(layout.app, path.join(root, 'Applications/Anon Network Guard Dev.app'));
  assert.equal(layoutFor({ home: root, applications: '/Elsewhere' }).app, '/Elsewhere/Anon Network Guard Dev.app');
});

test('the host registration is classified by where it points and whom it admits', t => {
  const layout = layoutFor({ home: home(t) });
  const helper = path.join(layout.helperRoot, 'versions/0.1.4-abc/anon-network-helper');
  const shim = path.join(layout.app, 'Contents/MacOS/anon-guard-host');
  assert.deepEqual(classifyManifest(null, layout), { kind: 'none' });
  assert.deepEqual(classifyManifest(manifest(helper), layout), { kind: 'swift', path: helper, version: '0.1.4-abc' });
  assert.equal(classifyManifest(manifest(shim), layout).kind, 'device');
  assert.equal(classifyManifest(manifest('/opt/other/helper'), layout).kind, 'foreign');
  assert.equal(classifyManifest(manifest(helper, [DEV.origin, 'chrome-extension://gnkbgepgknkbhnnbaihklcfkjhbclajk/']), layout).kind, 'foreign');
  assert.equal(classifyManifest(manifest(helper, [DEV.origin], 'inc.anon.network_helper'), layout).kind, 'foreign');
  assert.equal(classifyManifest(manifest(path.join(layout.helperRoot, 'versions/../../escape')), layout).kind, 'foreign');
  // Swift writes /tmp/… for /private/tmp/…; both name the same file.
  if (layout.home.startsWith('/private/')) {
    assert.equal(classifyManifest(manifest(helper.replace(/^\/private/, '')), layout).kind, 'swift');
  }
  assert.equal(canonical(path.join(layout.home, 'missing/a/b')), path.join(layout.home, 'missing/a/b'));
});

test('rollback walks back through activations, then receipt order', () => {
  assert.equal(previousSwiftVersion(['a', 'b', 'c'], ['a', 'b', 'c'], 'c'), 'b');
  assert.equal(previousSwiftVersion(['a', 'c', 'b'], ['a', 'b', 'c'], 'b'), 'c');
  assert.equal(previousSwiftVersion(['a', 'gone', 'c'], ['a', 'c'], 'c'), 'a');
  assert.equal(previousSwiftVersion([], ['a', 'b'], 'b'), 'a');
  assert.equal(previousSwiftVersion(['a'], ['a', 'b'], 'a'), null);
  assert.equal(previousSwiftVersion([], ['a'], 'a'), null);
});

test('frames are Chrome native messaging frames', () => {
  const frames = Buffer.concat([encodeFrame({ v: 8 }), encodeFrame({ v: 9, id: 'x' })]);
  assert.equal(frames.readUInt32LE(0), 7);
  assert.deepEqual(decodeFrames(frames), [{ v: 8 }, { v: 9, id: 'x' }]);
  assert.throws(() => decodeFrames(frames.subarray(0, frames.length - 1)), /Truncated/);
});

test('private files are owner-only and replaced atomically', t => {
  const file = path.join(home(t), 'a/b/state.json');
  writePrivate(file, 'one');
  writePrivate(file, 'two');
  assert.equal(readFileSync(file, 'utf8'), 'two');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('leaving the device variant restores the saved Swift registration, or removes ours', t => {
  const root = home(t);
  const dev = new Dev({ home: root, log: () => {} });
  assert.equal(dev.realHome, false, 'a temporary home never gets login items');
  const { layout } = dev;
  const helper = path.join(layout.helperRoot, 'versions/0.1.4-abc/anon-network-helper');
  mkdirSync(path.dirname(helper), { recursive: true });
  writeFileSync(helper, 'synthetic, never executed');
  const swift = JSON.stringify(manifest(helper), null, 2) + '\n';
  const device = JSON.stringify(manifest(path.join(layout.app, 'Contents/MacOS/anon-guard-host')));
  writePrivate(path.join(layout.dev, 'backups/manifests/1.json'), swift);
  writePrivate(layout.manifest, device);
  writePrivate(layout.bridge, '{"schemaVersion":1,"helper":"0.1.4-abc"}');
  dev.state.swiftManifestBackup = 'backups/manifests/1.json';
  dev.leaveDevice();
  assert.equal(readFileSync(layout.manifest, 'utf8'), swift);
  assert.ok(!existsSync(layout.bridge));
  assert.equal(loadState(layout).variant, 'swift');

  // A backup whose helper is gone is not restored; only our own manifest is removed.
  rmSync(helper);
  writePrivate(layout.manifest, device);
  dev.leaveDevice();
  assert.ok(!existsSync(layout.manifest));
  assert.equal(loadState(layout).variant, null);

  // A foreign registration is never touched.
  const foreign = JSON.stringify(manifest('/opt/other/helper'));
  writePrivate(layout.manifest, foreign);
  dev.leaveDevice();
  assert.equal(readFileSync(layout.manifest, 'utf8'), foreign);
});
