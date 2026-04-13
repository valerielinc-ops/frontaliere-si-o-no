#!/usr/bin/env node
/**
 * One-time migration script: backfill `firstSeenAt` on all existing jobs.
 *
 * For every job in data/jobs/by-crawler/*.json that does NOT already have
 * a `firstSeenAt` field, this script sets it to the job's `crawledAt` value
 * (the closest approximation of when the job was first seen).
 *
 * Safe to run multiple times (idempotent).
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'jobs', 'by-crawler');

const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));

let totalFiles = 0;
let totalJobs = 0;
let backfilledJobs = 0;
let skippedJobs = 0;
let filesModified = 0;

for (const file of files) {
  const filePath = join(DATA_DIR, file);
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data.jobs)) {
    console.warn(`  SKIP ${file}: no jobs array`);
    continue;
  }

  totalFiles++;
  let fileChanged = false;

  for (const job of data.jobs) {
    totalJobs++;

    if (job.firstSeenAt) {
      skippedJobs++;
      continue;
    }

    if (!job.crawledAt) {
      console.warn(`  WARN ${file}: job "${job.id}" has no crawledAt — skipping`);
      skippedJobs++;
      continue;
    }

    job.firstSeenAt = job.crawledAt;
    backfilledJobs++;
    fileChanged = true;
  }

  if (fileChanged) {
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    filesModified++;
  }
}

console.log('');
console.log('=== firstSeenAt backfill complete ===');
console.log(`  Files scanned:   ${totalFiles}`);
console.log(`  Files modified:  ${filesModified}`);
console.log(`  Total jobs:      ${totalJobs}`);
console.log(`  Backfilled:      ${backfilledJobs}`);
console.log(`  Already had it:  ${skippedJobs}`);
console.log('');
