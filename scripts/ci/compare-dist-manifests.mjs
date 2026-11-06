#!/usr/bin/env node
/**
 * Matrix-vs-monolith equivalence gate.
 *
 * Recompose the per-locale shard manifests into ONE set (their union = what the
 * sharded deploy ships across all repos) and diff it, byte-for-byte (sha256),
 * against the monolith manifest built from the SAME commit + SAME data snapshot.
 *
 * They MUST be identical: same source + same jobs.json + same templates ⇒ same
 * pages. Any difference is either a real cross-locale-coupling bug in the matrix
 * render-skip, or undeclared non-determinism — both worth failing on.
 *
 * Usage:
 *   node scripts/ci/compare-dist-manifests.mjs <monolith.txt> <shard1.txt> [shard2.txt ...]
 *
 * Exit 0 only when recomposed === monolith. Exit 1 + a categorized report
 * (only-in-monolith / only-in-matrix / content-mismatch) otherwise.
 */
import fs from 'node:fs';

const [monolithFile, ...shardFiles] = process.argv.slice(2);
if (!monolithFile || shardFiles.length === 0) {
  console.error('usage: compare-dist-manifests.mjs <monolith.txt> <shard1.txt> [shard2.txt ...]');
  process.exit(2);
}

/** Parse a manifest file → Map<relpath, sha256>. */
function load(file) {
  const m = new Map();
  const txt = fs.readFileSync(file, 'utf-8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf('  ');
    if (sp < 0) continue;
    m.set(line.slice(sp + 2), line.slice(0, sp));
  }
  return m;
}

const monolith = load(monolithFile);

// Recompose: union of all shard manifests. A path SHOULD appear in exactly one
// shard (the it/main shard owns root+shared; en/de/fr own their subtree). If the
// same path appears in 2 shards with DIFFERENT hashes, that's itself a bug.
const matrix = new Map();
const dupConflicts = [];
for (const f of shardFiles) {
  for (const [rel, hash] of load(f)) {
    const prev = matrix.get(rel);
    if (prev !== undefined && prev !== hash) {
      dupConflicts.push(rel);
    }
    matrix.set(rel, hash);
  }
}

const onlyMonolith = [];
const onlyMatrix = [];
const mismatch = [];

for (const [rel, h] of monolith) {
  const mh = matrix.get(rel);
  if (mh === undefined) onlyMonolith.push(rel);
  else if (mh !== h) mismatch.push(rel);
}
for (const rel of matrix.keys()) {
  if (!monolith.has(rel)) onlyMatrix.push(rel);
}

const sample = (arr, n = 25) => arr.slice(0, n).map((x) => `    ${x}`).join('\n');

console.log(`Equivalence check — monolith ${monolith.size} files vs recomposed matrix ${matrix.size} files`);
console.log(`  only-in-monolith: ${onlyMonolith.length}`);
console.log(`  only-in-matrix:   ${onlyMatrix.length}`);
console.log(`  content-mismatch: ${mismatch.length}`);
console.log(`  cross-shard dup-conflicts: ${dupConflicts.length}`);

const summary = (process.env.GITHUB_STEP_SUMMARY ? [] : null);
function emit(line) { console.log(line); if (summary) summary.push(line); }

const total = onlyMonolith.length + onlyMatrix.length + mismatch.length + dupConflicts.length;
if (total === 0) {
  emit('\n✅ PIXEL/BYTE-PERFECT: recomposed matrix === monolith (every file sha256-identical).');
} else {
  emit('\n✖ MATRIX ≠ MONOLITH — divergences found:');
  if (onlyMonolith.length) emit(`\n--- only in MONOLITH (${onlyMonolith.length}) ---\n${sample(onlyMonolith)}`);
  if (onlyMatrix.length) emit(`\n--- only in MATRIX (${onlyMatrix.length}) ---\n${sample(onlyMatrix)}`);
  if (mismatch.length) emit(`\n--- CONTENT MISMATCH (${mismatch.length}) ---\n${sample(mismatch)}`);
  if (dupConflicts.length) emit(`\n--- cross-shard dup w/ different hash (${dupConflicts.length}) ---\n${sample(dupConflicts)}`);
}

if (summary && process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n### Matrix ≡ Monolith equivalence\n\n` +
    `| metric | count |\n|---|---|\n` +
    `| monolith files | ${monolith.size} |\n| recomposed matrix files | ${matrix.size} |\n` +
    `| only-in-monolith | ${onlyMonolith.length} |\n| only-in-matrix | ${onlyMatrix.length} |\n` +
    `| content-mismatch | ${mismatch.length} |\n| dup-conflicts | ${dupConflicts.length} |\n\n` +
    (total === 0 ? '✅ **byte-perfect identical**\n' : `✖ **${total} divergences** (see job log)\n`));
}

process.exit(total === 0 ? 0 : 1);
