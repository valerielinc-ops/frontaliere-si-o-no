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
const RELEASE_V1_RE = /^releases\/([0-9]{1,20})\/[a-z0-9_]{2}\.json$/;
const RELEASE_V2_RE = /^releases\/([0-9]{1,20})\/v2\/[0-9a-f]{3}\.json$/;
const MANIFEST_RE = /^(?:manifest\.json|releases\/[0-9]{1,20}\/manifest\.json)$/;

function normalizeMapRelative(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const withoutPrefix = normalized.startsWith(JOB_CANON_PREFIX)
    ? normalized.slice(JOB_CANON_PREFIX.length)
    : normalized;
  if (!V1_RE.test(withoutPrefix)
    && !V2_RE.test(withoutPrefix)
    && !RELEASE_V1_RE.test(withoutPrefix)
    && !RELEASE_V2_RE.test(withoutPrefix)) return null;
  return withoutPrefix;
}

function isManifestPath(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const withoutPrefix = normalized.startsWith(JOB_CANON_PREFIX)
    ? normalized.slice(JOB_CANON_PREFIX.length)
    : normalized;
  return MANIFEST_RE.test(withoutPrefix);
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
      // The release manifest validates the emitted map set but is not a
      // routable shard and must not enter the edge purge inventory.
      if (isManifestPath(rel)) continue;
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
export function parseRcloneChangedKeys(logText, targetPrefix = 'job-canon') {
  return parseRcloneChangedKeysForPrefix(logText, targetPrefix);
}

function parseRcloneChangedKeysForPrefix(logText, targetPrefix) {
  if (!/^job-canon(?:\/releases\/[0-9]{1,20})?$/.test(targetPrefix)) {
    throw new Error(`invalid job-canon target prefix: ${targetPrefix}`);
  }
  const targetRelative = targetPrefix.slice(JOB_CANON_PREFIX.length);
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
      const normalizedObject = String(object).replaceAll('\\', '/').replace(/^\/+/, '');
      const hasNamespacePrefix = normalizedObject.startsWith(JOB_CANON_PREFIX);
      const withoutNamespace = hasNamespacePrefix
        ? normalizedObject.slice(JOB_CANON_PREFIX.length)
        : normalizedObject;
      let relativePath;
      if (targetRelative && withoutNamespace.startsWith(`${targetRelative}/`)) {
        relativePath = withoutNamespace;
      } else if (targetRelative && hasNamespacePrefix) {
        throw new Error(`rclone change is outside expected job-canon target ${targetPrefix}: ${object}`);
      } else if (targetRelative && withoutNamespace.startsWith('releases/')) {
        throw new Error(`rclone change is outside expected job-canon target ${targetPrefix}: ${object}`);
      } else {
        relativePath = targetRelative ? `${targetRelative}/${withoutNamespace}` : withoutNamespace;
      }
      const normalizedMapPath = normalizeMapRelative(relativePath);
      if (!normalizedMapPath) {
        if (isManifestPath(relativePath)) continue;
        throw new Error(`unrecognized job-canon object at line ${index + 1}: ${object}`);
      }
      keys.add(mapKey(normalizedMapPath));
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
  const rclonePrefix = flags['rclone-prefix'] || 'job-canon';
  if (Boolean(previousDir) === Boolean(rcloneLog)) {
    throw new Error('provide exactly one of --previous-dir or --rclone-log');
  }
  if (rcloneLog && !existsSync(rcloneLog)) {
    throw new Error(`rclone JSON log is missing: ${rcloneLog}`);
  }
  const keys = previousDir
    ? compareMapTrees(currentDir, previousDir)
    : parseRcloneChangedKeysForPrefix(readFileSync(rcloneLog, 'utf8'), rclonePrefix);
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
