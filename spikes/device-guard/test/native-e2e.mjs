// Drives the spike through a real Chromium: a test extension calls the host shim, which
// forwards to the running app. Prints one JSON summary.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright node test/native-e2e.mjs \
//     --shim <path to anon-guard-host> --app-bin <path to anon-guard> \
//     --start '<shell command that starts the app>' --nm-dir <dir> [--nm-dir <dir>] [--headless]
//
// --nm-dir is where the host manifest is written (Chromium's per-user NativeMessagingHosts);
// <profile>/NativeMessagingHosts is always tried as well. On Windows the manifest is found
// through HKCU keys instead, written here the way a per-user (non-MSIX) installer would.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = 'inc.anon.guard_spike';
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const shim = path.resolve(opt('--shim'));
const appBin = path.resolve(opt('--app-bin'));
const startCmd = opt('--start');
const headless = args.includes('--headless');
// Who started the app that is running when the browser closes: the shim (openGuard),
// the harness, or nobody. Isolates a browser-close hang seen on Windows.
const closeWith = opt('--close-with') ?? 'shim';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-spike-'));
const profile = path.join(work, 'profile');
const extDir = path.join(work, 'ext');

const pwModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(path.isAbsolute(pwModule) ? pathToFileURL(path.join(pwModule, 'index.mjs')).href : pwModule);

// A pinned extension id from a fresh key: id = first 16 bytes of sha256(SPKI), hex mapped to a–p.
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const extId = [...crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Guard spike probe', version: '0.0.1',
  key: der.toString('base64'), permissions: ['nativeMessaging'],
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

const hostManifest = JSON.stringify({
  name: HOST, description: 'Anon Network Guard spike host', path: shim, type: 'stdio',
  allowed_origins: [`chrome-extension://${extId}/`],
}, null, 2);
const manifestPaths = [path.join(profile, 'NativeMessagingHosts'), ...opts('--nm-dir')].map((dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${HOST}.json`);
  fs.writeFileSync(file, hostManifest);
  return file;
});

const result = {};
const registryKeys = [];
if (process.platform === 'win32') {
  for (const vendor of ['Chromium', 'Google\\Chrome']) {
    const key = `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST}`;
    const r = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPaths[0], '/f'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`reg add failed: ${r.stderr}`);
    registryKeys.push(key);
  }
}

// stdio 'ignore': on Windows a `start`ed app inherits piped handles, and spawnSync then waits
// for the app itself to exit.
const sh = (cmd) => spawnSync(cmd, { shell: true, stdio: 'ignore' });
const step = (name) => process.stderr.write(`[e2e] ${name}\n`);
// Every result is printed as it lands, so a later hang still leaves the data in the log.
const record = (key, value) => { result[key] = value; process.stderr.write(`[e2e]   ${key} ${JSON.stringify(value)}\n`); };
let browserOpen = true;
async function closeBrowser(context) {
  if (!browserOpen) return true;
  const closed = await Promise.race([context.close().then(() => true), sleep(20000).then(() => false)]);
  browserOpen = false;
  if (!closed && process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/IM', 'chrome.exe'], { stdio: 'ignore' });
  return closed;
}
const appStatus = () => {
  const r = spawnSync(appBin, ['status'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(50); }
  return null;
}
async function startApp() { sh(startCmd); return waitFor(() => appStatus()?.ok && appStatus()); }
async function stopApp() { spawnSync(appBin, ['quit']); return waitFor(() => appStatus()?.ok !== true ? true : null); }
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  return { n: s.length, p50: q(0.5), p90: q(0.9), max: +s[s.length - 1].toFixed(1) };
};

Object.assign(result, { platform: `${process.platform}-${process.arch}`, extId, manifestPaths, registryKeys, shim });
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/page.html`);
  await page.waitForFunction(() => window.nm);
  const send = (msg) => page.evaluate((m) => window.nm.send(m), msg);

  step('1 app running');
  // 1. App running: one-shot messages (a shim per message) and a long-lived port.
  await stopApp();
  const started = await startApp();
  record('appStart', started && { launchedBy: started.launchedBy, pid: started.pid, job: started.job });
  record('shimDescribe', await send({ op: 'shimDescribe', id: 0 }));
  const oneShot = [];
  for (let i = 0; i < 20; i++) oneShot.push(await send({ v: 1, id: i, method: 'status' }));
  record('oneShot', { ok: oneShot.filter((r) => r.reply?.ok).length, ...stats(oneShot.map((r) => r.ms)), sample: oneShot[0].reply ?? oneShot[0].err });
  await page.evaluate(() => window.nm.open());
  const portRuns = [];
  for (let i = 0; i < 50; i++) portRuns.push(await page.evaluate((m) => window.nm.portSend(m), { v: 1, id: 100 + i, method: 'status' }));
  record('port', { ok: portRuns.filter((r) => r.reply?.ok).length, ...stats(portRuns.map((r) => r.ms)) });

  step('2 restart under port');
  // 2. The app restarts under an open port: the shim reconnects on the next message.
  await stopApp();
  await startApp();
  const afterRestart = await page.evaluate((m) => window.nm.portSend(m), { v: 1, id: 200, method: 'status' });
  record('portAcrossRestart', { ok: afterRestart.reply?.ok === true, ms: +afterRestart.ms.toFixed(1), disconnected: await page.evaluate(() => window.nm.disconnected) });
  await page.evaluate(() => window.nm.close());

  step('3 app stopped');
  // 3. App stopped: a background read gets a fixed code and never starts the app.
  await stopApp();
  const notRunning = [];
  for (let i = 0; i < 5; i++) notRunning.push(await send({ v: 1, id: 300 + i, method: 'status' }));
  record('appStopped', {
    replies: [...new Set(notRunning.map((r) => r.reply?.error ?? r.err))],
    ...stats(notRunning.map((r) => r.ms)),
    appStartedAnyway: appStatus()?.ok === true,
  });
  record('shimDescribeStopped', (await send({ op: 'shimDescribe', id: 1 })).reply);

  step('4 openGuard');
  // 4. A user's click: openGuard starts the app and answers once it is up.
  if (closeWith === 'shim') {
    const open = await send({ v: 1, id: 400, op: 'openGuard' });
    const status = appStatus();
    record('openGuard', { ok: open.reply?.ok === true, ms: +open.ms.toFixed(1), launchedBy: status?.launchedBy, appJob: status?.job, reply: open.reply ?? open.err });
  } else if (closeWith === 'harness') {
    const status = await startApp();
    record('openGuard', { skipped: true, appStartedBy: 'harness', launchedBy: status?.launchedBy, appJob: status?.job });
  } else {
    record('openGuard', { skipped: true, appStartedBy: 'nobody' });
  }
  record('closeWith', closeWith);

  step('5 browser close');
  // 5. The app keeps running after Chrome closes (it is not the shim's child).
  const t = Date.now();
  record('browserClosedCleanly', await closeBrowser(context));
  record('browserCloseMs', Date.now() - t);
  await sleep(1500);
  record('appSurvivesBrowserClose', closeWith === 'nobody' ? null : appStatus()?.ok === true);
  if (closeWith === 'nobody') await startApp();
} finally {
  await closeBrowser(context).catch(() => {});
}

