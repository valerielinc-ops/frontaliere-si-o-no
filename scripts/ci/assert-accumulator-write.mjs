#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * Check a materialized accumulator before a workflow commits it.
 *
 * The post-push guard compares committed trees. Writers can stop the same
 * destructive transition earlier, while the bad bytes are still in the
 * working tree. A missing file is treated as zero bytes when it existed at
 * HEAD, so an accidental deletion is fail-closed at the same boundary.
 *
 * A directory argument (`data/url-first-seen/`) checks every shard of a sharded
 * accumulator, one by one, against its own blob at HEAD.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { assertAccumulatorByteFloor } from '../lib/accumulator-byte-floor-guard.mjs';

function isMissingAtRef(error, ref, filePath) {
  const stderr = Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString('utf8')
    : typeof error?.stderr === 'string'
      ? error.stderr
      : '';
  // Three spellings of "this path is not in that tree", depending on git
  // version and on whether the file exists in the working tree. The last one is
  // the case of an accumulator written for the first time (a new shard).
  return stderr.includes(`Not a valid object name ${ref}:${filePath}`)
    || stderr.includes(`does not exist in '${ref}'`)
    || stderr.includes(`exists on disk, but not in '${ref}'`);
}

export function trackedSizeAt(ref, filePath, exec = execFileSync) {
  try {
    const output = exec('git', ['cat-file', '-s', `${ref}:${filePath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const size = Number(String(output).trim());
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid git blob size for ${ref}:${filePath}: ${output}`);
    }
    return size;
  } catch (error) {
    if (isMissingAtRef(error, ref, filePath)) return null;
    throw error;
  }
}

export function materializedSize(filePath, stat = fs.statSync) {
  try {
    return Number(stat(filePath).size);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export function assertAccumulatorFileWrite(
  filePath,
  {
    ref = 'HEAD',
    candidatePath = filePath,
    exec = execFileSync,
    stat = fs.statSync,
  } = {},
) {
  const previousBytes = trackedSizeAt(ref, filePath, exec);
  const nextBytes = materializedSize(candidatePath, stat);
  if (previousBytes === null) {
    return { previousBytes: null, nextBytes, checked: false };
  }
  assertAccumulatorByteFloor(previousBytes, nextBytes, { label: filePath });
  return { previousBytes, nextBytes, checked: true };
}

/**
 * Expand directory arguments (an existing directory, or a path ending in `/`)
 * into the files of a sharded accumulator: every file in the working tree AND
 * every file tracked at `ref`. The union is what makes a shard that vanished
 * from the working tree count as zero bytes (and fail the floor) instead of
 * being skipped because there is nothing left to stat. Plain file arguments
 * pass through unchanged.
 *
 * @param {string[]} args
 * @param {{ ref?: string, exec?: typeof execFileSync, readdir?: typeof fs.readdirSync, stat?: typeof fs.statSync }} [options]
 * @returns {string[]}
 */
export function expandAccumulatorPaths(
  args,
  { ref = 'HEAD', exec = execFileSync, readdir = fs.readdirSync, stat = fs.statSync } = {},
) {
  const out = [];
  for (const arg of args) {
    const dir = arg.replace(/\/+$/, '');
    let isDirectory = arg.endsWith('/');
    if (!isDirectory) {
      try { isDirectory = stat(arg).isDirectory(); } catch { isDirectory = false; }
    }
    if (!isDirectory) { out.push(arg); continue; }
    const names = new Set();
    try {
      for (const entry of readdir(dir, { withFileTypes: true })) {
        if (entry.isFile()) names.add(`${dir}/${entry.name}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const tracked = String(exec('git', ['ls-tree', '--name-only', ref, '--', `${dir}/`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    for (const line of tracked.split('\n')) {
      if (line.trim()) names.add(line.trim());
    }
    out.push(...[...names].sort());
  }
  return out;
}

const filePaths = process.argv.slice(2);
if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  if (filePaths.length === 0) {
    console.error('usage: assert-accumulator-write.mjs <file|dir/> [file|dir/ ...]');
    process.exitCode = 2;
  } else {
    for (const filePath of expandAccumulatorPaths(filePaths)) assertAccumulatorFileWrite(filePath);
  }
}
