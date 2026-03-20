#!/usr/bin/env node
/**
 * scatter-jobs-to-slices.mjs
 *
 * Reads the assembled data/jobs.json and writes updated jobs back to their
 * per-crawler slice files (data/jobs/by-crawler/{key}.json).
 *
 * Use case: After a script modifies the assembled data/jobs.json (e.g.
 * relocalize-pending-jobs.mjs), this script propagates changes back to
 * the per-crawler slices so they can be committed.
 *
 * Only updates slices where job data actually changed.
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const jobs = readJson(DATA_JOBS, null);
if (!Array.isArray(jobs)) {
  console.log('ℹ️  data/jobs.json not found or not an array — nothing to scatter.');
  process.exit(0);
}

// Index assembled jobs by companyKey + slug for lookup
const jobIndex = new Map();
for (const job of jobs) {
  if (job.slug) jobIndex.set(job.slug, job);
}

// Read each slice, update jobs with matching slugs, write back if changed
const sliceFiles = fs.existsSync(SLICES_DIR)
  ? fs.readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json') && f !== '.gitkeep')
  : [];

let updatedSlices = 0;
let updatedJobs = 0;

for (const file of sliceFiles) {
  const slicePath = path.join(SLICES_DIR, file);
  const slice = readJson(slicePath, null);
  if (!slice || !Array.isArray(slice.jobs)) continue;

  let sliceChanged = false;
  const updatedSliceJobs = slice.jobs.map((sliceJob) => {
    if (!sliceJob.slug) return sliceJob;
    const assembled = jobIndex.get(sliceJob.slug);
    if (!assembled) return sliceJob;

    // Compare locale fields — only update if they changed
    const changed =
      JSON.stringify(assembled.titleByLocale) !== JSON.stringify(sliceJob.titleByLocale) ||
      JSON.stringify(assembled.descriptionByLocale) !== JSON.stringify(sliceJob.descriptionByLocale) ||
      JSON.stringify(assembled.slugByLocale) !== JSON.stringify(sliceJob.slugByLocale);

    if (changed) {
      sliceChanged = true;
      updatedJobs++;
      return {
        ...sliceJob,
        titleByLocale: assembled.titleByLocale || sliceJob.titleByLocale,
        descriptionByLocale: assembled.descriptionByLocale || sliceJob.descriptionByLocale,
        slugByLocale: assembled.slugByLocale || sliceJob.slugByLocale,
      };
    }
    return sliceJob;
  });

  if (sliceChanged) {
    const envelope = { ...slice, jobs: updatedSliceJobs, assembledAt: new Date().toISOString() };
    writeJson(slicePath, envelope);
    updatedSlices++;
  }
}

if (updatedSlices > 0) {
  console.log(`✅ Scattered ${updatedJobs} updated jobs across ${updatedSlices} per-crawler slices.`);
} else {
  console.log('ℹ️  No changes to scatter back to per-crawler slices.');
}