step('6 single instance');
// 6. Single instance: five copies started at once leave exactly one listening.
await stopApp();
const copies = Array.from({ length: 5 }, () => spawn(appBin, [], { stdio: ['ignore', 'ignore', 'pipe'] }));
const exits = await Promise.all(copies.map((c) => new Promise((resolve) => {
  let stderr = '';
  c.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => resolve({ running: true, pid: c.pid }), 3000);
  c.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr: stderr.trim() }); });
})));
const live = appStatus();
record('singleInstance', {
  stillRunning: exits.filter((e) => e.running).length,
  exitedAlreadyRunning: exits.filter((e) => /already running/.test(e.stderr ?? '')).length,
  servingPid: live?.pid ?? null,
  servingIsOneOfThem: exits.some((e) => e.running && e.pid === live?.pid),
});
step('7 stale socket');
// 7. A killed instance leaves a stale socket; the next start reclaims it.
if (live?.pid) process.kill(live.pid, 'SIGKILL');
await sleep(300);
const reclaimed = spawn(appBin, [], { stdio: 'ignore', detached: true });
reclaimed.unref();
record('staleSocketReclaimed', Boolean(await waitFor(() => appStatus()?.ok && appStatus()?.pid === reclaimed.pid, 5000)));
await stopApp();

for (const file of manifestPaths) fs.rmSync(file, { force: true });
for (const key of registryKeys) spawnSync('reg', ['delete', key, '/f']);
fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
