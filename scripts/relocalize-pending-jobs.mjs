#!/usr/bin/env node
/**
 * Re-localize jobs with incomplete locale coverage or pending retranslation.
 *
 * Problem: Dedicated crawlers run on staggered cron schedules throughout the
 * UTC day. When SKIP_AI_TRANSLATION=1 (set by orchestrator), crawlers skip
 * AI calls and mark jobs with needsRetranslation=true. This centralized
 * translation pipeline runs after all crawlers finish, with exclusive access
 * to AI model quotas — eliminating contention and quota exhaustion.
 *
 * Additionally, crawlers that ran out of AI quota in earlier runs may have
 * left jobs with incomplete locale coverage.
 *
 * Solution: This script identifies ALL jobs needing translation (either
 * flagged with needsRetranslation or with incomplete locale coverage),
 * prioritizes by datePosted (most recent first), and runs the shared crawler
 * in LOCALIZE_EXISTING_ONLY mode to fill the gaps.
 *
 * Usage:
 *   node scripts/relocalize-pending-jobs.mjs [--max-jobs N]
 *
 * Environment:
 *   - Requires the same API keys as the shared crawler (GH_MODELS_PAT, etc.)
 *   - GOOGLE_APPLICATION_CREDENTIALS for Firestore-backed score store
 *   - RELOCALIZE_MAX_JOBS — max jobs to re-localize (default: 200)
 *   - RELOCALIZE_DRY_RUN — set to '1' to only report, not run (default: '0')
 */

import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;
const DRY_RUN = String(process.env.RELOCALIZE_DRY_RUN || '0') === '1';

// Parse --max-jobs from CLI args (takes precedence over env var)
function parseMaxJobs() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--max-jobs');
  if (idx !== -1 && args[idx + 1]) {
    const val = Number(args[idx + 1]);
    if (!isNaN(val) && val > 0) return val;
  }
  return Number(process.env.RELOCALIZE_MAX_JOBS) || 200;
}

const MAX_JOBS = parseMaxJobs();

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check if a job needs translation work.
 * Returns true if the job has needsRetranslation flag or incomplete locale coverage.
 */
function needsTranslation(job) {
  if (job.needsRetranslation) return true;
  return isIncomplete(job);
}

/**
 * Check if a job has incomplete locale coverage.
 * Returns true if any locale is missing an adequate title or description.
 */
function isIncomplete(job) {
  const dbl = job.descriptionByLocale || {};
  const tbl = job.titleByLocale || {};
  const sourceTitle = (job.title || '').trim().toLowerCase();
  const sourceDesc = (job.description || '').trim().toLowerCase();

  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();

    // Missing or too short
    if (title.length < MIN_TITLE_CHARS || desc.length < MIN_DESC_CHARS) return true;

    // Untranslated (title identical to source in a different language)
    if (title.toLowerCase() === sourceTitle && locale !== (job.sourceLang || 'it')) return true;

    // Description identical to source (not translated)
    if (desc.length > 0 && desc.toLowerCase() === sourceDesc && locale !== (job.sourceLang || 'it')) return true;
  }

  return false;
}

/**
 * Normalize a company key for matching.
 */
function normalizeCompanyKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sort jobs by priority: needsRetranslation first, then by datePosted (most recent first).
 */
function sortByPriority(a, b) {
  // needsRetranslation flagged jobs come first
  const aFlag = a.needsRetranslation ? 1 : 0;
  const bFlag = b.needsRetranslation ? 1 : 0;
  if (bFlag !== aFlag) return bFlag - aFlag;

  // Then by datePosted (most recent first)
  const aDate = a.datePosted ? new Date(a.datePosted).getTime() : 0;
  const bDate = b.datePosted ? new Date(b.datePosted).getTime() : 0;
  return bDate - aDate;
}

/**
 * Run the shared crawler in LOCALIZE_EXISTING_ONLY mode (in-process).
 */
async function runSharedCrawler(companyKeys, maxJobs) {
  const overrides = {
    JOBS_CRAWLER_COMPANY_KEYS: companyKeys.join(','),
    JOBS_CRAWLER_FORCE_LOCALIZE_KEYS: companyKeys.join(','),
    JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY: '1',
    JOBS_AI_LOCALIZATION_ENABLED: '1',
    JOBS_AI_MAX_JOBS_PER_RUN: String(maxJobs),
    JOBS_FORCE_LOCALIZE_WORKDAY: '0',
    JOBS_SKIP_CRAWL_CHANGE_SUMMARY: '1',
    // Ensure AI translation is NOT skipped in the translation pipeline
    SKIP_AI_TRANSLATION: '0',
  };

  console.log(`\n🚀 Running shared crawler in LOCALIZE_EXISTING_ONLY mode (in-process)...`);
  console.log(`   Company keys: ${companyKeys.join(', ')}`);
  console.log(`   Max AI jobs: ${maxJobs}\n`);

  // Save and override env
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key in process.env) originals[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    const { runSharedCrawlerPipeline } = await import('./lib/shared-jobs-crawler.mjs');
    await runSharedCrawlerPipeline();
  } finally {
    // Restore original env
    for (const [key, value] of Object.entries(originals)) {
      process.env[key] = value;
    }
  }
}

