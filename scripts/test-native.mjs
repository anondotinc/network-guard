#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('/usr/bin/xcrun', ['swift', 'test', '--package-path', root,
  '--disable-sandbox', '--cache-path', '.build/cache', '--config-path', '.build/config',
  '--security-path', '.build/security', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env,
    CLANG_MODULE_CACHE_PATH: path.join(root, '.build/module-cache'),
    SWIFTPM_MODULECACHE_OVERRIDE: path.join(root, '.build/module-cache'),
  },
});
if (result.error) console.error('Native test process could not start. Apple command-line tools are required.');
process.exit(result.status ?? 1);
