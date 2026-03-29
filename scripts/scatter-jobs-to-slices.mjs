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

/**
 * Merge two locale maps. For each locale, prefer the assembled value if non-empty,
 * otherwise keep the slice value. This prevents AI translation failures from
 * destroying existing translations.
 */
function mergeLocaleMap(sliceMap, assembledMap) {
  const s = (sliceMap && typeof sliceMap === 'object') ? sliceMap : {};
  const a = (assembledMap && typeof assembledMap === 'object') ? assembledMap : {};
  const merged = { ...s };
  for (const [locale, value] of Object.entries(a)) {
    const trimmed = String(value || '').trim();
    const existing = String(merged[locale] || '').trim();
    // Only update if assembled has a non-empty value, OR if slice also has nothing
    if (trimmed) {
      // Assembled has content — use it (it may be a real translation)
      merged[locale] = value;
    }
    // If assembled is empty but slice has content, keep slice (don't destroy)
  }
  return merged;
}

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
      // Defensive merge: never overwrite a non-empty locale value with an empty one.
      // The assembled data may have had locales stripped by ensureLocaleFields when
      // AI translation failed — the per-crawler file is the source of truth.
      const mergedTitle = mergeLocaleMap(sliceJob.titleByLocale, assembled.titleByLocale);
      const mergedDesc = mergeLocaleMap(sliceJob.descriptionByLocale, assembled.descriptionByLocale);
      const mergedSlug = mergeLocaleMap(sliceJob.slugByLocale, assembled.slugByLocale);

      // Track slug changes: preserve old slug values in previousSlugs so the build
      // plugin can generate bridge/redirect pages for SEO continuity (prevents 404s
      // for URLs that Google/Bing may have already indexed).
      const oldSlugs = sliceJob.slugByLocale && typeof sliceJob.slugByLocale === 'object'
        ? sliceJob.slugByLocale : {};
      const newSlugs = mergedSlug && typeof mergedSlug === 'object' ? mergedSlug : {};
      const newSlugValues = new Set(Object.values(newSlugs).map((s) => String(s || '').trim()).filter(Boolean));
      const lostSlugs = Object.values(oldSlugs)
        .map((s) => String(s || '').trim())
        .filter((s) => s && !newSlugValues.has(s));

      let updatedJob = { ...sliceJob, titleByLocale: mergedTitle, descriptionByLocale: mergedDesc, slugByLocale: mergedSlug };
      if (lostSlugs.length > 0) {
        const existing = new Set(Array.isArray(sliceJob.previousSlugs) ? sliceJob.previousSlugs : []);
        // Also exclude any slug that is still current
        for (const s of newSlugValues) existing.delete(s);
        for (const s of lostSlugs) existing.add(s);
        updatedJob.previousSlugs = [...existing];
      }

      return updatedJob;
    }
    return sliceJob;
  });

  if (sliceChanged) {
    // Preserve the original assembledAt timestamp from the crawler.
    // Scatter only propagates locale changes from the assembled dataset — it
    // does not represent a new crawl run, so bumping assembledAt would cause
    // unnecessary git churn across 90+ files when only a single company was
    // actually translated.
    const envelope = { ...slice, jobs: updatedSliceJobs };
    writeJson(slicePath, envelope);
    updatedSlices++;
  }
}

if (updatedSlices > 0) {
  console.log(`✅ Scattered ${updatedJobs} updated jobs across ${updatedSlices} per-crawler slices.`);
} else {
  console.log('ℹ️  No changes to scatter back to per-crawler slices.');
}
