// Drives an installed Device Guard development host through a real Chromium,
// in a temporary user-data-dir, with a key-pinned test extension:
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
//     node device/test/native-e2e.mjs --home <home used by scripts/dev.mjs> [--headless]
//
// Run it after `node scripts/dev.mjs install --variant device` with the same HOME.
// It reads that home's development host manifest (inc.anon.network_helper.dev),
// requires the device variant, and registers the same host in the temporary
// profile's NativeMessagingHosts. Chromium, and so the shim, the app and the
// bridged Swift helper, run with HOME set to that home.
//
// The development extension id is derived from the owner's checkout path (an
// unpacked extension), so no test extension can have it. The test manifest
// therefore points at a two-line wrapper that execs the *installed* shim with
// the enrolled origin; Chromium still enforces the test extension's origin.
// Everything after the shim's argv is the real installation.
//
// Checks: v9 appStatus, v8 describe and v1 status through the bridge (one-shot
// and on a long-lived port), the bridge's read cache, a malformed request, then
// with the app stopped: appNotRunning without starting it, and v9 openApp.
// v1 status is a read-only provider status (no connect, no app launch).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = 'inc.anon.network_helper.dev';
const ENROLLED = 'chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/';
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const home = opt('--home') && fs.realpathSync(opt('--home'));
if (!home) throw new Error('Usage: node device/test/native-e2e.mjs --home <dir> [--headless]');
const headless = args.includes('--headless');
const env = { ...process.env, HOME: home };

const installed = path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST}.json`);
const manifest = JSON.parse(fs.readFileSync(installed, 'utf8'));
if (!manifest.path.endsWith('.app/Contents/MacOS/anon-guard-host')) throw new Error(`The development host is not the Device Guard shim: ${manifest.path}`);
if (JSON.stringify(manifest.allowed_origins) !== JSON.stringify([ENROLLED])) throw new Error('Unexpected allowed_origins in the installed manifest.');
const shim = manifest.path;
const appBin = path.join(path.dirname(shim), 'anon-guard');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-device-e2e-'));
const profile = path.join(work, 'profile');
const extDir = path.join(work, 'ext');
const pwModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(path.isAbsolute(pwModule) ? pathToFileURL(path.join(pwModule, 'index.mjs')).href : pwModule);

// A pinned extension id from a fresh key: id = first 16 bytes of sha256(SPKI), hex mapped to a–p.
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const extId = [...crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Device Guard probe', version: '0.0.1', key: der.toString('base64'), permissions: ['nativeMessaging'],
}));
fs.writeFileSync(path.join(extDir, 'page.html'), '<!doctype html><script src="page.js"></script>');
fs.writeFileSync(path.join(extDir, 'page.js'), `
const HOST = ${JSON.stringify(HOST)};
const err = () => chrome.runtime.lastError?.message ?? null;
window.nm = {
  send(msg) {
    return new Promise((resolve) => {
      const t = performance.now();
      chrome.runtime.sendNativeMessage(HOST, msg, (reply) => resolve({ reply, err: err(), ms: performance.now() - t }));
    });
  },
  open() {
    this.pending = new Map(); this.disconnected = null;
    this.port = chrome.runtime.connectNative(HOST);
    this.port.onMessage.addListener((m) => { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } });
    this.port.onDisconnect.addListener(() => {
      this.disconnected = err() ?? 'disconnected';
      for (const p of this.pending.values()) p({ disconnected: this.disconnected });
      this.pending.clear();
    });
  },
  portSend(msg) {
    return new Promise((resolve) => {
      const t = performance.now();
      this.pending.set(msg.id, (reply) => resolve({ reply, ms: performance.now() - t }));
      this.port.postMessage(msg);
    });
  },
  close() { this.port?.disconnect(); this.port = null; },
};
`);

// The wrapper presents the enrolled origin to the installed shim (see above).
const wrapper = path.join(work, 'host-wrapper.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(shim)} ${JSON.stringify(ENROLLED)}\n`, { mode: 0o700 });
fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', `${HOST}.json`), JSON.stringify({
  ...manifest, path: wrapper, allowed_origins: [`chrome-extension://${extId}/`],
}, null, 2));

