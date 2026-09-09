// Release catalog v1. Keep this dependency-free module identical in all consumers.
export const CATALOG_VERSION = 1;
export const HELPER_REPOSITORY = 'https://github.com/anondotinc/network-guard';
export const HELPER_RELEASES = `${HELPER_REPOSITORY}/releases`;
export const helperReleaseTag = (release) => `v${release.version}-${release.buildId}`;
export const helperArtifactUrl = (release, filename) => `${HELPER_RELEASES}/download/${helperReleaseTag(release)}/${filename}`;
export function helperReleasePage(release, artifact) {
  return release.product === 'network-helper' && artifact.location === helperArtifactUrl(release, artifact.filename)
    ? `${HELPER_RELEASES}/tag/${helperReleaseTag(release)}` : undefined;
}
const hex = /^[0-9a-f]{64}$/;
const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const file = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, required, optional = []) => plain(v)
  && required.every((key) => Object.hasOwn(v, key))
  && Object.keys(v).every((key) => [...required, ...optional].includes(key));
const text = (v, max = 1000) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const utc = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');

/** Returns all bounded, non-sensitive validation errors. Does not fetch URLs. */
export function validateCatalog(catalog) {
  const errors = [];
  const fail = (path, reason) => { if (errors.length < 100) errors.push(`${path}: ${reason}`); };
  if (!exact(catalog, ['schemaVersion', 'releases']) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.releases) || catalog.releases.length > 500) {
    return { valid: false, errors: ['catalog: expected schemaVersion 1 and releases array (maximum 500)'] };
  }
  const ids = new Set();
  const locations = new Set();
  catalog.releases.forEach((r, i) => {
    const p = `releases[${i}]`;
    if (!exact(r, ['product', 'version', 'buildId', 'releasedAt', 'channel', 'status', 'notes', 'artifacts'], ['source'])) { fail(p, 'unexpected or missing fields'); return; }
    if (!['android', 'network-helper', 'desktop'].includes(r.product)) fail(p, 'unsupported product');
    if (typeof r.version !== 'string' || !token.test(r.version) || r.version.includes('..')) fail(p, 'invalid version');
    if (typeof r.buildId !== 'string' || !token.test(r.buildId) || r.buildId.includes('..')) fail(p, 'invalid buildId');
    if (!utc(r.releasedAt)) fail(p, 'releasedAt must be an actual ISO UTC timestamp');
    if (!['test', 'stable'].includes(r.channel) || !['unreleased', 'published', 'withdrawn'].includes(r.status)) fail(p, 'invalid channel or status');
    if (r.product === 'desktop' && r.status !== 'unreleased') fail(p, 'desktop is unavailable in catalog v1');
    if (!Array.isArray(r.notes) || r.notes.length > 30 || r.notes.some((n) => !text(n))) fail(p, 'invalid release notes');
    const id = `${r.product}/${r.version}/${r.buildId}`;
    if (ids.has(id)) fail(p, 'duplicate immutable release identity');
    ids.add(id);
    if (Object.hasOwn(r, 'source')) {
      if (!exact(r.source, ['repository', 'commit']) || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.source.repository) || !/^[0-9a-f]{40}$/.test(r.source.commit)) fail(p, 'invalid verified source provenance');
    }
    if (!Array.isArray(r.artifacts) || r.artifacts.length > 10 || (r.status === 'published' && !r.artifacts.length)) { fail(p, 'invalid artifacts'); return; }
    const architectures = new Set();
    r.artifacts.forEach((a, j) => {
      const ap = `${p}.artifacts[${j}]`;
      if (!exact(a, ['platform', 'architecture', 'minimumOs', 'filename', 'bytes', 'sha256', 'signing', 'location'])) { fail(ap, 'unexpected or missing fields'); return; }
      if (!['android', 'macos'].includes(a.platform) || (r.product === 'android') !== (a.platform === 'android')) fail(ap, 'platform does not match product');
      if (!['universal', 'arm64', 'x86_64', ...(r.product === 'android' ? ['arm64-x86_64'] : [])].includes(a.architecture)) fail(ap, 'unsupported architecture');
      if (architectures.has(`${a.platform}/${a.architecture}`)) fail(ap, 'duplicate architecture');
      architectures.add(`${a.platform}/${a.architecture}`);
      if (!text(a.minimumOs, 80)) fail(ap, 'invalid minimumOs');
      if (typeof a.filename !== 'string' || !file.test(a.filename) || a.filename.includes('..') || !(r.product === 'android' ? a.filename.endsWith('.apk') : a.filename.endsWith('.zip'))) fail(ap, 'invalid filename');
      if (!Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > 536870912) fail(ap, 'invalid size (maximum 512 MiB)');
      if (typeof a.sha256 !== 'string' || !hex.test(a.sha256)) fail(ap, 'invalid SHA-256');
      const expected = `https://downloads.anon.inc/${id}/${a.filename}`;
      if (a.location !== expected && !(r.product === 'network-helper' && a.location === helperArtifactUrl(r, a.filename))) fail(ap, 'location must match the versioned R2 path or official helper GitHub release asset');
      if (locations.has(a.location)) fail(ap, 'duplicate artifact location');
      locations.add(a.location);
      if (r.product === 'android') {
        if (!exact(a.signing, ['kind', 'certificateSha256', 'packageName']) || a.signing.kind !== 'android' || !hex.test(a.signing.certificateSha256) || a.signing.packageName !== 'com.ahloop.anon') fail(ap, 'invalid verified Android identity');
      } else if (!exact(a.signing, ['kind', 'teamId', 'identity', 'notarized']) || a.signing.kind !== 'apple-developer-id' || !/^[A-Z0-9]{10}$/.test(a.signing.teamId) || !text(a.signing.identity, 200) || !a.signing.identity.startsWith('Developer ID Application: ') || !a.signing.identity.endsWith(`(${a.signing.teamId})`) || a.signing.notarized !== true) fail(ap, 'a Developer ID Application identity and notarization are required');
    });
  });
  return { valid: errors.length === 0, errors };
}

export function assertCatalog(catalog) {
  const result = validateCatalog(catalog);
  if (!result.valid) throw new Error(result.errors.join('\n'));
  return catalog;
}
