import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEV, Dev, canonical, classifyManifest, decodeFrames, encodeFrame, layoutFor, loadState, previousSwiftVersion, writePrivate } from './dev.mjs';
import { infoPlist } from './device-bundle.mjs';

// Temporary homes only; nothing here runs a helper, the app or an installer.
// Their stand-ins are stubs, or a two-line shell script for the shim's
// --print-host-manifest.
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

/** A synthetic app bundle (never executed) whose two binaries hold `text`. */
function syntheticApp(root, name, text) {
  const app = path.join(path.dirname(root), 'builds', name, DEV.bundleName);
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents/Info.plist'), infoPlist(DEV, { version: '0.0.0', build: '1' }));
  for (const binary of ['anon-guard', 'anon-guard-host']) writeFileSync(path.join(app, 'Contents/MacOS', binary), text);
  return app;
}

test('reinstalls keep one backup per distinct build', { skip: process.platform !== 'darwin' && 'ditto and plutil are macOS tools' }, t => {
  const root = home(t);
  const dev = new Dev({ home: root, log: () => {} });
  dev.quitApp = () => {}; // nothing here runs the app
  const A = 'synthetic build A';
  const B = 'synthetic build B';
  const [a, b, rebuiltB] = [syntheticApp(root, 'a', A), syntheticApp(root, 'b', B), syntheticApp(root, 'b2', B)];
  const binary = (app) => readFileSync(path.join(app, 'Contents/MacOS/anon-guard'), 'utf8');
  const backups = () => loadState(dev.layout).appBackups.map((entry) => binary(path.join(dev.layout.dev, entry, DEV.bundleName)));

  dev.replaceApp(a);
  dev.replaceApp(b);
  assert.deepEqual(backups(), [A]);
  // Toggling to the Swift variant and back reinstalls the same build: nothing new to keep.
  dev.replaceApp(rebuiltB);
  dev.replaceApp(rebuiltB);
  assert.deepEqual(backups(), [A]);
  assert.equal(binary(dev.layout.app), B);
  // A build saved earlier moves to the end instead of being saved twice.
  dev.replaceApp(a);
  dev.replaceApp(b);
  assert.deepEqual(backups(), [B, A]);
  assert.equal(binary(dev.layout.app), B);
  assert.deepEqual(readdirSync(path.join(dev.layout.dev, 'backups/apps')).length, 2);
});

test('leaving the device variant turns off a login item whoever turned it on', t => {
  const dev = new Dev({ home: home(t), log: () => {} });
  dev.quitApp = () => {};
  for (const [startAtLogin, unregisters] of [['enabled', true], ['requiresApproval', true], ['off', false], ['unknown', false], [null, false]]) {
    const actions = [];
    // Stands in for the app's `login-item` command (the real one answers only in the account's real home).
    dev.loginItem = (action) => {
      actions.push(action);
      return action === 'status' ? (startAtLogin && { startAtLogin }) : { startAtLogin: 'off' };
    };
    // Turned on from the tray menu, or registered before `--no-login-item`: dev.mjs never recorded it.
    dev.state.loginItem = false;
    dev.leaveDevice();
    assert.equal(actions.includes('unregister'), unregisters, String(startAtLogin));
    assert.equal(dev.state.loginItem, false);
  }
});

const SHA = 'a'.repeat(64);

/** A development helper installation as its installer lays it out, registered for Chrome. The helper is never executed. */
function swiftInstall(layout, versions = ['0.1.4']) {
  const receipt = {
    schemaVersion: 1, owner: 'inc.anon.network-helper.setup.v1', channel: 'development',
    versions: versions.map((version) => ({ schemaVersion: 1, version, channel: 'development', sha256: SHA })),
  };
  writePrivate(path.join(layout.helperRoot, 'installation.json'), JSON.stringify(receipt));
  const helper = path.join(layout.helperRoot, 'versions', `${versions.at(-1)}-${SHA}`, 'anon-network-helper');
  mkdirSync(path.dirname(helper), { recursive: true });
  writeFileSync(helper, 'synthetic, never executed');
  const registration = JSON.stringify(manifest(helper), null, 2) + '\n';
  writePrivate(layout.manifest, registration);
  return registration;
}

/** A synthetic app whose shim only prints its host manifest. */
function deviceAppWithShim(root, layout) {
  const app = syntheticApp(root, 'with-shim', 'synthetic build');
  const shim = path.join(app, 'Contents/MacOS/anon-guard-host');
  const printed = JSON.stringify(manifest(path.join(layout.app, 'Contents/MacOS/anon-guard-host')));
  writeFileSync(shim, `#!/bin/sh\n[ "$1" = --print-host-manifest ] && printf '%s\\n' '${printed}'\n`);
  chmodSync(shim, 0o755);
  return app;
}

const macOnly = { skip: process.platform !== 'darwin' && 'ditto and plutil are macOS tools' };

