#!/usr/bin/env node

/**
 * Rebuild the files identified by guard-data-integrity on the latest main tip.
 *
 * The guard workflow and shared main-push helper invoke this after a restore
 * or a conflicting rebase. BEFORE and VIOLATIONS are supplied by the workflow
 * and deliberately remain environment variables so the JSON is not reparsed
 * by shell quoting.
 */

import { execFileSync } from 'node:child_process';
import { isSliceFile } from '../lib/crawler-slice-files.mjs';

const ACTIVE_CRAWLER_SLICE_PREFIX = 'data/jobs/by-crawler/';
const EXPIRED_CRAWLER_SLICE_PREFIX = 'data/jobs/expired/by-crawler/';

function normalizePath(file) {
  return String(file).replaceAll('\\', '/');
}

/**
 * Return the active/expired pair for a real crawler slice, or the original
 * path for every other guarded data file and crawler scratch companion.
 */
export function pairedRestorePaths(file) {
  const normalized = normalizePath(file);
  const prefixes = [
    [ACTIVE_CRAWLER_SLICE_PREFIX, EXPIRED_CRAWLER_SLICE_PREFIX],
    [EXPIRED_CRAWLER_SLICE_PREFIX, ACTIVE_CRAWLER_SLICE_PREFIX],
  ];

  for (const [prefix, counterpartPrefix] of prefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const basename = normalized.slice(prefix.length);
    if (!isSliceFile(basename) || basename.includes('/')) return [normalized];
    return [normalized, `${counterpartPrefix}${basename}`];
  }

  return [normalized];
}

export function restorePathsForViolations(violations) {
  const paths = new Set();
  for (const violation of violations) {
    if (!violation || typeof violation.file !== 'string' || violation.file.length === 0) {
      throw new Error('Every data-integrity violation must contain a file path');
    }
    for (const file of pairedRestorePaths(violation.file)) paths.add(file);
  }
  return [...paths];
}

function existsAt(exec, ref, file) {
  try {
    exec('git', ['cat-file', '-e', `${ref}:${file}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function restoreDataIntegrityFiles({
  before = process.env.BEFORE,
  violationsText = process.env.VIOLATIONS,
  exec = execFileSync,
} = {}) {
  if (!before || !violationsText) {
    throw new Error('BEFORE and VIOLATIONS are required to rebuild data-integrity files');
  }

  const violations = JSON.parse(violationsText);
  if (!Array.isArray(violations) || violations.length === 0) {
    throw new Error('VIOLATIONS must be a non-empty JSON array');
  }

  const violationFiles = new Set(violations.map((violation) => normalizePath(violation?.file)));
  for (const file of restorePathsForViolations(violations)) {
    // A paired slice may not exist yet at BEFORE (for example, a newly added
    // crawler). Do not invent it while restoring the pre-push state.
    if (!existsAt(exec, before, file)) {
      if (violationFiles.has(file)) {
        throw new Error(`Guard violation path is missing at BEFORE: ${file}`);
      }
      continue;
    }

    // The guard runs with a sparse checkout that excludes the large data paths.
    // Opt into the path for the restore instead of failing on its skip-worktree bit.
    exec(
      'git',
      ['checkout', '--ignore-skip-worktree-bits', before, '--', file],
      { stdio: 'inherit' },
    );
    exec('git', ['add', '--sparse', '--', file], { stdio: 'inherit' });
  }
}

if (process.argv[1]?.endsWith('restore-data-integrity-files.mjs')) {
  restoreDataIntegrityFiles();
}
