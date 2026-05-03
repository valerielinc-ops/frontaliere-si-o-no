#!/usr/bin/env node
/**
 * scripts/prune-dedup-from-slices.mjs
 *
 * Phase 2 of cross-crawler deduplication.
 *
 * Run AFTER:
 *   1. assemble-jobs-dataset.mjs  (creates data/jobs.json from all slices)
 *   2. cleanup-jobs.mjs           (removes cross-crawler title+company duplicates
 *                                  from data/jobs.json — monolithic mode)
 *
 * This script propagates those removals back to the per-crawler slice files so
 * the duplicates are permanently eliminated and not re-detected on every deploy.
 *
 * Logic:
 *   - Reads data/jobs.json → builds a Set of "kept" job slugs
 *   - For each slice in data/jobs/by-crawler/, removes any job whose slug is
 *     NOT in the kept set (i.e., was pruned by the monolithic dedup pass)
 *   - Reports which jobs were pruned and from which slices
 *   - Writes back only modified slices
 *
 * Safe to run multiple times (idempotent). Does nothing if no duplicates remain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.join(ROOT, 'data', 'jobs.json');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const assembled = readJson(DATA_JOBS, null);
if (!Array.isArray(assembled)) {
  console.log('ℹ️  data/jobs.json not found or not an array — nothing to prune. Run assemble-jobs-dataset.mjs first.');
  process.exit(0);
}

// Build set of "kept" slugs from the post-cleanup assembled dataset
const keptSlugs = new Set();
const keptIds = new Set();
for (const job of assembled) {
  if (job.slug) keptSlugs.add(String(job.slug).trim());
  if (job.id) keptIds.add(String(job.id).trim());
}

console.log(`📋 Assembled dataset: ${assembled.length} kept jobs`);

if (!fs.existsSync(SLICES_DIR)) {
  console.log('ℹ️  No slice directory found — nothing to prune.');
  process.exit(0);
}

const sliceFiles = fs.readdirSync(SLICES_DIR)
  .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
  .sort();

let totalPruned = 0;
let modifiedSlices = 0;

for (const file of sliceFiles) {
  const slicePath = path.join(SLICES_DIR, file);
  const slice = readJson(slicePath, null);
  if (!slice || !Array.isArray(slice.jobs)) continue;

  const original = slice.jobs;
  const kept = original.filter((job) => {
    const slug = String(job.slug || '').trim();
    const id = String(job.id || '').trim();
    // Keep if slug OR id is in the assembled (kept) set.
    // Both checks needed: some jobs have stable IDs but unstable slugs, or vice versa.
    if (slug && keptSlugs.has(slug)) return true;
    if (id && keptIds.has(id)) return true;
    return false;
  });

  const pruned = original.length - kept.length;
  if (pruned > 0) {
    const prunedJobs = original.filter((j) => !kept.includes(j));
    console.log(`🗑️  ${file}: pruned ${pruned} cross-crawler duplicate(s):`);
    for (const j of prunedJobs.slice(0, 5)) {
      console.log(`   - ${j.id || '?'} "${j.title || '?'}" @ ${j.company || '?'}`);
    }
    if (prunedJobs.length > 5) {
      console.log(`   ... and ${prunedJobs.length - 5} more`);
    }
    writeJson(slicePath, { ...slice, jobs: kept });
    modifiedSlices++;
    totalPruned += pruned;
  }
}

if (totalPruned === 0) {
  console.log('✅ No cross-crawler duplicates found in slices — all clean.');
} else {
  console.log(`\n✅ Pruned ${totalPruned} duplicate job(s) across ${modifiedSlices} slice file(s).`);
}
