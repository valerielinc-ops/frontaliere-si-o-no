#!/usr/bin/env node
/**
 * verify-l1-equivalence.mjs
 *
 * Validates that L1 plugin refactors (precompute-cache hoists, esc() local
 * hoists) produce BYTE-IDENTICAL HTML compared to a reference dist artifact.
 *
 * Usage:
 *   node scripts/verify-l1-equivalence.mjs --baseline=path/to/baseline-dist --candidate=dist
 *   node scripts/verify-l1-equivalence.mjs --baseline=download/artifact --candidate=dist --sample=1000
 *
 * Exit:
 *   0 — every sampled file is byte-identical
 *   1 — one or more mismatches (path + first 200 byte diff printed)
 *   2 — missing dist root or fatal error
 *
 * Strategy:
 *   1. Walk both dist roots (baseline + candidate), build the set of paths
 *      present in BOTH (path = relative to dist root, comparable across
 *      runs).
 *   2. Random-sample N paths from the intersection (default 1000).
 *   3. For each: readFile both, Buffer.equals. Mismatch → record first
 *      diff position, print path + 200-byte hex around the diff.
 *
 * The bar for L1 is BYTE-IDENTICAL because the refactors should never
 * change output bytes — only the compute path producing them. Any diff
 * is a bug.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

function parseArgs() {
  const args = new Map();
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args.set(k, v ?? true);
    }
  }
  return args;
}

async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.html')) out.push(relative(root, p));
    }
  }
  return out;
}

function sampleRandom(arr, n) {
  if (arr.length <= n) return [...arr];
  const out = new Set();
  while (out.size < n) {
    out.add(arr[Math.floor(Math.random() * arr.length)]);
  }
  return [...out];
}

function firstDiffPosition(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len; // common prefix exhausted; one is prefix of the other
}

function snippet(buf, pos, radius = 50) {
  const start = Math.max(0, pos - radius);
  const end = Math.min(buf.length, pos + radius);
  return buf.subarray(start, end).toString('utf8').replace(/[\x00-\x1f\x7f]/g, '·');
}

async function main() {
  const args = parseArgs();
  const baseline = args.get('baseline');
  const candidate = args.get('candidate');
  const sampleN = Number(args.get('sample') ?? 1000);
  const verbose = args.has('verbose');

  if (!baseline || !candidate) {
    console.error('Usage: verify-l1-equivalence.mjs --baseline=<dist> --candidate=<dist> [--sample=N]');
    process.exit(2);
  }
  const bs = await stat(baseline).catch(() => null);
  const cs = await stat(candidate).catch(() => null);
  if (!bs || !bs.isDirectory()) { console.error(`baseline missing or not dir: ${baseline}`); process.exit(2); }
  if (!cs || !cs.isDirectory()) { console.error(`candidate missing or not dir: ${candidate}`); process.exit(2); }

  console.log(`[verify-l1] walking baseline ${baseline}…`);
  const baselineFiles = new Set(await walk(baseline));
  console.log(`[verify-l1] walking candidate ${candidate}…`);
  const candidateFiles = await walk(candidate);
  const intersection = candidateFiles.filter((f) => baselineFiles.has(f));
  console.log(`[verify-l1] baseline=${baselineFiles.size} candidate=${candidateFiles.length} both=${intersection.length}`);

  const sample = sampleRandom(intersection, sampleN);
  console.log(`[verify-l1] sampling ${sample.length} files…`);

  let mismatches = 0;
  let scanned = 0;
  const firstFew = [];
  for (const rel of sample) {
    const a = await readFile(join(baseline, rel));
    const b = await readFile(join(candidate, rel));
    scanned++;
    if (Buffer.compare(a, b) !== 0) {
      mismatches++;
      if (firstFew.length < 5) {
        const pos = firstDiffPosition(a, b);
        firstFew.push({ path: rel, pos, baseLen: a.length, candLen: b.length, baseSnip: snippet(a, pos), candSnip: snippet(b, pos) });
      }
    }
    if (verbose && scanned % 100 === 0) {
      console.log(`[verify-l1] progress: ${scanned}/${sample.length}`);
    }
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`[verify-l1] sampled: ${scanned}`);
  console.log(`[verify-l1] byte-identical: ${scanned - mismatches}`);
  console.log(`[verify-l1] mismatches: ${mismatches}`);
  console.log('══════════════════════════════════════════════════════════════════════');

  if (mismatches > 0) {
    console.error('\nFirst mismatches:');
    for (const f of firstFew) {
      console.error(`\n  ${f.path}`);
      console.error(`    diff at byte ${f.pos}, baseline=${f.baseLen}B, candidate=${f.candLen}B`);
      console.error(`    baseline:  …${f.baseSnip}…`);
      console.error(`    candidate: …${f.candSnip}…`);
    }
    process.exit(1);
  }
  console.log('PASS: every sampled file is byte-identical.');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify-l1-equivalence: fatal', err);
  process.exit(2);
});
