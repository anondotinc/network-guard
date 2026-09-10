import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertBuildOutput } from './bundle-layout.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'anon-setup-layout-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'dist/production/Anon Network Guard Setup.app');
  return { root, app };
}

test('new output and exact previously generated files are accepted', t => {
  const { root, app } = fixture(t);
  assert.doesNotThrow(() => assertBuildOutput(root, app));
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  for (const name of ['Info.plist', 'MacOS/AnonNetworkHelperSetup', 'Resources/anon-network-helper', 'Resources/payload.json', 'Resources/LICENSE', 'Resources/AnonNetworkGuard.icns', 'Resources/BrandAssets-LICENSE']) {
    writeFileSync(path.join(app, 'Contents', name), 'synthetic generated file');
  }
  assert.doesNotThrow(() => assertBuildOutput(root, app));
});

test('stale private file fails before it can enter a rebuilt release bundle', t => {
  const { root, app } = fixture(t);
  const resources = path.join(app, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  const unexpected = path.join(resources, 'debug.log');
  writeFileSync(unexpected, 'synthetic private marker');
  assert.throws(() => assertBuildOutput(root, app), /unrecognized entries/);
  assert.equal(readFileSync(unexpected, 'utf8'), 'synthetic private marker');
  assert.equal(existsSync(path.join(app, 'Contents/Info.plist')), false);
});

test('unexpected directories and directory-as-file are rejected, not cleaned', t => {
  const { root, app } = fixture(t);
  const unexpected = path.join(app, 'Contents/Info.plist/nested');
  mkdirSync(unexpected, { recursive: true });
  writeFileSync(path.join(unexpected, 'keep.txt'), 'keep');
  assert.throws(() => assertBuildOutput(root, app), /unrecognized entries/);
  assert.equal(readFileSync(path.join(unexpected, 'keep.txt'), 'utf8'), 'keep');
});

test('symlinked output ancestor is rejected without touching its destination', t => {
  const { root, app } = fixture(t);
  const elsewhere = path.join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(root, 'dist'));
  assert.throws(() => assertBuildOutput(root, app), /redirected/);
  assert.equal(existsSync(path.join(elsewhere, 'production')), false);
});

test('symlink at an otherwise permitted filename is rejected', t => {
  const { root, app } = fixture(t);
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  const external = path.join(root, 'external');
  writeFileSync(external, 'untouched');
  symlinkSync(external, path.join(app, 'Contents/Resources/LICENSE'));
  assert.throws(() => assertBuildOutput(root, app), /unrecognized entries/);
  assert.equal(readFileSync(external, 'utf8'), 'untouched');
});
