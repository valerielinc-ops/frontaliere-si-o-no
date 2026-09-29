#!/usr/bin/env node

/**
 * Check a materialized accumulator before a workflow commits it.
 *
 * The post-push guard compares committed trees. Writers can stop the same
 * destructive transition earlier, while the bad bytes are still in the
 * working tree. A missing file is treated as zero bytes when it existed at
 * HEAD, so an accidental deletion is fail-closed at the same boundary.
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
  return stderr.includes(`Not a valid object name ${ref}:${filePath}`)
    || stderr.includes(`does not exist in '${ref}'`);
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

const filePaths = process.argv.slice(2);
if (process.argv[1]?.endsWith('assert-accumulator-write.mjs')) {
  if (filePaths.length === 0) {
    console.error('usage: assert-accumulator-write.mjs <file> [file ...]');
    process.exitCode = 2;
  } else {
    for (const filePath of filePaths) assertAccumulatorFileWrite(filePath);
  }
}
