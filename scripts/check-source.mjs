#!/usr/bin/env node
// Small publication tripwire, not a substitute for secret scanning or review.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateKeyMarker = new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----');
const tokenPatterns = [
  privateKeyMarker,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];

export function pathIssues(name) {
  const issues = [];
  if (/(?:^|\/)(?:\.build|dist|out|node_modules|\.DS_Store)(?:\/|$)/.test(name)
    || /\.(?:apk|aab|zip|dmg|pkg|app|log|xcuserstate)(?:\/|$)/i.test(name)) {
    issues.push('generated artifact');
  }
  if (/(?:^|\/)\.env(?:\.|$)/.test(name)
    || /\.(?:pem|p12|pfx|key|jks|keystore|mobileprovision)$/i.test(name)) {
    issues.push('credential file');
  }
  return issues;
}

export function contentIssues(text) {
  const issues = [];
  if (tokenPatterns.some(pattern => pattern.test(text))) issues.push('possible credential');
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)) issues.push('personal checkout path');
  return issues;
}

// Check ordinary inline Markdown links used by this repository, without making
// network requests. Anchor targets and remote link availability need review.
export function localLinkIssues(name, text, hasFile) {
  const issues = [];
  for (const match of text.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    let destination;
    try { destination = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
    catch { issues.push('invalid local documentation link'); continue; }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), destination));
    if (destination.startsWith('/') || resolved === '..' || resolved.startsWith('../') || !hasFile(resolved)) {
      issues.push('missing or out-of-repository documentation link');
    }
  }
  return [...new Set(issues)];
}

export function checkSource(repositoryRoot = root) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).split('\0').filter(Boolean);
  const findings = [];
  let checked = 0;
  for (const name of names) {
    const absolute = path.join(repositoryRoot, name);
    // A tracked deletion is absent from the next commit.
    if (!existsSync(absolute)) continue;
    checked++;
    const report = category => findings.push({ file: name, category });
    pathIssues(name).forEach(report);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) { report('unexpected symlink or non-file'); continue; }
    if (stat.size > 1024 * 1024) { report('oversized source file'); continue; }
    const bytes = readFileSync(absolute);
    if (name === 'assets/AnonIcon.png') continue; // Separately licensed brand asset.
    if (bytes.includes(0)) { report('unexpected binary'); continue; }
    const text = bytes.toString('utf8');
    contentIssues(text).forEach(report);
    if (name.endsWith('.md')) {
      localLinkIssues(name, text, candidate => existsSync(path.join(repositoryRoot, candidate))).forEach(report);
    }
  }
  return { checked, findings };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { checked, findings } = checkSource();
    if (findings.length) {
      // Report categories only; never print matching credentials or file contents.
      for (const finding of findings) console.error(JSON.stringify(finding));
      process.exitCode = 1;
    } else {
      console.log(`Source hygiene passed (${checked} files); no network requests. This is not a security audit.`);
    }
  } catch {
    console.error('Source hygiene could not inspect the Git working tree.');
    process.exitCode = 1;
  }
}
