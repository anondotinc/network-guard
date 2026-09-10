import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Package existing Anon artwork, without downloads, rendering dependencies or
// changes to the brand. The source license ships alongside its derived icon.
export function buildIcon(root, destination) {
  const source = path.join(root, 'assets/AnonIcon.png');
  const stat = lstatSync(source);
  const png = readFileSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512)
    throw new Error('Expected the checked-in 512px Anon PNG icon.');
  const scratchRoot = path.join(root, '.build');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(scratchRoot, 'icon-'));
  const iconset = path.join(scratch, 'AnonNetworkGuard.iconset');
  mkdirSync(iconset);
  function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0)
      throw new Error(`Icon packaging failed: ${command}. ${result.stderr?.trim().slice(0, 1000) ?? ''}`);
  }
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const output = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      if (pixels === 512) copyFileSync(source, output);
      else run('/usr/bin/sips', ['-z', String(pixels), String(pixels), source, '--out', output]);
    }
  }
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', destination]);
  const icon = readFileSync(destination);
  if (icon.subarray(0, 4).toString() !== 'icns' || icon.readUInt32BE(4) !== icon.length)
    throw new Error('Generated installer icon is invalid.');
}
