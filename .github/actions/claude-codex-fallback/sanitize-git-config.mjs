#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

// The authenticated action supplies an attested absolute Git path. Keep the
// local fallback only for unit tests and non-CI callers.
const configuredGit = process.env.CODEX_SANITIZER_GIT || 'git';

function gitConfig(args, cwd, { allowMissing = false } = {}) {
  try {
    const configArgs = args[0] === 'config' && !args.includes('--no-includes')
      ? ['config', '--no-includes', ...args.slice(1)]
      : args;
    return execFileSync(configuredGit, configArgs, {
      cwd,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (allowMissing && (error?.status === 1 || error?.status === 5)) return Buffer.alloc(0);
    const timeout = error?.code === 'ETIMEDOUT' || error?.signal === 'SIGKILL' ? ', timed out' : '';
    throw new Error(`git config operation failed (exit ${error?.status ?? 'unknown'}${timeout})`);
  }
}

/** Remove URL userinfo without ever writing the original value to stdout. */
export function sanitizeRemoteUrl(raw) {
  const value = String(raw);
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // Also cover scp-style remotes (`user@host:path`), which URL cannot
    // parse. The username is never needed to identify a GitHub remote.
    return value
      .replace(/:\/\/[^\/@\s]+@/, '://')
      .replace(/^[^/@\s:]+@([^:\s]+:)/, '$1');
  }
}

function parseNullRecords(buffer) {
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  return records.map((record) => {
    const separator = record.indexOf('\n');
    if (separator < 1) throw new Error('unexpected git config record format');
    return { key: record.slice(0, separator), value: record.slice(separator + 1) };
  });
}

/**
 * Remove persisted checkout credentials from local Git config before Codex
 * can read it. The host-side Git bridge supplies the explicit caller identity
 * for network operations after this function completes.
 */
export function sanitizeGitConfig({ cwd = process.cwd() } = {}) {
  const remoteRecords = parseNullRecords(gitConfig([
    'config', '--local', '--null', '--get-regexp', '^remote\\..*\\.url$',
  ], cwd, { allowMissing: true }));
  for (const { key, value } of remoteRecords) {
    const clean = sanitizeRemoteUrl(value);
    if (!clean) throw new Error('empty sanitized Git remote URL');
    if (clean !== value) {
      gitConfig(['config', '--local', '--unset-all', key], cwd, { allowMissing: true });
      gitConfig(['config', '--local', '--add', key, clean], cwd);
    }
  }

  // A clean-looking pushurl can still redirect a host-side push, and local
  // Git config can execute helpers or select a proxy/CA before the bridge sees
  // the request. Read with --no-includes, then remove every network- or
  // execution-affecting key (including http.extraheader). The bridge supplies its own fixed remote, HTTPS
  // header, true SSL verification, and empty helpers from an isolated env.
  const dangerousPatterns = [
    '^url\\..*(insteadof|pushinsteadof)$',
    '^remote\\..*\\.(pushurl|uploadpack|receivepack|proxy)$',
    '^http\\..*',
    '^credential(\\..*)?$',
    '^include.*',
    '^core\\.(hookspath|sshcommand|gitproxy|fsmonitor|editor|pager)$',
    '^filter\\..*\\.(process|clean|smudge)$',
    '^diff\\..*\\.(textconv|external)$',
    '^merge\\..*\\.driver$',
    '^mergetool\\..*\\.cmd$',
    '^pager\\..*',
  ];
  const dangerousKeys = new Set();
  for (const pattern of dangerousPatterns) {
    for (const { key } of parseNullRecords(gitConfig([
      'config', '--local', '--null', '--get-regexp', pattern,
    ], cwd, { allowMissing: true }))) {
      dangerousKeys.add(key);
    }
  }
  for (const key of dangerousKeys) {
    gitConfig(['config', '--local', '--unset-all', key], cwd, { allowMissing: true });
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  sanitizeGitConfig();
}
