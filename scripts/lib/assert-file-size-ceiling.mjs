#!/usr/bin/env node
/**
 * Push-safety ceiling for files that grow on their own (#1576, #1658).
 *
 * CLI: node scripts/lib/assert-file-size-ceiling.mjs <path...>
 *
 * Exits 1 if ANY given file exceeds its ceiling (`sizeLimitForPath`), so the
 * caller (the snapshot-jobs-weekly.yml Commit step, before `git add`) refuses
 * to stage an oversize file. This is the gate the in-writer `assertOutputSize`
 * check could not provide: the enrich step runs under `continue-on-error: true`,
 * so its own `process.exit(1)` is swallowed and the commit would otherwise
 * stage + push the bloated file anyway (the exact #1576 failure mode). Absent
 * files are ignored (nothing to stage).
 *
 * Library: `assertByteSizeCeiling(path, bytes)` lets a writer refuse the write
 * BEFORE the bytes reach disk — the per-crawler expired archive
 * (scripts/lib/expired-jobs-archive.mjs) grows with every retired posting, and
 * a slice past GitHub's 100 MB hard limit would otherwise surface only as a
 * rejected push. No import beyond the limit table: the CLI is copied alone into
 * temporary checkouts by tests/stage-weekly-snapshot-files.test.ts.
 */
import { realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sizeLimitForPath } from './related-search-output-limit.mjs';

const MB = 1024 * 1024;

export class FileSizeCeilingError extends Error {
  constructor(path, bytes, limit) {
    super(
      `${path} would be ${(bytes / MB).toFixed(1)} MB, exceeding the ${(limit / MB).toFixed(0)} MB `
      + 'push-safety ceiling (GitHub hard limit: 100 MB — #1576). Refusing to write it. '
      + 'Prune stale entries or split the file before the writer runs again.',
    );
    this.name = 'FileSizeCeilingError';
    this.code = 'FILE_SIZE_CEILING';
    this.path = path;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** Throw FileSizeCeilingError when `bytes` would exceed the ceiling of `path`. */
export function assertByteSizeCeiling(path, bytes, limit = sizeLimitForPath(path)) {
  if (bytes > limit) throw new FileSizeCeilingError(path, bytes, limit);
}

function main(paths) {
  if (paths.length === 0) {
    console.error('usage: assert-file-size-ceiling.mjs <path...>');
    return 2;
  }
  let oversize = false;
  for (const path of paths) {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      continue; // absent → nothing to stage, not an error
    }
    try {
      assertByteSizeCeiling(path, size);
    } catch (error) {
      if (!(error instanceof FileSizeCeilingError)) throw error;
      console.error(`❌ ${error.message.replace(' would be ', ' is ')}`);
      oversize = true;
    }
  }
  return oversize ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
