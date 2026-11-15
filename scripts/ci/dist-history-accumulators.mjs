#!/usr/bin/env node
/**
 * Size guard and path allowlist for the dist-history commit job
 * (`commit-it-dist-history` in .github/workflows/deploy-publish.yml).
 *
 * That job copies the accumulators produced by the IT publisher into a sparse
 * checkout of `main`, stages them and pushes. GitHub rejects any blob over
 * 100 MiB with `GH001: Large files detected`; the 2026-11-15 run produced a
 * 213.54 MB `data/url-first-seen.json`, the push was refused five times, and the
 * `dist-size-history.jsonl` row committed next to it was lost with it, inside a
 * `continue-on-error` job that stayed green.
 *
 *   node scripts/ci/dist-history-accumulators.mjs guard --selected <file> <path>...
 *       Measures every candidate. Writes the paths that are safe to stage, one
 *       per line, to <file>. Prints one `::warning` per path past the pre-alarm
 *       and one `::error` per path past the safe limit, then exits 0 whatever it
 *       found: a path that is too big is skipped, it never blocks the others.
 *       Exits 3 (after writing <file>) when at least one path was skipped, so the
 *       caller can make the step visibly red AFTER the others were committed.
 *   node scripts/ci/dist-history-accumulators.mjs unexpected
 *       Reads repo-relative paths on stdin, prints the ones outside the
 *       allowlist, exits 1 when there is any.
 *
 * The allowlist and the shard layout come from `scripts/lib/url-first-seen-store.mjs`;
 * no prefix or shard pattern is spelled here.
 */
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isUrlFirstSeenShardRelPath } from '../lib/url-first-seen-store.mjs';

/** GitHub refuses a blob over 100 MiB (the message says "100.00 MB"). */
export const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * Stage nothing above this. 5 MiB under GitHub's limit, so a file that grows
 * between the measurement and the push still lands, and the message names the
 * problem while there is still room to act.
 */
export const ACCUMULATOR_MAX_STAGE_BYTES = 95 * 1024 * 1024;

/** Pre-alarm: GitHub itself warns above 50 MiB; this is the time to shard or prune. */
export const ACCUMULATOR_WARN_BYTES = 50 * 1024 * 1024;

export const DIST_SIZE_HISTORY_FILE = 'data/dist-size-history.jsonl';

/**
 * Repo-relative paths this job may stage. The legacy `data/url-first-seen.json`
 * is deliberately NOT here: the publisher no longer uploads it (the writer folds
 * it into the shards) and this job must never touch it.
 */
export function isAllowedDistHistoryPath(relPath) {
  return relPath === DIST_SIZE_HISTORY_FILE || isUrlFirstSeenShardRelPath(relPath);
}

/**
 * Split candidates by size. `bytes` is the measured size, `null` for a path
 * that does not exist (skipped without a message: nothing to stage).
 *
 * @param {Array<{ path: string, bytes: number | null }>} candidates
 * @param {{ maxBytes?: number, warnBytes?: number }} [limits]
 * @returns {{ stage: string[], skipped: Array<{ path: string, bytes: number }>, warned: Array<{ path: string, bytes: number }> }}
 */
export function partitionAccumulatorsBySize(
  candidates,
  { maxBytes = ACCUMULATOR_MAX_STAGE_BYTES, warnBytes = ACCUMULATOR_WARN_BYTES } = {},
) {
  const stage = [];
  const skipped = [];
  const warned = [];
  for (const { path: p, bytes } of candidates) {
    if (bytes === null) continue;
    if (bytes > maxBytes) {
      skipped.push({ path: p, bytes });
      continue;
    }
    if (bytes > warnBytes) warned.push({ path: p, bytes });
    stage.push(p);
  }
  return { stage, skipped, warned };
}

function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/** GitHub workflow commands for a partition, one line each. */
export function annotationsFor({ skipped, warned }, { maxBytes = ACCUMULATOR_MAX_STAGE_BYTES } = {}) {
  const lines = [];
  for (const { path: p, bytes } of warned) {
    lines.push(
      `::warning title=dist-history accumulator approaching GitHub file limit::${p} ${bytes} bytes (${mib(bytes)} MiB; GitHub rejects files over 100 MiB)`,
    );
  }
  for (const { path: p, bytes } of skipped) {
    lines.push(
      `::error title=dist-history accumulator over GitHub file limit::${p} ${bytes} bytes (${mib(bytes)} MiB > ${mib(maxBytes)} MiB safe limit, GitHub rejects files over 100 MiB); NOT staged, the other accumulators are still committed`,
    );
  }
  return lines;
}

function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'guard') {
    const flag = rest.indexOf('--selected');
    if (flag < 0 || !rest[flag + 1]) {
      console.error('usage: dist-history-accumulators.mjs guard --selected <file> <path>...');
      return 2;
    }
    const selectedFile = rest[flag + 1];
    const candidates = rest
      .filter((_arg, i) => i !== flag && i !== flag + 1)
      .map((p) => ({ path: p, bytes: sizeOf(p) }));
    const outside = candidates.filter((c) => !isAllowedDistHistoryPath(c.path));
    if (outside.length > 0) {
      for (const { path: p } of outside) console.error(`::error::dist-history refusing a candidate outside its allowlist: ${p}`);
      return 2;
    }
    const result = partitionAccumulatorsBySize(candidates);
    for (const line of annotationsFor(result)) console.log(line);
    fs.writeFileSync(selectedFile, result.stage.map((p) => `${p}\n`).join(''));
    console.log(
      `[dist-history] ${result.stage.length} accumulator(s) to stage, ${result.skipped.length} skipped over the size limit`,
    );
    return result.skipped.length > 0 ? 3 : 0;
  }
  if (command === 'unexpected') {
    const staged = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
    const unexpected = staged.filter((p) => !isAllowedDistHistoryPath(p));
    for (const p of unexpected) console.log(p);
    return unexpected.length > 0 ? 1 : 0;
  }
  console.error('usage: dist-history-accumulators.mjs guard|unexpected ...');
  return 2;
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  process.exitCode = main(process.argv.slice(2));
}
