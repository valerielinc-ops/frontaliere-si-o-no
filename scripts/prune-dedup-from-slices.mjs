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
 *   - Reads data/jobs.json → builds sets of kept URL identities, slugs and IDs
 *   - For each slice in data/jobs/by-crawler/, removes any job absent from all
 *     kept sets (i.e., was pruned by the monolithic dedup pass)
 *   - Reports which jobs were pruned and from which slices
 *   - Writes back only modified slices
 *
 * Safe to run multiple times (idempotent). Does nothing if no duplicates remain.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { hasUsableJobId } from './lib/job-match-key.mjs';
import { assembleUrlKey } from './lib/job-url-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Build the membership keys emitted by the assembled dataset.
 *
 * URL identity is checked before slug/id because assembly can repair a slug
 * while retaining the same posting. Without the URL key, that ordinary slug
 * repair is misclassified as a cross-crawler duplicate and the slice writer's
 * shrink guard correctly rejects the destructive write.
 */
export function buildAssembledMembership(assembled) {
  const keptUrls = new Set();
  const keptSlugs = new Set();
  const keptIds = new Set();
  for (const job of assembled) {
    const url = assembleUrlKey(job?.url);
    if (url) keptUrls.add(url);
    if (job?.slug) keptSlugs.add(String(job.slug).trim());
    if (hasUsableJobId(job)) keptIds.add(String(job.id).trim());
  }
  return { keptUrls, keptSlugs, keptIds };
}

export function isJobInAssembledDataset(job, membership) {
  const url = assembleUrlKey(job?.url);
  if (url && membership.keptUrls.has(url)) return true;
  const slug = String(job?.slug || '').trim();
  if (slug && membership.keptSlugs.has(slug)) return true;
  const id = String(job?.id ?? '').trim();
  return Boolean(id && membership.keptIds.has(id));
}

export function filterSliceJobs(original, assembled) {
  const membership = buildAssembledMembership(assembled);
  return original.filter((job) => isJobInAssembledDataset(job, membership));
}

export function pruneDedupFromSlices(root = ROOT) {
  const dataJobs = path.join(root, 'data', 'jobs.json');
  const slicesDir = path.join(root, 'data', 'jobs', 'by-crawler');
  const assembled = readJson(dataJobs, null);
  if (!Array.isArray(assembled)) {
    console.log('ℹ️  data/jobs.json not found or not an array — nothing to prune. Run assemble-jobs-dataset.mjs first.');
    return { totalPruned: 0, modifiedSlices: 0 };
  }

  const membership = buildAssembledMembership(assembled);
  console.log(`📋 Assembled dataset: ${assembled.length} kept jobs`);

  if (!fs.existsSync(slicesDir)) {
    console.log('ℹ️  No slice directory found — nothing to prune.');
    return { totalPruned: 0, modifiedSlices: 0 };
  }

  const sliceFiles = listSliceFileNames(slicesDir);

  let totalPruned = 0;
  let modifiedSlices = 0;

  for (const file of sliceFiles) {
    const slicePath = path.join(slicesDir, file);
    const slice = readJson(slicePath, null);
    if (!slice || !Array.isArray(slice.jobs)) continue;

    const original = slice.jobs;
    const kept = original.filter((job) => isJobInAssembledDataset(job, membership));

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
      // The assembled dataset is the evidence that the removed records were
      // cross-crawler duplicates. Pass it to the shared byte guard explicitly;
      // an ordinary crawler write remains fail-closed on the same shrink.
      writeJson(slicePath, { ...slice, jobs: kept }, { dedupReferenceJobs: assembled });
      modifiedSlices++;
      totalPruned += pruned;
    }
  }

  if (totalPruned === 0) {
    console.log('✅ No cross-crawler duplicates found in slices — all clean.');
  } else {
    console.log(`\n✅ Pruned ${totalPruned} duplicate job(s) across ${modifiedSlices} slice file(s).`);
  }
  return { totalPruned, modifiedSlices };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  pruneDedupFromSlices();
}
