#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

function gitConfig(args, cwd, { allowMissing = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowMissing && (error?.status === 1 || error?.status === 5)) return Buffer.alloc(0);
    throw new Error(`git config operation failed (exit ${error?.status ?? 'unknown'})`);
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

  // A clean-looking pushurl can still redirect a host-side push. Remove all
  // pushurl and URL-rewrite entries; the bridge supplies its own fixed remote
  // and never consults this mutable local config.
  const rewriteRecords = parseNullRecords(gitConfig([
    'config', '--local', '--null', '--get-regexp', '^url\\..*\\.',
  ], cwd, { allowMissing: true })).filter(({ key }) => /\.(?:pushurl|insteadof|pushinsteadof)$/i.test(key));
  const pushUrlRecords = parseNullRecords(gitConfig([
    'config', '--local', '--null', '--get-regexp', '^remote\\..*\\.pushurl$',
  ], cwd, { allowMissing: true }));
  for (const { key } of [...rewriteRecords, ...pushUrlRecords]) {
    gitConfig(['config', '--local', '--unset-all', key], cwd, { allowMissing: true });
  }

  const headerRecords = parseNullRecords(gitConfig([
    'config', '--local', '--null', '--get-regexp', '^http\\..*\\.extraheader$',
  ], cwd, { allowMissing: true }));
  for (const { key } of headerRecords) gitConfig(['config', '--local', '--unset-all', key], cwd, { allowMissing: true });
  gitConfig(['config', '--local', '--unset-all', 'http.extraheader'], cwd, { allowMissing: true });
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  sanitizeGitConfig();
}