test('a device install that cannot start the app gives the host back to the Swift helper', macOnly, t => {
  const root = home(t);
  const dev = new Dev({ home: root, log: () => {} });
  dev.quitApp = () => {};
  const swift = swiftInstall(dev.layout);
  // Stands in for the shim: the app could not be started (for example, macOS blocked it).
  dev.shimSession = (requests) => requests.map(({ v, id }) => ({ v, id, ok: false, error: 'appStartFailed' }));
  assert.throws(() => dev.installDevice({ from: deviceAppWithShim(root, dev.layout) }),
    /^Error: openApp: appStartFailed\. The development host is back on the Swift helper\.$/);
  assert.equal(readFileSync(dev.layout.manifest, 'utf8'), swift);
  assert.ok(!existsSync(dev.layout.bridge));
  assert.equal(loadState(dev.layout).variant, 'swift');
});

test('a login item that cannot be registered is reported, and the install goes on', macOnly, t => {
  const root = home(t);
  const logs = [];
  const dev = new Dev({ home: root, log: (line) => logs.push(line) });
  dev.quitApp = () => {};
  swiftInstall(dev.layout);
  // Only these stubs stand in for the app's login-item command; nothing is registered.
  dev.realHome = true;
  dev.loginItem = (action) => ({ action, startAtLogin: 'off', ...(action === 'register' ? { error: 'Operation not permitted' } : {}) });
  dev.shimSession = (requests) => requests.map(({ v, id, method }) => (method === 'describe'
    ? { v, id, ok: true, helper: { channel: 'development', version: '0.1.4' } }
    : { v, id, ok: true, app: { running: true, version: '0.0.0', startAtLogin: 'off' }, shim: { version: '0.0.0' } }));
  const result = dev.installDevice({ from: deviceAppWithShim(root, dev.layout) });
  assert.equal(result.loginItemError, 'Operation not permitted');
  assert.ok(logs.some((line) => line.includes('Start at login is not on: Operation not permitted')), logs.join('\n'));
  assert.equal(dev.variant().kind, 'device');
});

test('installing the Swift helper records whether dev.mjs created the installation', t => {
  for (const preexisting of [false, true]) {
    const root = home(t);
    const dev = new Dev({ home: root, log: () => {} });
    if (preexisting) swiftInstall(dev.layout, ['0.1.0']);
    const setupApp = path.join(path.dirname(root), 'Setup.app');
    writePrivate(path.join(setupApp, 'Contents/Resources/payload.json'), JSON.stringify({ channel: 'development', version: '0.1.4' }));
    dev.setupApp = () => setupApp;
    dev.setup = () => {
      swiftInstall(dev.layout, preexisting ? ['0.1.0', '0.1.4'] : ['0.1.4']);
      return { ok: true, active: { directory: `0.1.4-${SHA}` } };
    };
    dev.describeSwift = () => ({ path: 'synthetic', version: `0.1.4-${SHA}`, describe: { version: '0.1.4', build: 7, channel: 'development' } });
    dev.installSwift();
    assert.equal(loadState(dev.layout).swiftCreated, !preexisting, `preexisting: ${preexisting}`);
  }
});

test('uninstall removes the helper installation only when dev.mjs created it', t => {
  for (const created of [false, true]) {
    const root = home(t);
    const logs = [];
    const dev = new Dev({ home: root, log: (line) => logs.push(line) });
    // Installed from the Setup window: 0.1.0, then 0.1.4.
    const registration = swiftInstall(dev.layout, ['0.1.0', '0.1.4']);
    dev.state.swiftCreated = created;
    const calls = [];
    dev.setupApp = () => '/synthetic/Setup.app';
    dev.setup = (_, args) => { calls.push(args[0]); return { ok: true }; };
    const { removed } = dev.uninstall();
    assert.deepEqual(calls, created ? ['--uninstall'] : [], `created: ${created}`);
    assert.equal(removed.includes(dev.layout.helperRoot), created);
    if (!created) {
      assert.equal(readFileSync(dev.layout.manifest, 'utf8'), registration);
      assert.ok(logs.some((line) => line.includes('dev.mjs did not create it')), logs.join('\n'));
    }
  }
});

test('uninstall removes the app\'s run directory outside the support folder, and nothing that only resembles one', t => {
  const root = home(t);
  const dev = new Dev({ home: root, log: () => {} });
  const temp = path.join(path.dirname(root), 'T');
  const run = (name, files) => {
    const dir = path.join(temp, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of files) writeFileSync(path.join(dir, file), '');
    return dir;
  };
  const uid = process.getuid();
  const ours = run(`anon-guard-${uid}-d-0123456789ab`, ['guard.lock', 'starting.lock', 'guard.sock']);
  dev.state.runDir = ours;
  assert.deepEqual(dev.uninstall().removed, [ours]);
  assert.ok(!existsSync(ours));
  for (const [name, files] of [[`anon-guard-${uid}-d-0123456789ab`, ['guard.lock', 'notes.txt']], ['anon-guard-elsewhere', []], [`anon-guard-${uid}-p-0123456789ab`, []]]) {
    const dir = run(name, files);
    dev.state.runDir = dir;
    assert.deepEqual(dev.uninstall().removed, [], name);
    assert.ok(existsSync(dir), name);
    rmSync(dir, { recursive: true });
  }
});
