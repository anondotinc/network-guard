import { readFileSync } from 'node:fs';

export function parseBuildVersion(source) {
  const version = [...source.matchAll(/^    public static let version = "((?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2}))"$/gm)];
  const build = [...source.matchAll(/^    public static let build = ([1-9][0-9]{0,8})$/gm)];
  if (version.length !== 1 || build.length !== 1)
    throw new Error('BuildVersion.swift must declare one canonical numeric version and build.');
  return { version: version[0][1], build: Number(build[0][1]) };
}

export const buildVersion = parseBuildVersion(readFileSync(
  new URL('../Sources/NetworkHelperCore/BuildVersion.swift', import.meta.url), 'utf8'));
