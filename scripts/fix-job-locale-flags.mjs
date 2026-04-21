#!/usr/bin/env node
/**
 * fix-job-locale-flags.mjs
 *
 * Scans data/jobs.json for locale description mismatches and sets
 * needsRetranslation = true on affected jobs — both in the assembled
 * dataset and in the per-crawler slice files (source of truth).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const JOBS_PATH = join(ROOT, 'data', 'jobs.json');
const SLICES_DIR = join(ROOT, 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_LENGTH = 120;
const MIN_CONFIDENCE = 0.50;

/** Stable composite key for a job (id may be missing on ~half the dataset) */
function jobKey(job) {
  if (job.id) return job.id;
  return `${job.companyKey || ''}::${job.slug || ''}::${(job.title || '').slice(0, 80)}`;
}

// ── Load assembled dataset ──────────────────────────────────────────
if (!existsSync(JOBS_PATH)) {
  console.error('❌ data/jobs.json not found. Run assemble-jobs-dataset.mjs first.');
  process.exit(1);
}

const jobs = JSON.parse(readFileSync(JOBS_PATH, 'utf-8'));
console.log(`📊 Loaded ${jobs.length} jobs from data/jobs.json`);

// ── Detect mismatches ───────────────────────────────────────────────
const flaggedKeys = new Set();
const flaggedByCrawler = new Map(); // crawlerKey → Set<jobKey>
let skippedAlreadyFlagged = 0;
let checked = 0;

for (const job of jobs) {
  if (job.needsRetranslation === true) {
    skippedAlreadyFlagged++;
    continue;
  }

  const desc = job.descriptionByLocale;
  if (!desc || typeof desc !== 'object') continue;

  // Flag jobs missing one or more locale descriptions — the translate-pending
  // pipeline treats needsRetranslation=true as the signal to regenerate all
  // locales from source_description.
  const presentLocales = LOCALES.filter((l) => typeof desc[l] === 'string' && desc[l].trim().length > 0);
  if (presentLocales.length > 0 && presentLocales.length < LOCALES.length) {
    const key = jobKey(job);
    flaggedKeys.add(key);
    const crawlerKey = job.companyKey || '';
    if (crawlerKey) {
      if (!flaggedByCrawler.has(crawlerKey)) {
        flaggedByCrawler.set(crawlerKey, new Set());
      }
      flaggedByCrawler.get(crawlerKey).add(key);
    }
    continue;
  }

  for (const locale of LOCALES) {
    const text = desc[locale];
    if (!text || text.length < MIN_LENGTH) continue;

    checked++;
    const detected = detectLanguageWithConfidence(text, locale);

    if (detected.confidence >= MIN_CONFIDENCE && detected.lang !== locale) {
      const key = jobKey(job);
      flaggedKeys.add(key);

      const crawlerKey = job.companyKey || '';
      if (crawlerKey) {
        if (!flaggedByCrawler.has(crawlerKey)) {
          flaggedByCrawler.set(crawlerKey, new Set());
        }
        flaggedByCrawler.get(crawlerKey).add(key);
      }
      break; // one mismatch per job is enough
    }
  }
}

console.log(`\n🔍 Checked ${checked} locale descriptions`);
console.log(`⏭️  Skipped ${skippedAlreadyFlagged} already-flagged jobs`);
console.log(`⚠️  Found ${flaggedKeys.size} jobs with locale mismatches`);
console.log(`📁 Affected crawlers: ${flaggedByCrawler.size}`);

if (flaggedKeys.size === 0) {
  console.log('\n✅ No mismatches found. Nothing to fix.');
  process.exit(0);
}

// ── Update per-crawler slice files (source of truth) ────────────────
let slicesUpdated = 0;
let jobsUpdatedInSlices = 0;

for (const [crawlerKey, keys] of flaggedByCrawler) {
  const slicePath = join(SLICES_DIR, `${crawlerKey}.json`);
  if (!existsSync(slicePath)) {
    console.warn(`⚠️  Slice not found: ${crawlerKey}.json (${keys.size} jobs)`);
    continue;
  }

  const slice = JSON.parse(readFileSync(slicePath, 'utf-8'));
  let modified = false;

  for (const job of slice.jobs || []) {
    if (keys.has(jobKey(job)) && job.needsRetranslation !== true) {
      job.needsRetranslation = true;
      modified = true;
      jobsUpdatedInSlices++;
    }
  }

  if (modified) {
    writeFileSync(slicePath, JSON.stringify(slice, null, 2) + '\n', 'utf-8');
    slicesUpdated++;
  }
}

console.log(`\n✏️  Updated ${jobsUpdatedInSlices} jobs across ${slicesUpdated} slice files`);

// ── Update assembled dataset too (for immediate test pass) ──────────
let jobsUpdatedInAssembled = 0;
for (const job of jobs) {
  if (flaggedKeys.has(jobKey(job)) && job.needsRetranslation !== true) {
    job.needsRetranslation = true;
    jobsUpdatedInAssembled++;
  }
}

writeFileSync(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n', 'utf-8');
console.log(`✏️  Updated ${jobsUpdatedInAssembled} jobs in data/jobs.json`);
console.log('\n✅ Done. Run the test to verify: npx vitest run tests/job-locale-consistency.test.ts');
