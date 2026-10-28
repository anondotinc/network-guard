import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { artifactKey, fileInfo, invariant, jsonBytes, MAX_ARTIFACT_BYTES, releaseId, sha256, unchangedHistory, verifyCatalogSignature } from './lib.mjs';
import { assertCatalogTransition } from './catalog.mjs';
export { assertCatalogTransition } from './catalog.mjs';

// Active envelope contains a base64-encoded catalog (bounded separately to 2 MiB).
const MAX_METADATA = 3 * 1024 * 1024;
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const safeKey = (key) => typeof key === 'string' && /^[A-Za-z0-9._/-]+$/.test(key) && !key.split('/').some((x) => !x || x.includes('..'));
const githubAsset = /^https:\/\/github\.com\/anondotinc\/network-guard\/releases\/download\/(v[A-Za-z0-9._-]{1,160})\/([A-Za-z0-9][A-Za-z0-9._-]{0,159}\.zip)$/;
const isGitHub = (location) => typeof location === 'string' && githubAsset.test(location) && !location.includes('..');

/** Independently verify the exact public URL that users will receive; never send R2 credentials. */
export function createPublicArtifactVerifier(fetchImpl = fetch) {
  return async function verifyPublicArtifact(location, expected) {
    const github = isGitHub(location) ? location.match(githubAsset) : null;
    if (!github) {
      // Validate the exact allowlisted origin and versioned key before any fetch.
      artifactKey({ location });
    }
    invariant(Number.isSafeInteger(expected?.bytes) && expected.bytes > 0 && expected.bytes <= MAX_ARTIFACT_BYTES && /^[0-9a-f]{64}$/.test(expected.sha256), 'Invalid expected public artifact size or digest');
    let response;
    let finalLocation = location;
    const signal = AbortSignal.timeout(requestTimeoutMs(expected.bytes));
    const request = { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' }, signal };
    try {
      if (github) {
        const metadata = await fetchImpl(`https://api.github.com/repos/anondotinc/network-guard/releases/tags/${github[1]}`, {
          ...request, headers: { ...request.headers, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        try {
          invariant(metadata.status === 200 && !metadata.redirected, 'GitHub release metadata is unavailable; catalog not activated');
          let size = 0; const parts = [];
          for await (const part of metadata.body) { size += part.length; invariant(size <= 1024 * 1024, 'GitHub metadata is too large; catalog not activated'); parts.push(part); }
          const release = JSON.parse(Buffer.concat(parts));
          const assets = release.assets?.filter((asset) => asset.name === github[2]);
          invariant(release.tag_name === github[1] && release.immutable === true && release.draft === false && release.prerelease === false,
            'GitHub helper release must be published, stable and immutable; catalog not activated');
          invariant(assets?.length === 1 && assets[0].browser_download_url === location && assets[0].size === expected.bytes && assets[0].digest === `sha256:${expected.sha256}`,
            'GitHub asset metadata does not match the signed catalog; catalog not activated');
        } finally { try { await metadata.body?.cancel(); } catch {} }
      }
      response = await fetchImpl(location, request);
      if (github && [301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('location'));
        invariant(next.protocol === 'https:' && next.hostname === 'release-assets.githubusercontent.com' && !next.port && !next.username && !next.password && !next.hash && next.pathname.startsWith('/github-production-release-asset/'),
          'Unexpected GitHub asset redirect; catalog not activated');
        try { await response.body?.cancel(); } catch {}
        finalLocation = next.href;
        response = await fetchImpl(finalLocation, request);
      }
    } catch (error) {
      try { await response?.body?.cancel(); } catch {}
      if (error instanceof Error && error.message.endsWith('catalog not activated')) throw error;
      throw new Error('Public download hostname is unavailable or timed out; catalog not activated');
    }
    try {
      invariant(response.status === 200 && !response.redirected && (!response.url || response.url === finalLocation), 'Public download must return HTTP 200 at its exact immutable URL without unexpected redirects; catalog not activated');
      invariant(response.body, 'Public download body is missing; catalog not activated');
      const encoding = response.headers.get('content-encoding');
      invariant(!encoding || encoding === 'identity', 'Unexpected public download content encoding; catalog not activated');
      const length = response.headers.get('content-length');
      invariant(length === null || /^\d+$/.test(length) && Number(length) === expected.bytes, 'Public download Content-Length does not match the artifact; catalog not activated');
      const hash = createHash('sha256'); let size = 0;
      for await (const part of response.body) {
        size += part.length;
        invariant(size <= expected.bytes, 'Public download exceeded its expected size; catalog not activated');
        hash.update(part);
      }
      invariant(size === expected.bytes && hash.digest('hex') === expected.sha256, 'Public download hash/size mismatch; catalog not activated');
    } catch (error) {
      // Cancel rejected headers/body streams without waiting for a server to finish.
      try { await response.body?.cancel(); } catch { /* A consumed/errored stream may already be closed. */ }
      if (error instanceof Error && error.message.endsWith('catalog not activated')) throw error;
      throw new Error('Public download failed or timed out while reading bytes; catalog not activated');
    }
  };
}

/**
 * How long one request may take: 60 s, plus one second per 256 KiB of the body it
 * carries (an upload) or is expected to return (a verification download), so a
 * release-sized artifact is not cut off on a slow link while a stalled request
 * still fails. ANON_RELEASE_REQUEST_TIMEOUT_MS raises the floor for one run.
 */
export function requestTimeoutMs(bodyBytes = 0) {
  const floor = Math.max(60_000, Number(process.env.ANON_RELEASE_REQUEST_TIMEOUT_MS) || 0);
  return floor + Math.ceil(Math.max(0, bodyBytes) / 262_144) * 1_000;
}

/** Minimal fixed-endpoint R2 S3 transport. No account/list/delete/provision operation exists. */
export function createR2Transport({ accountId, bucket, accessKeyId, secretAccessKey }, fetchImpl = fetch) {
  invariant(/^[0-9a-f]{32}$/.test(accountId ?? ''), 'R2 account ID must contain 32 lowercase hex characters');
  invariant(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? ''), 'Invalid dedicated release bucket name');
  invariant(accessKeyId && secretAccessKey, 'Dedicated R2 release credentials are required for --execute');
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  async function request(method, key, { bytes, file, payloadHash = sha256(Buffer.alloc(0)), length, condition, contentType = 'application/octet-stream', expectedBytes = 0 } = {}) {
    invariant(safeKey(key), 'Unsafe storage key');
    const pathname = `/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = now.slice(0, 8);
    const headers = { host: new URL(endpoint).host, 'x-amz-date': now, 'x-amz-content-sha256': payloadHash };
    if (method === 'PUT') {
      headers['content-type'] = contentType;
      headers['content-length'] = String(length ?? bytes.length);
      if (condition?.none) headers['if-none-match'] = '*';
      else if (condition?.etag) headers['if-match'] = condition.etag;
      else throw new Error('Every PUT must carry an immutable or compare-and-swap condition');
    }
    const names = Object.keys(headers).sort();
    const canonical = [method, pathname, '', names.map((k) => `${k}:${headers[k]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
    const keyBytes = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', keyBytes).update(toSign).digest('hex')}`;
    let response;
    try {
      // Unsigned transport-only header: a compressed response carries a weak
      // ETag, which cannot serve as a compare-and-swap validator on activation.
      const wire = method === 'PUT' ? headers : { ...headers, 'accept-encoding': 'identity' };
      response = await fetchImpl(`${endpoint}${pathname}`, { method, headers: wire, ...(method === 'PUT' ? { body: file ? createReadStream(file) : bytes, duplex: 'half' } : {}), redirect: 'manual', signal: AbortSignal.timeout(requestTimeoutMs(method === 'PUT' ? (length ?? bytes?.length ?? 0) : expectedBytes)) });
    } catch { throw new Error('R2 request failed or timed out; activation was not confirmed. Inspect with a fresh dry run before retrying.'); }
    return response;
  }
  return {
    async get(key, limit = MAX_METADATA) {
      const response = await request('GET', key);
      if (response.status === 404) return null;
      invariant(response.ok, `R2 read failed (HTTP ${response.status})`);
      const chunks = []; let size = 0;
      for await (const part of response.body) { size += part.length; invariant(size <= limit, 'Remote metadata exceeds size limit'); chunks.push(part); }
      return { bytes: Buffer.concat(chunks), etag: response.headers.get('etag') };
    },
    async head(key) {
      const response = await request('HEAD', key);
      if (response.status === 404) return null;
      invariant(response.ok, `R2 metadata read failed (HTTP ${response.status})`);
      return { bytes: Number(response.headers.get('content-length')), etag: response.headers.get('etag') };
    },
    async verify(key, expected) {
      const response = await request('GET', key, { expectedBytes: expected.bytes });
      invariant(response.ok, `R2 verification read failed (HTTP ${response.status})`);
      const hash = createHash('sha256'); let size = 0;
      for await (const part of response.body) { size += part.length; invariant(size <= expected.bytes, 'Remote artifact is larger than expected'); hash.update(part); }
      invariant(size === expected.bytes && hash.digest('hex') === expected.sha256, 'Uploaded artifact hash/size mismatch; catalog not activated');
    },
    async put(key, data, condition = { none: true }) {
      const response = await request('PUT', key, { ...data, condition });
      invariant(response.ok, response.status === 412 || response.status === 409 ? 'Immutable object conflict or catalog changed concurrently; no overwrite performed' : `R2 upload failed (HTTP ${response.status}); catalog not activated`);
    },
  };
}

export function publishPlan({ bytes, signatureBytes, catalog, verified }) {
  const digest = sha256(bytes);
  const prefix = `catalogs/${digest}`;
  // An entry without a local copy is an unchanged historical release proven by an authenticated previous catalog.
  const remote = verified.filter((entry) => entry.path === null).length;
  const operation = (artifact, path) => path === null
    ? (isGitHub(artifact.location) ? 'remote-verification-at-execute-no-local-copy-immutable-github-release-no-r2-artifact-upload' : 'remote-verification-at-execute-no-local-copy-download-and-hash-existing-r2-object-never-uploaded')
    : (isGitHub(artifact.location) ? 'verify-existing-immutable-github-release-no-r2-artifact-upload' : 'conditional-create-then-download-and-hash');
  return { mode: 'dry-run', networkRequests: 0, credentialAccess: false, artifacts: verified.map(({ artifact, key, path }) => ({ key, bytes: artifact.bytes, sha256: artifact.sha256, operation: operation(artifact, path), publicVerification: { location: artifact.location, operation: 'required-download-and-hash-before-activation', timeoutMs: 60_000, redirects: isGitHub(artifact.location) ? 'one-github-asset-cdn-redirect-only' : 'rejected' } })), metadata: [`${prefix}/catalog.json`, `${prefix}/catalog.json.sig`, `${prefix}/SHA256SUMS`], activation: { key: 'catalog/v1.json', operation: 'single atomic signed-envelope PUT after every R2 artifact, public download and metadata object verifies', existingCatalog: 'authenticated before compare-and-swap' }, catalogSha256: digest, signatureBytes: signatureBytes.length, publishedReleases: catalog.releases.filter((r) => r.status === 'published').length, ...(remote ? { artifactsWithoutLocalCopy: remote, historicalAuthority: 'execute requires --previous to be byte-identical to the authenticated active catalog, or uses that catalog when --previous is absent, and refuses any artifact it does not prove unchanged' } : {}) };
}
export async function readActiveCatalog(transport, publicKey) {
  const active = await transport.get('catalog/v1.json');
  if (!active) return { active: null, catalog: { schemaVersion: 1, releases: [] }, bytes: null };
  invariant(active.etag && /^"[^"\r\n]+"$/.test(active.etag), 'Active catalog has no usable ETag');
  const envelope = JSON.parse(active.bytes);
  invariant(envelope.schemaVersion === 1 && Object.keys(envelope).sort().join(',') === 'catalogBase64,schemaVersion,signatureBase64', 'Invalid active catalog envelope');
  invariant(typeof envelope.catalogBase64 === 'string' && typeof envelope.signatureBase64 === 'string', 'Invalid active catalog encoding');
  const bytes = Buffer.from(envelope.catalogBase64, 'base64');
  const catalog = verifyCatalogSignature(bytes, Buffer.from(envelope.signatureBase64, 'base64'), publicKey);
  return { active, catalog, bytes };
}
export async function publishVerified({ bytes, signatureBytes, catalog, verified, publicKey, sums, previousCatalogBytes }, transport, verifyPublicArtifact) {
  invariant(transport, 'An explicit transport is required');
  invariant(typeof verifyPublicArtifact === 'function', 'An explicit public download verifier is required before any release operation');
  // Authenticate active history before any mutation. No existing catalog is also a valid first release.
  const { active, catalog: prior, bytes: priorBytes } = await readActiveCatalog(transport, publicKey);
  assertCatalogTransition(prior, catalog);
  // An operator-supplied --previous is only a cross-check: the authenticated active catalog is the history.
  if (previousCatalogBytes) invariant(priorBytes?.equals(previousCatalogBytes), '--previous must be byte-identical to the authenticated active catalog; catalog not activated');
  async function immutable(key, data, expected) {
    const exists = await transport.head(key);
    if (exists) invariant(exists.bytes === expected.bytes, 'Immutable version already exists with different bytes; choose a new version/build');
    else await transport.put(key, data, { none: true });
    // A matching ETag or stored checksum is not enough: read actual uploaded bytes.
    await transport.verify(key, expected);
  }
  // Every signed artifact needs a verified local copy or proof that it is an unchanged historical release.
  // This runs before any upload; the signed catalog, not the caller's list, decides what is expected.
  const unchanged = unchangedHistory(prior, catalog);
  const entries = new Map(verified.map((entry) => [entry.key, entry]));
  const remoteOnly = [];
  for (const release of catalog.releases) {
    if (release.status === 'withdrawn') continue;
    for (const artifact of release.artifacts) {
      const key = artifactKey(artifact, release);
      const entry = entries.get(key);
      invariant(entry, `Artifact ${key} was not verified; catalog not activated`);
      if (entry.path !== null) continue;
      invariant(unchanged.has(releaseId(release)), `Artifact ${key} has no local copy and is not an unchanged release in the authenticated active catalog; catalog not activated`);
      remoteOnly.push({ key, artifact });
    }
  }
  // Historical R2 objects are never uploaded without a local copy: read the stored bytes and compare them
  // with the signed size and SHA-256. A missing object stops the release before anything is written.
  for (const { key, artifact } of remoteOnly) {
    if (isGitHub(artifact.location)) continue; // Immutable-release checks and the public download below cover it.
    const exists = await transport.head(key);
    invariant(exists, `Historical artifact ${key} is not in the release bucket and has no local copy; supply the verified local copy and rerun; catalog not activated`);
    invariant(exists.bytes === artifact.bytes, `Historical artifact ${key} in the release bucket differs from the signed catalog; catalog not activated`);
    await transport.verify(key, { bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  for (const entry of verified) {
    if (entry.path === null) continue;
    const latest = await fileInfo(entry.path);
    invariant(latest.sha256 === entry.artifact.sha256 && latest.bytes === entry.artifact.bytes, 'Local artifact changed after validation');
    if (!isGitHub(entry.artifact.location)) await immutable(entry.key, { file: entry.path, payloadHash: latest.sha256, length: latest.bytes }, latest);
  }
  // Storage success does not establish that DNS/custom-domain/CDN delivery works.
  // Check every non-withdrawn catalog URL, not merely newly uploaded artifacts.
  for (const release of catalog.releases) {
    if (release.status === 'withdrawn') continue;
    for (const artifact of release.artifacts) await verifyPublicArtifact(artifact.location, { bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  const prefix = `catalogs/${sha256(bytes)}`;
  const metadata = [['catalog.json', bytes, 'application/json'], ['catalog.json.sig', signatureBytes, 'application/octet-stream'], ['SHA256SUMS', Buffer.from(sums), 'text/plain']];
  for (const [name, payload, contentType] of metadata) await immutable(`${prefix}/${name}`, { bytes: payload, payloadHash: sha256(payload), contentType }, { bytes: payload.length, sha256: sha256(payload) });
  // One object carries both exact signed bytes and signature: readers cannot observe a mixed pair.
  const envelope = jsonBytes({ schemaVersion: 1, catalogBase64: bytes.toString('base64'), signatureBase64: signatureBytes.toString('base64') });
  await transport.put('catalog/v1.json', { bytes: envelope, payloadHash: sha256(envelope), contentType: 'application/json' }, active ? { etag: active.etag } : { none: true });
  await transport.verify('catalog/v1.json', { bytes: envelope.length, sha256: sha256(envelope) });
  return { mode: 'executed', activated: true, catalogSha256: sha256(bytes) };
}
