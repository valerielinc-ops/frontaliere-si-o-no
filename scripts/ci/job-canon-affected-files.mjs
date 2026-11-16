#!/usr/bin/env node
/**
 * Derive the exact /job-canon objects whose live edge copy can have changed.
 *
 * Pages compares the current map tree with the previous CDN checkout. R2 uses
 * the rclone JSON log because the exact sync reports both copied and deleted
 * objects. The resulting keys are consumed by job-canon-publish-handshake.mjs
 * before the CDN generation marker is released.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const JOB_CANON_PREFIX = 'job-canon/';
const V1_RE = /^[0-9a-f]{2}\.json$/;
const V2_RE = /^v2\/[0-9a-f]{3}\.json$/;

function normalizeMapRelative(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const withoutPrefix = normalized.startsWith(JOB_CANON_PREFIX)
    ? normalized.slice(JOB_CANON_PREFIX.length)
    : normalized;
  if (!V1_RE.test(withoutPrefix) && !V2_RE.test(withoutPrefix)) return null;
  return withoutPrefix;
}

function mapKey(relativePath) {
  return `${JOB_CANON_PREFIX}${relativePath}`;
}

function walkMapTree(rootDir) {
  const files = new Map();
  if (!existsSync(rootDir)) return files;
  const walk = (absoluteDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolutePath = join(absoluteDir, entry.name);
      const rel = relative(rootDir, absolutePath).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        throw new Error(`job-canon tree contains a symlink: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = normalizeMapRelative(rel);
      if (!normalized) {
        throw new Error(`unexpected job-canon file: ${rel}`);
      }
      files.set(normalized, readFileSync(absolutePath));
    }
  };
  walk(rootDir);
  return files;
}

/**
 * Return map keys whose bytes differ between two CDN trees, including files
 * added to or removed from either tree.
 */
export function compareMapTrees(currentDir, previousDir) {
  const current = walkMapTree(currentDir);
  const previous = walkMapTree(previousDir);
  const keys = new Set([...current.keys(), ...previous.keys()]);
  return [...keys]
    .filter((key) => {
      const currentBytes = current.get(key);
      const previousBytes = previous.get(key);
      return !currentBytes || !previousBytes || !currentBytes.equals(previousBytes);
    })
    .sort()
    .map(mapKey);
}

/**
 * Parse an rclone --use-json-log file for map copies and deletions.
 * Metadata updates and stats are intentionally ignored.
 */
export function parseRcloneChangedKeys(logText) {
  const keys = new Set();
  for (const line of String(logText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = typeof entry?.msg === 'string' ? entry.msg : '';
    const object = typeof entry?.object === 'string' ? entry.object : '';
    if (!object || !/\b(?:Copied|Deleted|Removed)\b/.test(message)) continue;
    const relativePath = normalizeMapRelative(object);
    if (relativePath) keys.add(mapKey(relativePath));
  }
  return [...keys].sort();
}

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const currentDir = flags['current-dir'];
  const output = flags.output;
  if (!currentDir || !output) throw new Error('usage: --current-dir=<dir> --output=<file> [--previous-dir=<dir> | --rclone-log=<file>]');
  const previousDir = flags['previous-dir'];
  const rcloneLog = flags['rclone-log'];
  if (Boolean(previousDir) === Boolean(rcloneLog)) {
    throw new Error('provide exactly one of --previous-dir or --rclone-log');
  }
  const keys = previousDir
    ? compareMapTrees(currentDir, previousDir)
    : parseRcloneChangedKeys(rcloneLog && existsSync(rcloneLog) ? readFileSync(rcloneLog, 'utf8') : '');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, keys.length ? `${keys.join('\n')}\n` : '', 'utf8');
  console.log(`job-canon affected objects: ${keys.length}`);
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::job-canon affected-file inventory failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
