#!/usr/bin/env node
// Development install of Anon Network Guard, development channel only:
// host inc.anon.network_helper.dev for extension foghepoakbdbpbjknofnhbhpiehpmdac.
//
//   node scripts/dev.mjs install [--variant swift|device] [--from <path>] [--no-login-item]
//   node scripts/dev.mjs status
//   node scripts/dev.mjs rollback
//   node scripts/dev.mjs uninstall [--from <Setup.app>]
//   Every command also takes --home <dir>, --applications <dir> and --json.
//
// swift   Builds the Setup app (or takes --from <Setup.app>) and installs its
//         helper headlessly with the same installer the Setup window uses.
//         Earlier versions stay installed, for rollback. Verified with a real
//         v8 describe round trip against the registered host path.
// device  Builds the Device Guard app (or takes --from <App.app>), installs it
//         to ~/Applications, backs up the Swift host manifest and points the
//         host at the app's shim. The app bridges v1–v8 to the installed Swift
//         helper, so the Swift variant is installed first if it is missing.
//         Registers the LaunchAgent login item (only in the account's real
//         home), starts the app through the shim's v9 openApp and verifies
//         appStatus and a v8 describe through the bridge.
//
// `install --variant swift` from the device variant stops the app, removes its
// login item and restores the backed-up manifest before installing. Every path
// derives from HOME (or --home) and --applications, so tests use a temporary
// home. macOS login items ignore HOME, so a temporary home never registers one.
// No VPN provider is contacted: verification uses only describe and appStatus.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identity } from './device-bundle.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
export const DEV = identity('development');
const SETUP_APP = 'Anon Network Guard Setup.app';
const MAX_APP_BACKUPS = 3;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** Every path the development install touches, from one home and one applications folder. */
export function layoutFor({ home, applications = path.join(home, 'Applications') }) {
  const support = path.join(home, 'Library/Application Support/Anon/DeviceGuard/development');
  return {
    home,
    applications,
    manifest: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${DEV.hostName}.json`),
    helperRoot: path.join(home, 'Library/Application Support/Anon/NetworkHelper/development'),
    support,
    bridge: path.join(support, 'bridge.json'),
    dev: path.join(support, 'dev'),
    state: path.join(support, 'dev', 'state.json'),
    app: path.join(applications, DEV.bundleName),
  };
}

/** A path with symlinks resolved as far as it exists (Swift writes /tmp for /private/tmp). */
export function canonical(target) {
  let existing = path.resolve(target);
  const rest = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync.native(existing), ...rest);
}

const inside = (child, parent) => canonical(child).startsWith(canonical(parent) + path.sep);

/** Which variant Chrome's development host registration points at. */
export function classifyManifest(manifest, layout) {
  if (!manifest) return { kind: 'none' };
  const target = typeof manifest.path === 'string' ? manifest.path : '';
  if (manifest.name !== DEV.hostName || JSON.stringify(manifest.allowed_origins) !== JSON.stringify([DEV.origin]))
    return { kind: 'foreign', path: target };
  if (target && inside(target, path.join(layout.helperRoot, 'versions')))
    return { kind: 'swift', path: target, version: path.basename(path.dirname(target)) };
  if (target && canonical(target) === canonical(path.join(layout.app, 'Contents/MacOS/anon-guard-host')))
    return { kind: 'device', path: target };
  return { kind: 'foreign', path: target };
}

export function readJson(file, limit = 64 * 1024) {
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isFile() || entry.size > limit) throw new Error(`Not a small regular file: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Owner-only directories and an atomic, owner-only file. */
export function writePrivate(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function loadState(layout) {
  const state = readJson(layout.state);
  if (state && state.schemaVersion === 1) return state;
  return { schemaVersion: 1, variant: null, swiftHistory: [], swiftManifestBackup: null, loginItem: false, appBackups: [] };
}

export function saveState(layout, state) {
  writePrivate(layout.state, JSON.stringify(state, null, 2) + '\n');
}

/** Installed Swift versions (`<version>-<sha256>`), oldest first, from the installer's receipt. */
export function swiftVersions(layout) {
  const receipt = readJson(path.join(layout.helperRoot, 'installation.json'));
  if (!receipt) return [];
  if (receipt.owner !== 'inc.anon.network-helper.setup.v1' || receipt.channel !== 'development') throw new Error('The helper receipt is not the development installer\'s.');
  return receipt.versions.map((v) => `${v.version}-${v.sha256}`);
}

/** The version to roll back to: the one active before `active`, still installed. */
export function previousSwiftVersion(history, installed, active) {
  const earlier = history.slice(0, history.lastIndexOf(active) >= 0 ? history.lastIndexOf(active) : history.length);
  for (let i = earlier.length - 1; i >= 0; i--) if (earlier[i] !== active && installed.includes(earlier[i])) return earlier[i];
  const index = installed.indexOf(active);
  return index > 0 ? installed[index - 1] : null;
}

export function encodeFrame(object) {
  const body = Buffer.from(JSON.stringify(object));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeFrames(data) {
  const replies = [];
  for (let offset = 0; offset + 4 <= data.length;) {
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length === 0 || offset + length > data.length) throw new Error('Truncated native reply.');
    replies.push(JSON.parse(data.subarray(offset, offset + length).toString('utf8')));
    offset += length;
  }
  return replies;
}

export const uuid = () => crypto.randomUUID();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** One native-messaging session, as Chrome runs it: origin argument, framed requests, EOF. */
export function nativeSession(executable, requests, { home, timeout = 20000 }) {
  const result = spawnSync(executable, [DEV.origin], {
    input: Buffer.concat(requests.map(encodeFrame)), env: { ...process.env, HOME: home }, timeout, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`Native host did not finish: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) throw new Error(`Native host exited ${result.status}.`);
  const replies = decodeFrames(result.stdout);
  if (replies.length !== requests.length) throw new Error(`Expected ${requests.length} replies, got ${replies.length}.`);
  return replies;
}

function run(command, args, { home, json = false, quiet = false, cwd = repo } = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...(home ? { HOME: home } : {}) }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', json || quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit'],
  });
  if (result.error) throw result.error;
  if (json) {
    const text = result.stdout.trim();
    for (const candidate of [text, text.split('\n').at(-1)]) {
      try { return { status: result.status, value: JSON.parse(candidate) }; } catch { /* try the last line */ }
    }
    return { status: result.status, value: null };
  }
  return result;
}

function plistValue(bundle, key) {
  const result = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export class Dev {
  constructor({ home, applications, log = console.log }) {
    if (!home || !path.isAbsolute(home)) throw new Error('HOME (or --home) must be an absolute path.');
    this.layout = layoutFor({ home: canonical(home), applications: applications && canonical(applications) });
    this.home = this.layout.home;
    // SMAppService registers per account, whatever HOME says: only the real home gets login items.
    this.realHome = canonical(os.userInfo().homedir) === this.home;
    this.log = log;
    this.state = loadState(this.layout);
  }

  save() { saveState(this.layout, this.state); }
  manifest() { return readJson(this.layout.manifest, 16384); }
  variant() { return classifyManifest(this.manifest(), this.layout); }
  shim() { return path.join(this.layout.app, 'Contents/MacOS/anon-guard-host'); }
  appBinary() { return path.join(this.layout.app, 'Contents/MacOS/anon-guard'); }

  // Swift ---------------------------------------------------------------

  setupApp(from) {
    if (from) {
      const candidate = path.resolve(from);
      const app = candidate.endsWith('.app') ? candidate : path.join(candidate, SETUP_APP);
      if (!existsSync(path.join(app, 'Contents/MacOS/AnonNetworkHelperSetup'))) throw new Error(`No development Setup app at ${app}.`);
      return app;
    }
    this.log('Building the development Setup app…');
    const built = run(process.execPath, [path.join(repo, 'scripts/build-setup.mjs'), '--channel', 'development'], { quiet: true });
    if (built.status !== 0) throw new Error(`build-setup failed:\n${built.stderr?.slice(-2000) ?? ''}`);
    return path.join(repo, 'dist/development', SETUP_APP);
  }

  /** A development Setup app already on disk (the last one used, or dist/), else undefined. */
  reusableSetupApp() {
    for (const app of [this.state.lastSetupApp, path.join(repo, 'dist/development', SETUP_APP)]) {
      if (app && existsSync(path.join(app, 'Contents/MacOS/AnonNetworkHelperSetup'))) return app;
    }
    return undefined;
  }

  setup(app, args) {
    const { status, value } = run(path.join(app, 'Contents/MacOS/AnonNetworkHelperSetup'), [...args, '--home', this.home], { json: true });
    if (!value) throw new Error(`The Setup app gave no result (exit ${status}). Is it a development build?`);
    if (!value.ok) throw new Error(`Setup ${args[0]}: ${value.error}. ${value.message ?? ''}`.trim());
    return value;
  }

  describeSwift() {
    const variant = this.variant();
    if (variant.kind !== 'swift') throw new Error(`The development host is ${variant.kind}, not the Swift helper.`);
    const [reply] = nativeSession(variant.path, [{ v: 8, id: uuid(), method: 'describe' }], { home: this.home });
    if (!reply.ok || reply.helper?.channel !== 'development') throw new Error(`describe failed: ${JSON.stringify(reply)}`);
    return { path: variant.path, version: variant.version, describe: reply.helper };
  }

  installSwift({ from } = {}) {
    const app = this.setupApp(from);
    const payload = readJson(path.join(app, 'Contents/Resources/payload.json'), 4096);
    if (payload?.channel !== 'development') throw new Error('The Setup app is not a development build.');
    const current = this.variant();
    if (current.kind === 'foreign') throw new Error(`The development host points at ${current.path}; not replacing a foreign registration.`);
    if (current.kind === 'device') this.leaveDevice();
    const result = this.setup(app, ['--install']);
    this.state.lastSetupApp = app;
    this.remember(result.active.directory);
    this.state.variant = 'swift';
    this.save();
    const verified = this.describeSwift();
    if (verified.describe.version !== payload.version) throw new Error(`describe reports ${verified.describe.version}, expected ${payload.version}.`);
    this.log(`Swift helper ${verified.describe.version} (${verified.describe.build}) installed and answering v8 describe: ${verified.path}`);
    return verified;
  }

  remember(directory) {
    const history = this.state.swiftHistory.filter((entry) => entry !== directory);
    this.state.swiftHistory = [...history, directory].slice(-32);
  }

  // Device --------------------------------------------------------------

  deviceApp(from) {
    if (from) {
      const app = path.resolve(from);
      if (!existsSync(path.join(app, 'Contents/MacOS/anon-guard-host'))) throw new Error(`No Device Guard app at ${app}.`);
      return app;
    }
    this.log('Building the Device Guard app…');
    const built = run(process.execPath, [path.join(repo, 'scripts/build-device.mjs'), '--channel', 'development'], { quiet: true });
    if (built.status !== 0) throw new Error(`build-device failed:\n${built.stderr?.slice(-2000) ?? ''}`);
    return path.join(repo, 'dist/device/development', DEV.bundleName);
  }

  assertOurApp(app) {
    const id = plistValue(app, 'CFBundleIdentifier');
    if (id !== DEV.bundleId) throw new Error(`${app} is ${id ?? 'not an app bundle'}, not ${DEV.bundleId}; leaving it alone.`);
  }

  appCli(args) {
    if (!existsSync(this.appBinary())) return null;
    return run(this.appBinary(), args, { home: this.home, json: true });
  }

  appRunning() {
    return this.appCli(['status'])?.value?.ok === true;
  }

  quitApp() {
    if (!this.appRunning()) return;
    this.appCli(['quit']);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!this.appRunning()) return;
      sleep(100);
    }
    throw new Error('The Device Guard app did not quit.');
  }

  loginItem(action) {
    if (!this.realHome) return null;
    return this.appCli(['login-item', action])?.value ?? null;
  }

  shimSession(requests, timeout) {
    return nativeSession(this.shim(), requests, { home: this.home, timeout });
  }

  /** v9 appStatus plus a v8 describe through the shim, the app and the Swift helper. */
  checkDevice() {
    const [status, describe] = this.shimSession([{ v: 9, id: uuid(), method: 'appStatus' }, { v: 8, id: uuid(), method: 'describe' }]);
    return { status, describe };
  }

  installDevice({ from, loginItem = true } = {}) {
    if (swiftVersions(this.layout).length === 0) {
      this.log('The bridge needs the Swift helper; installing it first.');
      this.installSwift();
    }
    const current = this.variant();
    if (current.kind === 'foreign') throw new Error(`The development host points at ${current.path}; not replacing a foreign registration.`);
    const installed = swiftVersions(this.layout);
    const bridged = current.kind === 'swift' ? current.version : (readJson(this.layout.bridge)?.helper ?? installed.at(-1));
    if (!installed.includes(bridged)) throw new Error(`Swift helper ${bridged} is not installed.`);

    const source = this.deviceApp(from);
    this.assertOurApp(source);
    mkdirSync(this.layout.applications, { recursive: true });
    if (existsSync(this.layout.app)) {
      this.assertOurApp(this.layout.app);
      this.quitApp();
      this.backupApp();
    }
    const copied = run('/usr/bin/ditto', [source, this.layout.app], { quiet: true });
    if (copied.status !== 0) throw new Error('Copying the app failed.');

    const printed = run(this.shim(), ['--print-host-manifest'], { json: true, home: this.home });
    const manifest = printed.value;
    if (manifest?.name !== DEV.hostName || JSON.stringify(manifest.allowed_origins) !== JSON.stringify([DEV.origin]))
      throw new Error('The app\'s shim printed an unexpected host manifest.');
    if (current.kind === 'swift') {
      const backup = path.join(this.layout.dev, 'backups', 'manifests', `${Date.now()}.json`);
      writePrivate(backup, readFileSync(this.layout.manifest, 'utf8'));
      this.state.swiftManifestBackup = path.relative(this.layout.dev, backup);
    }
    writePrivate(this.layout.manifest, JSON.stringify(manifest, null, 2) + '\n');
    writePrivate(this.layout.bridge, JSON.stringify({ schemaVersion: 1, helper: bridged }) + '\n');
    this.state.variant = 'device';
    this.save();

    if (loginItem && this.realHome) {
      const registered = this.loginItem('register');
      this.state.loginItem = registered?.startAtLogin === 'enabled' || registered?.startAtLogin === 'requiresApproval';
      this.save();
      if (registered?.startAtLogin === 'requiresApproval') this.log('Approve "Anon Network Guard Dev" in System Settings → General → Login Items.');
    } else if (loginItem) {
      this.log('Temporary home: not registering a login item (macOS registers them per account, not per HOME).');
    }
    const [opened] = this.shimSession([{ v: 9, id: uuid(), method: 'openApp' }], 20000);
    if (!opened.ok) throw new Error(`openApp: ${opened.error}`);
    const { status, describe } = this.checkDevice();
    if (!status.app?.running || !describe.ok || describe.helper?.channel !== 'development')
      throw new Error(`The app does not answer through the shim: ${JSON.stringify({ status, describe })}`);
    this.log(`Device Guard app ${status.app.version} running (start at login: ${status.app.startAtLogin}), bridging to Swift helper ${describe.helper.version} (${bridged}).`);
    return { status, describe, bridged };
  }

  backupApp() {
    const backup = path.join(this.layout.dev, 'backups', 'apps', String(Date.now()));
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    renameSync(this.layout.app, path.join(backup, DEV.bundleName));
    this.state.appBackups = [...(this.state.appBackups ?? []), path.relative(this.layout.dev, backup)];
    while (this.state.appBackups.length > MAX_APP_BACKUPS) {
      rmSync(path.join(this.layout.dev, this.state.appBackups.shift()), { recursive: true, force: true });
    }
    this.save();
  }

  /** Stops the app, removes its login item, and gives the host back to the Swift helper. */
  leaveDevice() {
    this.quitApp();
    if (this.state.loginItem) {
      this.loginItem('unregister');
      this.state.loginItem = false;
    }
    const current = this.variant();
    if (current.kind === 'device') {
      const backup = this.state.swiftManifestBackup && path.join(this.layout.dev, this.state.swiftManifestBackup);
      const saved = backup && existsSync(backup) ? readFileSync(backup, 'utf8') : null;
      if (saved && classifyManifest(JSON.parse(saved), this.layout).kind === 'swift' && existsSync(JSON.parse(saved).path)) {
        writePrivate(this.layout.manifest, saved);
        this.log('Restored the Swift host manifest.');
      } else {
        rmSync(this.layout.manifest);
      }
    }
    rmSync(this.layout.bridge, { force: true });
    this.state.variant = this.variant().kind === 'swift' ? 'swift' : null;
    this.save();
  }

  // Commands ------------------------------------------------------------

  install({ variant = 'swift', from, loginItem = true } = {}) {
    if (variant === 'swift') return { variant, swift: this.installSwift({ from }) };
    if (variant === 'device') return { variant, device: this.installDevice({ from, loginItem }) };
    throw new Error('--variant is swift or device.');
  }

  status() {
    const current = this.variant();
    const result = {
      home: this.home,
      realHome: this.realHome,
      variant: current.kind,
      host: { name: DEV.hostName, manifest: this.layout.manifest, path: current.path ?? null },
      swift: { installed: swiftVersions(this.layout), active: null, describe: null },
      device: { installed: existsSync(this.layout.app), path: this.layout.app, version: null, running: false, startAtLogin: null, shim: null, bridged: readJson(this.layout.bridge)?.helper ?? null },
      backups: { apps: this.state.appBackups?.length ?? 0, swiftManifest: Boolean(this.state.swiftManifestBackup) },
    };
    if (current.kind === 'swift') {
      result.swift.active = current.version;
      try { result.swift.describe = this.describeSwift().describe; } catch (error) { result.swift.error = error.message; }
    }
    if (result.device.installed) {
      result.device.version = plistValue(this.layout.app, 'CFBundleShortVersionString');
      if (current.kind === 'device') result.swift.active = result.device.bridged;
      try {
        const [status] = this.shimSession([{ v: 9, id: uuid(), method: 'appStatus' }]);
        Object.assign(result.device, { running: status.app.running, startAtLogin: status.app.startAtLogin, shim: status.shim.version });
        if (current.kind === 'device' && status.app.running) result.swift.describe = this.checkDevice().describe.helper;
      } catch (error) { result.device.error = error.message; }
    }
    return result;
  }

  rollback() {
    const current = this.variant();
    if (current.kind === 'swift') {
      const target = previousSwiftVersion(this.state.swiftHistory, swiftVersions(this.layout), current.version);
      if (!target) throw new Error('No earlier Swift helper version is installed.');
      this.setup(this.setupApp(this.reusableSetupApp()), ['--activate', target]);
      this.state.swiftHistory = this.state.swiftHistory.filter((entry) => entry !== current.version);
      this.remember(target);
      this.save();
      const verified = this.describeSwift();
      this.log(`Rolled the Swift helper back to ${target}.`);
      return { variant: 'swift', from: current.version, to: target, describe: verified.describe };
    }
    if (current.kind === 'device') {
      const backups = this.state.appBackups ?? [];
      const latest = backups.at(-1);
      const saved = latest && path.join(this.layout.dev, latest, DEV.bundleName);
      if (!saved || !existsSync(saved)) throw new Error('No earlier Device Guard app is saved.');
      this.assertOurApp(saved);
      this.quitApp();
      this.assertOurApp(this.layout.app);
      run(LSREGISTER, ['-u', this.layout.app], { quiet: true });
      rmSync(this.layout.app, { recursive: true });
      renameSync(saved, this.layout.app);
      rmSync(path.join(this.layout.dev, latest), { recursive: true, force: true });
      this.state.appBackups = backups.slice(0, -1);
      this.save();
      const [opened] = this.shimSession([{ v: 9, id: uuid(), method: 'openApp' }], 20000);
      if (!opened.ok) throw new Error(`openApp after rollback: ${opened.error}`);
      const { status } = this.checkDevice();
      this.log(`Rolled the Device Guard app back to ${status.app.version}.`);
      return { variant: 'device', to: status.app.version };
    }
    throw new Error(`Nothing to roll back: the development host is ${current.kind}.`);
  }

  uninstall({ from } = {}) {
    const removed = [];
    if (existsSync(this.layout.app)) {
      this.assertOurApp(this.layout.app);
      this.quitApp();
      if (this.realHome && ['enabled', 'requiresApproval'].includes(this.loginItem('status')?.startAtLogin)) this.loginItem('unregister');
      if (this.variant().kind === 'device') this.leaveDevice();
      run(LSREGISTER, ['-u', this.layout.app], { quiet: true });
      rmSync(this.layout.app, { recursive: true });
      removed.push(this.layout.app);
    }
    // The app may have been deleted by hand: still give the host back.
    if (this.variant().kind === 'device') this.leaveDevice();
    if (swiftVersions(this.layout).length > 0) {
      const variant = this.variant();
      if (variant.kind === 'foreign') throw new Error(`The development host points at ${variant.path}; not removing it.`);
      this.setup(this.setupApp(from ?? this.reusableSetupApp()), ['--uninstall']);
      removed.push(this.layout.helperRoot);
    }
    if (existsSync(this.layout.support)) {
      const unknown = readdirSync(this.layout.support).filter((name) => !['run', 'bridge.json', 'dev'].includes(name));
      if (unknown.length) throw new Error(`Leaving ${this.layout.support}: it holds ${unknown.join(', ')}.`);
      rmSync(this.layout.support, { recursive: true });
      removed.push(this.layout.support);
    }
    this.log(removed.length ? `Removed:\n  ${removed.join('\n  ')}` : 'Nothing to remove.');
    return { removed };
  }
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { command, json: false, loginItem: true };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new Error(`${flag} needs a value.`);
      return rest[++i];
    };
    if (flag === '--variant') options.variant = value();
    else if (flag === '--from') options.from = value();
    else if (flag === '--home') options.home = value();
    else if (flag === '--applications') options.applications = value();
    else if (flag === '--no-login-item') options.loginItem = false;
    else if (flag === '--json') options.json = true;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (!['install', 'status', 'rollback', 'uninstall'].includes(command)) throw new Error('Commands: install, status, rollback, uninstall.');
  if (options.variant && command !== 'install') throw new Error('--variant goes with install.');
  return options;
}

function printStatus(status, log) {
  log(`Development host ${status.host.name}: ${status.variant}${status.host.path ? ` → ${status.host.path}` : ''}`);
  log(`  Swift helper: ${status.swift.installed.length} installed${status.swift.active ? `, active ${status.swift.active}` : ''}` +
    `${status.swift.describe ? ` (describe: ${status.swift.describe.version}, build ${status.swift.describe.build})` : ''}`);
  if (status.device.installed) {
    log(`  Device Guard app ${status.device.version}: ${status.device.running ? 'running' : 'not running'}, start at login ${status.device.startAtLogin ?? 'unknown'}, shim ${status.device.shim ?? '?'}`);
  } else {
    log('  Device Guard app: not installed');
  }
  if (!status.realHome) log(`  (temporary home ${status.home})`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.platform !== 'darwin') throw new Error('The development install is macOS only.');
    const options = parse(process.argv.slice(2));
    const log = options.json ? () => {} : console.log;
    const dev = new Dev({ home: options.home ?? process.env.HOME, applications: options.applications, log });
    let result;
    if (options.command === 'install') result = dev.install(options);
    else if (options.command === 'status') { result = dev.status(); if (!options.json) printStatus(result, log); }
    else if (options.command === 'rollback') result = dev.rollback();
    else result = dev.uninstall(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`dev.mjs: ${error.message}`);
    process.exitCode = 1;
  }
}
