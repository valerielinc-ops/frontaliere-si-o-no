#!/usr/bin/env node
/**
 * Regenerate tests/shard-weights.json from vitest per-file timing JSON(s).
 *
 * The LPT BalancedSequencer (vitest.config.ts) splits `--shard=i/N` by these
 * weights. They must reflect REAL CI durations: a dev box runs the CPU-bound
 * source-scan guards ~3-10× slower under contention, so local timings
 * over-weight them and the partition mis-balances on CI.
 *
 * Inputs: one or more vitest json-reporter files (`--reporter=json
 * --outputFile=...`). tests.yml uploads one per shard as `shard-timing-<n>`
 * artifacts; the union of all N covers the whole suite. Refresh flow:
 *
 *   gh run download <run-id> -p 'shard-timing-*' -D /tmp/st
 *   node scripts/ci/generate-shard-weights.mjs /tmp/st/shard-timing-*\/*.json
 *   # commit the updated tests/shard-weights.json
 *
 * Merge policy: union across inputs; if a file appears in more than one input
 * (it shouldn't, shards are disjoint) the longest duration wins — conservative,
 * keeps the heavier observation. Output keys are repo-relative paths
 * (`tests/...`) sorted lexicographically for a stable, reviewable diff.
 *
 * Usage: node scripts/ci/generate-shard-weights.mjs <timing.json...> [--out <path>]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : 'tests/shard-weights.json';
// Exclude any `--flag`, and the value following `--out` ONLY when `--out` is
// present. The guard must be `outIdx >= 0 && i === outIdx + 1`: a bare
// `i !== outIdx + 1` drops index 0 when `--out` is absent (outIdx === -1 →
// outIdx + 1 === 0), silently discarding the first timing JSON.
const inputs = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));

if (inputs.length === 0) {
  console.error('usage: generate-shard-weights.mjs <vitest-timing.json...> [--out <path>]');
  process.exit(1);
}

// Merge onto the EXISTING weights (unless --no-merge): a shard killed by the
// 180s per-test timeout never flushes its json reporter file, so its tests are
// absent from this run's inputs. Starting from the committed weights keeps
// their last-known value instead of silently dropping them to DEFAULT_WEIGHT_MS
// in the sequencer. New observations below override. Stale keys (deleted tests)
// are harmless — the sequencer only looks up files that actually exist.
const noMerge = args.includes('--no-merge');
/** @type {Record<string, number>} */
let weights = {};
if (!noMerge && fs.existsSync(outPath)) {
  try {
    weights = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    weights = {};
  }
}

let ingested = 0; // timing entries applied from this run's inputs
let skippedNonTests = 0; // entries whose path is not under tests/ (see below)
for (const input of inputs) {
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const results = raw.testResults ?? [];
  for (const r of results) {
    // r.name is an absolute path; key by the repo-relative `tests/...` form
    // (matches how BalancedSequencer.relOf derives the weight lookup key). The
    // vitest `include` is `tests/**`, so every spec lives under tests/; an
    // entry that doesn't is counted + warned (not silently dropped) so a future
    // co-located test surfaces here instead of quietly getting DEFAULT_WEIGHT.
    const m = /(?:^|\/)(tests\/.*)$/.exec(String(r.name).replace(/\\/g, '/'));
    if (!m) {
      skippedNonTests++;
      continue;
    }
    const rel = m[1];
    const dur = Math.max(0, Math.round((r.endTime ?? 0) - (r.startTime ?? 0)));
    weights[rel] = dur; // newest observation wins
    ingested++;
  }
}

if (ingested === 0) {
  console.error('no test timings ingested from inputs — refusing to overwrite weights');
  process.exit(1);
}
if (skippedNonTests > 0) {
  console.warn(`⚠️  ${skippedNonTests} timing entr(ies) not under tests/ — not weighted (sequencer keys on tests/-relative paths)`);
}

const sorted = Object.fromEntries(
  Object.entries(weights).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(sorted)}\n`, 'utf8');

const vals = Object.values(sorted);
const total = vals.reduce((s, x) => s + x, 0);
console.log(
  `wrote ${outPath}: ${vals.length} files, total ${(total / 1000).toFixed(0)}s, ` +
    `max ${Math.max(...vals)}ms, files>10s: ${vals.filter((x) => x > 10000).length}`,
);
