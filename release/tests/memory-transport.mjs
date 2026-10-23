import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { artifactKey, sha256 } from '../lib.mjs';
import { createPublicArtifactVerifier } from '../publish.mjs';

export function memoryTransport({ failAt, corruptKey } = {}) {
  const objects = new Map(); const events = []; let revision = 0;
  return {
    objects, events,
    async get(key) { events.push(`get:${key}`); return objects.get(key) ?? null; },
    async head(key) { events.push(`head:${key}`); const item = objects.get(key); return item ? { bytes: item.bytes.length, etag: item.etag } : null; },
    async put(key, data, condition) {
      events.push(`put:${key}`);
      if (failAt === key) throw new Error('Synthetic upload failure');
      const before = objects.get(key);
      if (condition.none && before || condition.etag && before?.etag !== condition.etag) throw new Error('Synthetic conditional conflict');
      const bytes = data.file ? await readFile(data.file) : data.bytes;
      objects.set(key, { bytes: key === corruptKey ? Buffer.from('corrupt') : bytes, etag: `"revision-${++revision}"` });
    },
    async verify(key, expected) {
      events.push(`verify:${key}`);
      const item = objects.get(key);
      assert.equal(item?.bytes.length, expected.bytes, 'uploaded size mismatch');
      assert.equal(sha256(item.bytes), expected.sha256, 'uploaded hash mismatch');
    },
  };
}
export function fixturePublicVerifier(transport, fetchFixture) {
  return createPublicArtifactVerifier(async (location, request) => {
    transport.events.push(`public:${location}`);
    if (fetchFixture) return fetchFixture(location, request);
    const entry = transport.objects.get(artifactKey({ location }));
    return new Response(entry?.bytes ?? 'not found', { status: entry ? 200 : 404 });
  });
}
