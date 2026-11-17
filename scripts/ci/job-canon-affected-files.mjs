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
const V1_RE = /^[a-z0-9_]{2}\.json$/;
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
 * Metadata updates, skips, and stats are intentionally ignored. Unlike the
 * ordinary asset purge log, this inventory is a safety gate: a malformed or
 * unrecognized record must not become an empty change set before the
 * job-canon marker is released.
 */
export function parseRcloneChangedKeys(logText) {
  const keys = new Set();
  for (const [index, line] of String(logText || '').split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`invalid rclone JSON log record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`invalid rclone JSON log record at line ${index + 1}: expected an object`);
    }
    const message = typeof entry.msg === 'string' ? entry.msg : '';
    if (!message) {
      throw new Error(`invalid rclone JSON log record at line ${index + 1}: missing msg`);
    }
    const object = entry.object === undefined ? '' : entry.object;
    if (typeof object !== 'string') {
      throw new Error(`invalid rclone JSON log record at line ${index + 1}: object is not a string`);
    }
    const changed = /\b(?:Copied|Deleted|Removed)\b/.test(message);
    if (changed) {
      if (!object) {
        throw new Error(`unrecognized rclone change record at line ${index + 1}: missing object`);
      }
      const relativePath = normalizeMapRelative(object);
      if (!relativePath) {
        throw new Error(`unrecognized job-canon object at line ${index + 1}: ${object}`);
      }
      keys.add(mapKey(relativePath));
      continue;
    }
    // Stats and other global messages normally have no object. An object
    // attached to an unknown operation is not safe to discard: it may be a
    // shard that the exact sync changed without the inventory understanding it.
    if (!object || /^(?:Unchanged skipping|Updated modification time)$/.test(message)) continue;
    throw new Error(`unrecognized rclone object record at line ${index + 1}: ${message}`);
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
  if (rcloneLog && !existsSync(rcloneLog)) {
    throw new Error(`rclone JSON log is missing: ${rcloneLog}`);
  }
  const keys = previousDir
    ? compareMapTrees(currentDir, previousDir)
    : parseRcloneChangedKeys(readFileSync(rcloneLog, 'utf8'));
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
