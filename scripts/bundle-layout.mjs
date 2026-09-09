import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

const directories = new Set(['', 'Contents', 'Contents/MacOS', 'Contents/Resources']);
const files = new Set([
  'Contents/Info.plist',
  'Contents/MacOS/AnonNetworkHelperSetup',
  'Contents/Resources/anon-network-helper',
  'Contents/Resources/payload.json',
  'Contents/Resources/LICENSE',
  'Contents/Resources/AnonNetworkGuard.icns',
  'Contents/Resources/BrandAssets-LICENSE',
]);

/** Rebuilding never adopts, ships, or deletes unrecognized output from another run. */
export function assertBuildOutput(repoRoot, appPath) {
  const root = path.resolve(repoRoot);
  const app = path.resolve(appPath);
  if (!app.startsWith(root + path.sep)) throw new Error('Setup build output must stay inside the repository.');
  let current = root;
  for (const component of path.relative(root, app).split(path.sep)) {
    current = path.join(current, component);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new Error('Setup build output contains a redirected or non-directory path. Move it aside before rebuilding.');
    }
  }
  function visit(relative) {
    const item = path.join(app, relative);
    const entry = lstatSync(item, { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isDirectory() && directories.has(relative)) {
      for (const name of readdirSync(item)) visit(relative ? `${relative}/${name}` : name);
      return;
    }
    if (entry.isFile() && files.has(relative)) return;
    throw new Error('Existing setup output contains unrecognized entries. Move it aside before rebuilding; nothing was removed.');
  }
  visit('');
}