/**
 * Clear needsRetranslation flag from jobs that are now complete.
 * Returns the number of flags cleared.
 */
function clearRetranslationFlags(jobs) {
  let cleared = 0;
  for (const job of jobs) {
    if (job.needsRetranslation && !isIncomplete(job)) {
      delete job.needsRetranslation;
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Sync translations from jobs.json back to the per-crawler file for a given company key.
 * The shared crawler writes translations to jobs.json (assembled), but the commit script
 * with --slice-only only commits per-crawler files. This bridges the gap.
 *
 * @param {string} companyKey - The crawler/company key (e.g. 'abb-svizzera-sede-ticino')
 * @param {Array} assembledJobs - The current jobs from jobs.json
 * @returns {number} Number of jobs updated in the per-crawler file
 */
function syncTranslationsToCrawlerFile(companyKey, assembledJobs) {
  const crawlerFilePath = path.join(BY_CRAWLER_DIR, `${companyKey}.json`);

  if (!fs.existsSync(crawlerFilePath)) {
    console.log(`   ⚠️  Per-crawler file not found: ${companyKey}.json — skipping sync`);
    return 0;
  }

  const crawlerData = readJson(crawlerFilePath);
  if (!crawlerData || !Array.isArray(crawlerData.jobs)) {
    console.log(`   ⚠️  Invalid per-crawler file: ${companyKey}.json — skipping sync`);
    return 0;
  }

  // Build a slug -> assembled job lookup for this company
  const assembledBySlug = new Map();
  for (const job of assembledJobs) {
    const jobKey = normalizeCompanyKey(job.companyKey || job.company || '');
    if (jobKey === companyKey && job.slug) {
      assembledBySlug.set(job.slug, job);
    }
  }

  let updated = 0;
  for (const crawlerJob of crawlerData.jobs) {
    const assembled = assembledBySlug.get(crawlerJob.slug);
    if (!assembled) continue;

    let changed = false;

    // Merge locale fields from assembled (translated) into per-crawler.
    // Only ADD new locales — never remove existing ones. The shared crawler may
    // delete an untranslated copy (e.g. EN = copy of IT) before attempting
    // retranslation; if AI then fails (quota exhausted), the assembled object
    // has fewer locales than the per-crawler file. Overwriting would cause a
    // regression (losing existing values). Merge per-locale instead.
    for (const field of ['titleByLocale', 'descriptionByLocale', 'slugByLocale']) {
      if (!assembled[field] || Object.keys(assembled[field]).length === 0) continue;
      if (!crawlerJob[field]) {
        crawlerJob[field] = assembled[field];
        changed = true;
        continue;
      }
      for (const [locale, value] of Object.entries(assembled[field])) {
        const existing = crawlerJob[field][locale];
        const trimmedValue = String(value || '').trim();
        // Only update if assembled has a non-empty value AND crawler doesn't
        if (trimmedValue && !String(existing || '').trim()) {
          crawlerJob[field][locale] = value;
          changed = true;
        }
      }
    }

    // Clear needsRetranslation flag if present
    if (crawlerJob.needsRetranslation) {
      delete crawlerJob.needsRetranslation;
      changed = true;
    }

    if (changed) updated += 1;
  }

  if (updated > 0) {
    fs.writeFileSync(crawlerFilePath, JSON.stringify(crawlerData, null, 2) + '\n', 'utf-8');
  }

  return updated;
}

async function main() {
  console.log('🔍 Scanning for jobs needing translation...\n');

  if (!fs.existsSync(DATA_JOBS_PATH)) {
    console.log('ℹ️  data/jobs.json not found — nothing to re-localize.');
    return;
  }

  const jobs = readJson(DATA_JOBS_PATH);
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log('ℹ️  No jobs found in data/jobs.json.');
    return;
  }

  // Find all jobs needing translation (flagged or incomplete)
  const pending = jobs.filter(needsTranslation);
  const flaggedCount = pending.filter(j => j.needsRetranslation).length;
  const incompleteCount = pending.length - flaggedCount;

  if (pending.length === 0) {
    console.log('✅ All jobs have complete locale coverage. Nothing to re-localize.');
    return;
  }

  // Sort by priority (needsRetranslation first, then most recent datePosted)
  pending.sort(sortByPriority);

  // Group by company
  const byCompany = {};
  for (const job of pending) {
    const company = job.company || 'unknown';
    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(job);
  }

  // Report
  console.log(`📊 Found ${pending.length}/${jobs.length} jobs needing translation:`);
  console.log(`   🔁 ${flaggedCount} flagged with needsRetranslation`);
  console.log(`   📝 ${incompleteCount} with incomplete locale coverage\n`);

  const sorted = Object.entries(byCompany).sort((a, b) => b[1].length - a[1].length);
  for (const [company, companyJobs] of sorted) {
    const key = normalizeCompanyKey(company);
    const flagged = companyJobs.filter(j => j.needsRetranslation).length;
    const flagSuffix = flagged > 0 ? ` (${flagged} flagged)` : '';
    console.log(`   ${String(companyJobs.length).padStart(3)} jobs — ${company} (key: ${key})${flagSuffix}`);
  }

  if (DRY_RUN) {
    console.log('\n🏁 Dry run — skipping re-localization.');
    return;
  }

  // Build ordered list of (companyKey, jobCount) pairs from priority-sorted pending jobs, capped at MAX_JOBS
  const effectiveMax = Math.min(MAX_JOBS, pending.length);
  const cappedPending = pending.slice(0, effectiveMax);
  const companyJobCounts = new Map();
  for (const job of cappedPending) {
    const key = normalizeCompanyKey(job.companyKey || job.company || '');
    if (!key) continue;
    companyJobCounts.set(key, (companyJobCounts.get(key) || 0) + 1);
  }

  const companyKeys = [...companyJobCounts.keys()];

  if (companyKeys.length === 0) {
    console.log('⚠️  No valid company keys found. Skipping.');
    return;
  }

  console.log(`\n🔄 Re-localizing up to ${effectiveMax} jobs across ${companyKeys.length} companies (incremental save)...`);

  // Process each company separately with intermediate saves
  let totalFixed = 0;
  let totalProcessed = 0;

  for (const key of companyKeys) {
    const companyJobCount = companyJobCounts.get(key) || 0;
    console.log(`\n🔄 [${totalProcessed + companyJobCount}/${effectiveMax}] Translating ${key} (${companyJobCount} jobs)...`);

    try {
      await runSharedCrawler([key], companyJobCount);

      // Save progress after each company: clear flags and write to disk
      const currentJobs = readJson(DATA_JOBS_PATH);
      if (Array.isArray(currentJobs)) {
        const cleared = clearRetranslationFlags(currentJobs);
        if (cleared > 0) {
          fs.writeFileSync(DATA_JOBS_PATH, JSON.stringify(currentJobs, null, 2) + '\n', 'utf-8');
          totalFixed += cleared;
          console.log(`   ✅ ${key}: ${cleared} jobs translated, progress saved`);
        } else {
          console.log(`   ℹ️  ${key}: no new translations completed`);
        }

        // Sync translations back to per-crawler file so git-commit-data --slice-only picks them up
        const synced = syncTranslationsToCrawlerFile(key, currentJobs);
        if (synced > 0) {
          console.log(`   📁 ${key}: ${synced} jobs synced to per-crawler file`);
        }
      }

      totalProcessed += companyJobCount;
      if (totalProcessed >= effectiveMax) break;

    } catch (err) {
      console.error(`   ❌ ${key} failed: ${err.message}`);
      console.log(`   💾 Progress saved: ${totalFixed} jobs translated before failure`);
      // Stop on first failure to avoid burning more AI quota
      break;
    }
  }

  // Final summary
  const afterJobs = readJson(DATA_JOBS_PATH);
  const stillPending = Array.isArray(afterJobs) ? afterJobs.filter(needsTranslation).length : pending.length;
  const fixed = pending.length - stillPending;

  console.log(`\n📈 Re-localization results:`);
  console.log(`   Before: ${pending.length} pending (${flaggedCount} flagged)`);
  console.log(`   After:  ${stillPending} pending`);
  console.log(`   Fixed:  ${fixed} jobs (${totalFixed} flags cleared)\n`);

  console.log('✅ Re-localization complete.');
}

main().catch((err) => {
  console.error('❌ Re-localization failed:', err?.message || err);
  process.exit(1);
});
