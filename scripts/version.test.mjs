import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVersion, parseBuildVersion } from './version.mjs';

const source = (version, build) => `    public static let version = "${version}"\n    public static let build = ${build}\n`;
test('one source binds discovery and package versions', () => {
  assert.deepEqual(buildVersion, { version: '0.1.1', build: 3 });
  assert.deepEqual(parseBuildVersion(source('0.1.10', 12)), { version: '0.1.10', build: 12 });
});
test('ambiguous or noncanonical build metadata fails closed', () => {
  for (const text of [source('01.1.0', 3), source('0.1.1-beta', 3), source('0.1.1', 0),
    source('0.1.1', '03'), source('0.1.1', '1.5'), source('0.1.1', 3).repeat(2), ''])
    assert.throws(() => parseBuildVersion(text));
});