const result = { platform: `${process.platform}-${process.arch}`, extId, host: HOST, shim, checks: {} };
const failures = [];
const check = (name, ok, detail) => {
  result.checks[name] = { ok: Boolean(ok), ...detail };
  process.stderr.write(`[e2e] ${ok ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(detail)}\n`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appCli = (op) => {
  const r = spawnSync(appBin, [op], { env, encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
};
const appRunning = () => appCli('status')?.ok === true;
async function waitFor(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(50); }
  return false;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  return { n: s.length, p50: q(0.5), p90: q(0.9), max: +s[s.length - 1].toFixed(1) };
};
const id = () => crypto.randomUUID();

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless, env,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/page.html`);
  await page.waitForFunction(() => window.nm);
  const send = (msg) => page.evaluate((m) => window.nm.send(m), msg);

  // 1. The app is running (dev.mjs started it through openApp).
  if (!appRunning()) {
    const opened = await send({ v: 9, id: id(), method: 'openApp' });
    if (!opened.reply?.ok) throw new Error(`The app is not running and openApp failed: ${JSON.stringify(opened)}`);
  }
  const statusId = id();
  const status = await send({ v: 9, id: statusId, method: 'appStatus' });
  check('v9 appStatus (app running)', status.reply?.ok && status.reply.id === statusId && status.reply.app?.running === true
    && typeof status.reply.app.version === 'string' && typeof status.reply.shim?.version === 'string',
  { reply: status.reply ?? status.err, ms: +status.ms.toFixed(1) });

  const describeId = id();
  const describe = await send({ v: 8, id: describeId, method: 'describe' });
  check('v8 describe through the bridge', describe.reply?.ok && describe.reply.id === describeId && describe.reply.v === 8
    && describe.reply.helper?.channel === 'development' && describe.reply.helper?.platform === 'macos',
  { version: describe.reply?.helper?.version, build: describe.reply?.helper?.build, ms: +describe.ms.toFixed(1), err: describe.err });

  const before = appCli('status')?.bridge;
  const v1Id = id();
  const v1 = await send({ v: 1, id: v1Id, method: 'status' });
  const allowlisted = ['notInstalled', 'untrustedInstallation', 'unsupportedProviderVersion', 'providerUnavailable', 'providerTimeout', 'oversizedOutput', 'unrecognizedStatus'];
  check('v1 status through the bridge', v1.reply?.v === 1 && v1.reply.id === v1Id
    && (v1.reply.ok ? v1.reply.snapshot?.provider === 'mullvad' && v1.reply.snapshot.protection === 'unknown' : allowlisted.includes(v1.reply.error)),
  { ok: v1.reply?.ok, tunnel: v1.reply?.snapshot?.tunnel, error: v1.reply?.error, ms: +v1.ms.toFixed(1), err: v1.err });
  const v1Again = await send({ v: 1, id: id(), method: 'status' });
  const after = appCli('status')?.bridge;
  check('a second read within 5 s is served from the bridge cache', !v1.reply?.ok || after?.cacheHits > before?.cacheHits,
    { firstOk: v1.reply?.ok, cacheHits: [before?.cacheHits, after?.cacheHits], helperRuns: [before?.helperRuns, after?.helperRuns], ms: +v1Again.ms.toFixed(1) });

  const malformed = await send({ v: 1, id: id(), method: 'exec' });
  check('a malformed request keeps the router envelope', JSON.stringify(malformed.reply) === JSON.stringify({ error: 'unsupportedMethod', ok: false, v: 1 }), { reply: malformed.reply });

  const oneShot = [];
  for (let i = 0; i < 10; i++) oneShot.push(await send({ v: 8, id: id(), method: 'describe' }));
  check('one-shot describe x10', oneShot.every((r) => r.reply?.ok), stats(oneShot.map((r) => r.ms)));

  await page.evaluate(() => window.nm.open());
  const portRuns = [];
  for (let i = 0; i < 20; i++) portRuns.push(await page.evaluate((m) => window.nm.portSend(m), { v: 8, id: crypto.randomUUID(), method: 'describe' }));
  check('long-lived port describe x20', portRuns.every((r) => r.reply?.ok), stats(portRuns.map((r) => r.ms)));
  await page.evaluate(() => window.nm.close());

  // 2. App stopped: fixed codes, and nothing starts it.
  spawnSync(appBin, ['quit'], { env });
  check('the app quits', await waitFor(() => !appRunning()), {});
  const downId = id();
  const down = await send({ v: 1, id: downId, method: 'status' });
  check('v1 status with the app stopped is appNotRunning', JSON.stringify(down.reply) === JSON.stringify({ error: 'appNotRunning', id: downId, ok: false, v: 1 }), { reply: down.reply, ms: +down.ms.toFixed(1) });
  const downDescribeId = id();
  const downDescribe = await send({ v: 8, id: downDescribeId, method: 'describe' });
  check('v8 describe with the app stopped is appNotRunning', downDescribe.reply?.error === 'appNotRunning' && downDescribe.reply.v === 8 && downDescribe.reply.id === downDescribeId, { reply: downDescribe.reply });
  const downStatus = await send({ v: 9, id: id(), method: 'appStatus' });
  check('v9 appStatus with the app stopped', downStatus.reply?.ok && downStatus.reply.app.running === false && downStatus.reply.app.version === null, { reply: downStatus.reply });
  await sleep(500);
  check('background requests did not start the app', !appRunning(), {});

  // 3. A user's click: openApp starts it and it answers.
  const openId = id();
  const open = await send({ v: 9, id: openId, method: 'openApp' });
  check('v9 openApp starts the app', open.reply?.ok && open.reply.id === openId && open.reply.app?.running === true && !('shim' in open.reply),
    { reply: open.reply, ms: +open.ms.toFixed(1) });
  const app = appCli('status');
  check('the app was started by the shim', app?.launchedBy === 'shim' || app?.launchedBy === 'agent', { launchedBy: app?.launchedBy });
  const afterOpen = await send({ v: 8, id: id(), method: 'describe' });
  check('v8 describe through the bridge after openApp', afterOpen.reply?.ok, { ms: +afterOpen.ms.toFixed(1) });
} finally {
  await context.close();
}
await sleep(1000);
check('the app outlives the browser', appRunning(), {});
fs.rmSync(work, { recursive: true, force: true });
result.failures = failures;
console.log(JSON.stringify(result, null, 2));
process.exitCode = failures.length ? 1 : 0;
