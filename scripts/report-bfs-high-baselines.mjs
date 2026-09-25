#!/usr/bin/env node
/**
 * report-bfs-high-baselines.mjs
 *
 * Static report over `data/bfs-depth-baseline.json`: which sitemap families are
 * registered as majority-unreachable, and which of those carry a written reason
 * (#5545).
 *
 * No dist, no crawl — this reads the committed baseline only, so it runs in a
 * second anywhere. That is the point: the numbers this prints are exactly the
 * ones the per-sitemap ratchet can never comment on, because the ratchet
 * compares each shard against its own baseline and a baseline cannot fail
 * itself.
 *
 *   node scripts/report-bfs-high-baselines.mjs
 *   node scripts/report-bfs-high-baselines.mjs --baseline=data/bfs-depth-baseline.json
 *   node scripts/report-bfs-high-baselines.mjs --strict   # exit 1 on a finding
 *
 * `--strict` is what the vitest gate asserts in-process; the flag exists so a
 * workflow can reuse the same verdict without importing vitest.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HIGH_BASELINE_RATE_PCT,
  evaluateBaselineJustification,
  formatHighBaselineReport,
} from './lib/bfsBaselineJustification.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const STRICT = argv.includes('--strict');
const rel = arg('baseline', 'data/bfs-depth-baseline.json');
const path = isAbsolute(rel) ? rel : join(ROOT, rel);

const baseline = JSON.parse(await readFile(path, 'utf8'));
const verdict = evaluateBaselineJustification({ baseline });

console.log(`# BFS-depth baselines at ≥${HIGH_BASELINE_RATE_PCT}% below crawl depth — ${relative(ROOT, path)}`);
console.log(formatHighBaselineReport(verdict).join('\n'));

let failed = false;
for (const [label, rows] of [
  ['registered high WITHOUT a reason and not grandfathered', verdict.unjustified],
  ['grandfathered but WIDENED since it was frozen', verdict.widened],
  ['ledger lines that no longer describe a high entry (delete them)', verdict.staleLedger],
]) {
  if (rows.length === 0) continue;
  failed = true;
  console.log(`\n## ${rows.length} ${label}`);
  for (const r of rows) console.log(`  ${r.name}${r.ratePct == null ? '' : ` (${Number(r.ratePct).toFixed(2)}%)`}`);
}

if (!failed) console.log('\nOK — every high baseline is either justified in the JSON or on the frozen ledger.');
if (failed && STRICT) process.exit(1);
