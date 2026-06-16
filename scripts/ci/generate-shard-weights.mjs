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
const inputs = args.filter((a, i) => a !== '--out' && i !== outIdx + 1 && !a.startsWith('--'));

if (inputs.length === 0) {
  console.error('usage: generate-shard-weights.mjs <vitest-timing.json...> [--out <path>]');
  process.exit(1);
}

/** @type {Record<string, number>} */
const weights = {};
let fileCount = 0;

for (const input of inputs) {
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const results = raw.testResults ?? [];
  for (const r of results) {
    // r.name is an absolute path; key by the repo-relative `tests/...` form
    // (matches how BalancedSequencer.relOf derives the weight lookup key).
    const m = /(?:^|\/)(tests\/.*)$/.exec(String(r.name).replace(/\\/g, '/'));
    if (!m) continue;
    const rel = m[1];
    const dur = Math.max(0, Math.round((r.endTime ?? 0) - (r.startTime ?? 0)));
    if (weights[rel] === undefined || dur > weights[rel]) {
      if (weights[rel] === undefined) fileCount++;
      weights[rel] = dur;
    }
  }
}

if (fileCount === 0) {
  console.error('no test timings found in inputs — refusing to overwrite weights');
  process.exit(1);
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
