import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertCatalog, assertCatalogTransition, GITHUB_RELEASE_PRODUCTS, helperArtifactUrl, R2_DOWNLOAD_ORIGINS } from './catalog.mjs';

export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (data) => Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
export function invariant(condition, message) { if (!condition) throw new Error(message); }
export function safeToken(value, name) {
  invariant(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && !value.includes('..'), `Invalid ${name}`);
  return value;
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, ...options, shell: false });
  // Never print child output on errors: signing tools can include private paths or credentials.
  invariant(!result.error && result.status === 0, `${command.split('/').at(-1)} failed${result.status === null ? ' or timed out' : ` (exit ${result.status})`}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
export async function fileInfo(path) {
  const stat = await lstat(path);
  invariant(stat.isFile() && !stat.isSymbolicLink(), 'Artifact must be a regular file, not a symbolic link');
  invariant(stat.size > 0 && stat.size <= MAX_ARTIFACT_BYTES, 'Artifact must be between 1 byte and 512 MiB');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: stat.size, sha256: hash.digest('hex') };
}
export async function writeNew(path, contents, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { flag: 'wx', mode });
}
export async function copyNew(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
}
export function artifactKey(artifact, release) {
  if (GITHUB_RELEASE_PRODUCTS.includes(release?.product) && artifact.location === helperArtifactUrl(release, artifact.filename)) {
    safeToken(release.version, 'version'); safeToken(release.buildId, 'buildId');
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(artifact.filename) && !artifact.filename.includes('..'), 'Unsafe artifact filename');
    // The same product/version/build/file shape as an R2 key, so a GitHub-hosted asset stages at one path.
    return `${release.product}/${release.version}/${release.buildId}/${artifact.filename}`;
  }
  const origin = R2_DOWNLOAD_ORIGINS.find((value) => typeof artifact.location === 'string' && artifact.location.startsWith(`${value}/`));
  invariant(origin, 'Unexpected artifact location');
  const key = artifact.location.slice(origin.length + 1);
  invariant(/^[A-Za-z0-9._/-]+$/.test(key), 'Unexpected artifact location');
  invariant(key.split('/').length === 4 && !key.split('/').some((s) => !s || s === '.' || s.includes('..')), 'Unsafe artifact key');
  return key;
}
export async function localArtifact(root, artifact, release) {
  const base = await realpath(root);
  const candidate = resolve(base, artifactKey(artifact, release));
  const actual = await realpath(candidate);
  const rel = relative(base, actual);
  invariant(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Artifact escapes output directory');
  invariant(actual === candidate, 'Artifact paths may not contain symbolic links');
  return candidate;
}
export const releaseId = (release) => `${release.product}/${release.version}/${release.buildId}`;
/**
 * Identities of the non-withdrawn releases in `catalog` that `previous` already proves unchanged:
 * same identity, with artifacts, releasedAt and channel identical (the comparison publish applies to
 * the active catalog). `previous` MUST already be authenticated against a trusted public key.
 */
export function unchangedHistory(previous, catalog) {
  const before = new Map(previous.releases.map((release) => [releaseId(release), release]));
  const unchanged = new Set();
  for (const release of catalog.releases) {
    const prior = before.get(releaseId(release));
    if (release.status === 'withdrawn' || !prior) continue;
    // Any difference, including a reactivated withdrawal, only means "not history": a local copy is required.
    try { assertCatalogTransition({ schemaVersion: 1, releases: [prior] }, { schemaVersion: 1, releases: [release] }); } catch { continue; }
    unchanged.add(releaseId(release));
  }
  return unchanged;
}
async function hasLocalCopy(root, key) {
  const base = await realpath(root);
  try { await lstat(resolve(base, key)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
/**
 * Hash every non-withdrawn artifact of `catalog` against its local copy under `root`.
 * `previous` (an authenticated earlier catalog) excuses only a MISSING copy of an unchanged release;
 * such entries have `path: null`. A copy that is present is always verified. `deferMissing` returns every
 * missing copy as `path: null` for a caller that proves history itself later (publish --execute does,
 * from the authenticated active catalog, before any mutation).
 */
export async function verifyArtifacts(catalog, root, { previous, deferMissing = false } = {}) {
  assertCatalog(catalog);
  const historical = previous ? unchangedHistory(previous, catalog) : new Set();
  const verified = [];
  for (const release of catalog.releases) {
    // Withdrawn files may have been removed from the server; they have no download action.
    if (release.status === 'withdrawn') continue;
    for (const artifact of release.artifacts) {
      const key = artifactKey(artifact, release);
      if ((previous || deferMissing) && !await hasLocalCopy(root, key)) {
        invariant(deferMissing || historical.has(releaseId(release)), `Artifact ${key} has no local copy and is not an unchanged release in the authenticated previous catalog`);
        verified.push({ release, artifact, path: null, key });
        continue;
      }
      const path = await localArtifact(root, artifact, release);
      const info = await fileInfo(path);
      invariant(info.bytes === artifact.bytes && info.sha256 === artifact.sha256, `Artifact integrity mismatch: ${artifact.filename}`);
      verified.push({ release, artifact, path, key });
    }
  }
  return verified;
}
export function checksumText(catalog) {
  return catalog.releases.flatMap((r) => r.status === 'withdrawn' ? [] : r.artifacts.map((a) => `${a.sha256}  ${artifactKey(a, r)}\n`)).sort().join('');
}
export function parseCatalog(bytes) {
  invariant(bytes.length <= 2 * 1024 * 1024, 'Catalog exceeds 2 MiB');
  return assertCatalog(JSON.parse(bytes.toString('utf8')));
}
export function ed25519Public(key) {
  const parsed = createPublicKey(key);
  invariant(parsed.asymmetricKeyType === 'ed25519', 'An Ed25519 public key is required');
  return parsed;
}
export function signCatalog(bytes, pem) {
  parseCatalog(bytes);
  const key = createPrivateKey(pem);
  invariant(key.asymmetricKeyType === 'ed25519', 'An Ed25519 private key is required');
  return sign(null, bytes, key);
}
export function verifyCatalogSignature(bytes, signature, publicKey) {
  invariant(signature.length === 64, 'Detached signature must contain exactly 64 raw bytes');
  const key = ed25519Public(publicKey);
  invariant(verify(null, bytes, key, signature), 'Catalog signature verification failed');
  // Authenticate exact bytes before parsing untrusted JSON.
  return parseCatalog(bytes);
}
export async function loadVerifiedCatalog({ catalog, signature, publicKey, artifacts, previous, deferMissing }) {
  const bytes = await readFile(catalog);
  const signatureBytes = await readFile(signature);
  const parsed = verifyCatalogSignature(bytes, signatureBytes, await readFile(publicKey));
  const verified = artifacts ? await verifyArtifacts(parsed, artifacts, { previous, deferMissing }) : [];
  return { bytes, signatureBytes, catalog: parsed, verified };
}
export function parseArgs(argv, { values = [], booleans = [] } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    invariant(argv[i].startsWith('--'), 'Options must use --name value syntax');
    const key = argv[i].slice(2);
    invariant(!Object.hasOwn(args, key), `Duplicate option --${key}`);
    if (booleans.includes(key)) args[key] = true;
    else {
      invariant(values.includes(key), `Unknown option --${key}`);
      invariant(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for --${key}`);
      args[key] = argv[++i];
    }
  }
  return args;
}
export function required(args, key) { invariant(args[key], `Required: --${key}`); return args[key]; }
