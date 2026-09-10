import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumText, invariant, parseCatalog, sha256, verifyArtifacts, verifyCatalogSignature, writeNew } from './lib.mjs';

export const trustedMetadataKeyPath = fileURLToPath(new URL('./trust/anon-release-metadata.pub', import.meta.url));

export async function privateKeyOutsideRepositories(path) {
  const resolved = await realpath(path);
  invariant(resolved === resolve(path), 'Private key may not be a symlink');
  const stat = await lstat(resolved);
  invariant(stat.isFile() && stat.size <= 4096 && (stat.mode & 0o077) === 0, 'Private key must be a small regular file readable only by its owner (chmod 600)');
  let dir = dirname(resolved);
  while (true) {
    let git; try { git = await lstat(join(dir, '.git')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    invariant(!git, 'Production metadata keys must be outside every Git checkout');
    const next = dirname(dir); if (next === dir) break; dir = next;
  }
  return readFile(resolved);
}

// Resolve and match both keys before codesigning, Apple submission or uploads.
// No generated private key, private PEM, or KeyObject escapes this closure.
export async function prepareMetadataSigner({ privateKey, publicKey = trustedMetadataKeyPath }) {
  const secret = await privateKeyOutsideRepositories(privateKey);
  let key;
  try { key = createPrivateKey(secret); } finally { secret.fill(0); }
  const trusted = createPublicKey(await readFile(publicKey));
  invariant(key.asymmetricKeyType === 'ed25519' && trusted.asymmetricKeyType === 'ed25519', 'Release metadata requires Ed25519 keys, not Apple, Android or paymaster signing keys');
  const der = trusted.export({ type: 'spki', format: 'der' });
  invariant(createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(der), 'Metadata private key does not match the trusted release public key');
  const pem = trusted.export({ type: 'spki', format: 'pem' });
  return {
    publicKey: pem,
    fingerprint: sha256(der),
    sign(bytes) {
      parseCatalog(bytes);
      const signature = sign(null, bytes, key);
      verifyCatalogSignature(bytes, signature, pem);
      return signature;
    },
  };
}

export async function signMetadataBundle({ bytes, artifacts, out, signer }) {
  const catalog = parseCatalog(bytes);
  await verifyArtifacts(catalog, artifacts);
  const signature = signer.sign(bytes);
  // Exclusive directory creation prevents mixed-key/partial retries from
  // overwriting an existing bundle. Retain partial output for inspection.
  const destination = resolve(out);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  await writeNew(join(destination, 'catalog.json'), bytes);
  await writeNew(join(destination, 'catalog.json.sig'), signature);
  await writeNew(join(destination, 'SHA256SUMS'), checksumText(catalog));
  await writeNew(join(destination, 'metadata-public-key.pem'), signer.publicKey);
  return { signed: true, algorithm: 'Ed25519', catalogSha256: sha256(bytes), publicKeySpkiSha256: signer.fingerprint, activated: false };
}
