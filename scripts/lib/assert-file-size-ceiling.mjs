#!/usr/bin/env node
/**
 * Commit gate for the related-search data files (#1576, #1658).
 *
 * Usage: node scripts/lib/assert-file-size-ceiling.mjs <path...>
 *
 * Exits 1 if ANY given file exceeds OUTPUT_SIZE_LIMIT_BYTES, so the caller (the
 * snapshot-jobs-weekly.yml Commit step, before `git add`) refuses to stage an
 * oversize file. This is the gate the in-writer `assertOutputSize` check could
 * not provide: the enrich step runs under `continue-on-error: true`, so its own
 * `process.exit(1)` is swallowed and the commit would otherwise stage + push the
 * bloated file anyway (the exact #1576 failure mode). Absent files are ignored
 * (nothing to stage).
 */
import { statSync } from 'node:fs';
import { OUTPUT_SIZE_LIMIT_BYTES } from './related-search-output-limit.mjs';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: assert-file-size-ceiling.mjs <path...>');
  process.exit(2);
}

const limitMb = OUTPUT_SIZE_LIMIT_BYTES / 1024 / 1024;
let oversize = false;

for (const path of paths) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    continue; // absent → nothing to stage, not an error
  }
  if (size > OUTPUT_SIZE_LIMIT_BYTES) {
    console.error(
      `❌ ${path} is ${(size / 1024 / 1024).toFixed(1)} MB, exceeding the ${limitMb} MB ` +
      `push-safety ceiling (GitHub hard limit: 100 MB — #1576). Refusing to stage. ` +
      `Prune stale entries or re-run the writer with reduced scope.`,
    );
    oversize = true;
  }
}

process.exit(oversize ? 1 : 0);
