/**
 * `part-NN.json` shard naming — the ONE place this convention lives
 * (AGENTS.md #6: a regex/literal duplicated in ≥2 files must be extracted into
 * a shared module so drift is impossible by construction).
 *
 * Two committed accumulators are stored as a fixed set of plain-JSON shards
 * after each outgrew GitHub's hard 100 MB per-file push limit:
 *  - `data/seo-404-compat/part-NN.json`      → scripts/lib/compat-paths-store.mjs (#2988)
 *  - `data/all-known-job-slugs/part-NN.json` → scripts/lib/all-known-job-slugs-store.mjs (#4248)
 *
 * Both discover their shards by listing a directory and filtering on the file
 * name, and both mint file names by zero-padding the shard index. Those two
 * halves have to agree EXACTLY — a writer that emits `part-7.json` while the
 * reader only matches `part-07.json` loses a thirty-second of an accumulator
 * that nothing can rebuild, and it loses it silently (both stores return an
 * empty set on a miss rather than throwing). Keeping the pattern and the
 * formatter in one module makes that mismatch unrepresentable.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Matches a shard file name, e.g. `part-00.json`. */
export const SHARD_FILE_RE = /^part-\d+\.json$/;

/** File name for shard `i`, zero-padded to two digits: `part-07.json`. */
export function shardFileName(i) {
  return `part-${String(i).padStart(2, '0')}.json`;
}

/**
 * Existing shard files in `dir` (absolute paths, sorted), or `[]` when the
 * directory is absent. Never throws — an absent store is a normal state during
 * a fresh clone or mid-migration.
 */
export function listShardFilesIn(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => SHARD_FILE_RE.test(f));
  } catch {
    return [];
  }
  names.sort();
  return names.map((n) => path.join(dir, n));
}
