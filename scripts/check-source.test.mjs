import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentIssues, localLinkIssues, pathIssues } from './check-source.mjs';

test('publication check rejects generated artifacts and credential paths', () => {
  for (const name of ['dist/setup/Info.plist', '.build/release/app', 'release/out/catalog.json',
    'test.apk', 'setup.dmg', 'Setup.app/Contents/MacOS/setup', 'debug.log']) {
    assert.ok(pathIssues(name).includes('generated artifact'), name);
  }
  for (const name of ['.env', '.env.production', 'keys/signing.pem', 'release.p12', 'wallet.keystore']) {
    assert.ok(pathIssues(name).includes('credential file'), name);
  }
  for (const name of ['assets/AnonIcon.png', 'release/tests/fixtures.mjs', '.github/workflows/ci.yml']) {
    assert.deepEqual(pathIssues(name), []);
  }
});

test('credential checks report only a category, never synthetic matching text', () => {
  const samples = ['-----BEGIN ' + 'PRIVATE KEY-----', 'ghp_' + 'x'.repeat(36),
    'github_pat_' + 'x'.repeat(50), 'AKIA' + 'A'.repeat(16), 'xoxb-' + 'x'.repeat(24)];
  for (const sample of samples) {
    assert.deepEqual(contentIssues(sample), ['possible credential']);
    assert.ok(!JSON.stringify(contentIssues(sample)).includes(sample));
  }
  assert.deepEqual(contentIssues('Use a production key outside this repository.'), []);
});

test('personal checkout paths are not publication documentation', () => {
  for (const prefix of ['Users', 'home']) {
    assert.deepEqual(contentIssues('/' + prefix + '/example/workspace/'), ['personal checkout path']);
  }
  assert.deepEqual(contentIssues('~/Library/Application Support/Anon/'), []);
});

test('local documentation links are checked without contacting remote hosts', () => {
  const files = new Set(['README.md', 'docs/testing.md']);
  const hasFile = name => files.has(name);
  assert.deepEqual(localLinkIssues('docs/checklist.md',
    '[root](../README.md) [test](testing.md#coverage) [web](https://anon.inc) [mail](mailto:security@example.test) [anchor](#local)', hasFile), []);
  assert.deepEqual(localLinkIssues('README.md', '[missing](missing.md)', hasFile),
    ['missing or out-of-repository documentation link']);
  for (const target of ['../../outside.md', '/README.md', '%ZZ']) {
    assert.equal(localLinkIssues('README.md', `[bad](${target})`, hasFile).length, 1);
  }
});

test('CI is pinned and read-only, with no installation or publication steps', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const actions = [...workflow.matchAll(/uses:\s+(\S+)/g)].map(match => match[1]);
  assert.equal(actions.length, 2);
  for (const action of actions) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|write-all|upload-artifact|native\.connect|notarytool/);
  for (const command of ['check-source.mjs', 'test-native.mjs -c release',
    'build-setup.mjs --channel production', 'build-setup.mjs --channel development',
    'test-wire.mjs --channel production', 'test-wire.mjs --channel development']) {
    assert.ok(workflow.includes(command), command);
  }
});
