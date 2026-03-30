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
import { detectJobTitleLocaleDetails } from './lib/job-locale-utils.mjs';

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

// Parse --company-key from CLI args (filter to a single company)
function parseCompanyKey() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--company-key');
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1].trim().toLowerCase();
  }
  return process.env.RELOCALIZE_COMPANY_KEY || '';
}

const COMPANY_KEY_FILTER = parseCompanyKey();

// Time budget: stop starting new companies when this many ms have elapsed.
// The workflow job has timeout-minutes:350; we stop at 320min to leave a
// comfortable margin for the commit/deploy steps to run.
const TIME_BUDGET_MS = 320 * 60 * 1000;

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
export function isIncomplete(job) {
  const dbl = job.descriptionByLocale || {};
  const tbl = job.titleByLocale || {};
  const sourceTitle = (job.title || '').trim().toLowerCase();
  const sourceDesc = (job.description || '').trim().toLowerCase();

  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();

    // Missing or too short
    if (title.length < MIN_TITLE_CHARS || desc.length < MIN_DESC_CHARS) return true;

    // Untranslated (title identical to source in a different language).
    // Cross-locale guard: skip flagging if the title itself looks like an international
    // English term (short, no diacritics). This applies regardless of sourceLang —
    // an IT-source job can have an English title (e.g. "Front Desk & Office Support").
    if (title.toLowerCase() === sourceTitle && locale !== (job.sourceLang || 'it')) {
      const srcLang = job.sourceLang || 'it';
      const titleLooksEnglish = title.length < 40 && !/[àèéìòùüäöüß]/i.test(title);
      const isInternationalTitle = (srcLang === 'en' || titleLooksEnglish) && title.length < 40;
      if (!isInternationalTitle) return true;
      // For international EN titles, only flag if no other locale translated it either
      const otherLocalesTranslated = LOCALES.some(
        (l) => l !== locale && l !== srcLang && (tbl[l] || '').trim().toLowerCase() !== sourceTitle,
      );
      if (!otherLocalesTranslated) return true;
    }

    // Description identical to source (not translated)
    if (desc.length > 0 && desc.toLowerCase() === sourceDesc && locale !== (job.sourceLang || 'it')) return true;

    // Cross-locale contamination: title detected as SOURCE language in a non-source slot.
    // Two detection layers:
    // 1. Hint-based: catches strong signals (German Fach* words, Italian responsabile, etc.)
    // 2. Stop-word: catches Italian articles/prepositions in non-IT slots, German articles in non-DE slots
    if (locale !== (job.sourceLang || 'it') && title.length >= 8) {
      const srcLang = job.sourceLang || 'it';
      // Layer 1: hint-based language detector
      const detected = detectJobTitleLocaleDetails(title, locale);
      if (detected.confidence >= 0.65 && detected.lang === srcLang) return true;
      // Layer 2: stop-word contamination — Italian/German articles and prepositions are
      // strong signals even in titles too short for the hint detector
      const lc = title.toLowerCase();
      if (srcLang === 'it' && locale !== 'it' && /\b(per il|per la|per lo|per i|per le|dell[aeo']|nell[aeo']|sull[aeo']|consulente|impiegat[oa]|responsabile|collaborat)\b/i.test(lc)) return true;
      if (srcLang === 'de' && locale !== 'de' && /\b(und|für|mit fokus|des|der|die|fachspezialist|mitarbeiter|leiter:?in)\b/i.test(lc)) return true;
      if (srcLang === 'fr' && locale !== 'fr' && /\b(responsable|spécialiste|ingénieur|gestionnaire|pour le|pour la|du |de la )\b/i.test(lc)) return true;
    }
  }

  // Slug check: detect non-source slugs that haven't been localized.
  // Two patterns to catch:
  //   A) localeSlug === masterSlug (master may be in a different lang than sourceLang)
  //   B) localeSlug === sourceSlug (slug still in source language after title was translated)
  // Both indicate the slug wasn't updated to match the translated title.
  const masterSlug = (job.slug || '').trim();
  if (masterSlug) {
    const sbl = job.slugByLocale || {};
    const sourceLang = job.sourceLang || 'it';
    const sourceSlug = (sbl[sourceLang] || '').trim();
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const localeSlug = (sbl[locale] || '').trim();
      const localeTitle = (tbl[locale] || '').trim().toLowerCase();
      if (!localeSlug || !localeTitle) continue;

      // Pattern A: slug equals master slug but title is translated
      if (localeSlug === masterSlug && localeTitle !== sourceTitle) {
        const slugFromTitle = localeTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        if (masterSlug.startsWith(slugFromTitle.slice(0, 20))) continue;
        return true;
      }
      // Pattern B: slug equals source-lang slug but title is translated
      // E.g., FR-source job: EN slug is still "vendeuse-vendeur-..." while EN title is "Sales Associate"
      if (sourceSlug && localeSlug === sourceSlug && localeTitle !== sourceTitle) {
        return true;
      }
    }
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

  // Build a multi-key lookup for assembled jobs.
  // Index by slug, locale slugs, previousSlugs, AND URL to handle all slug-mismatch cases.
  const assembledByKey = new Map();
  const _addKey = (key, job) => { if (key && !assembledByKey.has(key)) assembledByKey.set(key, job); };
  for (const job of assembledJobs) {
    const jobKey = normalizeCompanyKey(job.companyKey || job.company || '');
    if (jobKey !== companyKey) continue;
    _addKey(job.slug, job);
    // Index by URL (most stable identifier — never changes)
    if (job.url) _addKey(String(job.url).trim().toLowerCase(), job);
    // Index by all locale slugs so crawler jobs with old slugs can still match
    if (job.slugByLocale && typeof job.slugByLocale === 'object') {
      for (const localeSlug of Object.values(job.slugByLocale)) {
        const s = String(localeSlug || '').trim();
        if (s && !assembledByKey.has(s)) assembledByKey.set(s, job);
      }
    }
    // Index by previousSlugs — the assembled job may have renamed its main slug
    // and the crawler file still references the old one
    if (Array.isArray(job.previousSlugs)) {
      for (const s of job.previousSlugs) {
        if (s && !assembledByKey.has(s)) assembledByKey.set(s, job);
      }
    }
  }

  let updated = 0;
  for (const crawlerJob of crawlerData.jobs) {
    const assembled = assembledByKey.get(crawlerJob.slug)
      || (crawlerJob.url && assembledByKey.get(String(crawlerJob.url).trim().toLowerCase()))
      || null;
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
        // Only adopt assembled data that has non-empty values
        const nonEmpty = Object.fromEntries(
          Object.entries(assembled[field]).filter(([, v]) => String(v || '').trim())
        );
        if (Object.keys(nonEmpty).length > 0) {
          crawlerJob[field] = nonEmpty;
          changed = true;
        }
        continue;
      }
      for (const [locale, value] of Object.entries(assembled[field])) {
        const existing = crawlerJob[field][locale];
        const trimmedValue = String(value || '').trim();
        const trimmedExisting = String(existing || '').trim();
        // NEVER write empty assembled values (safety guard: AI may have failed).
        if (!trimmedValue) continue;
        // For slugByLocale: also overwrite when a locale's slug is still identical
        // to the master slug (= never localized). The assembled pipeline
        // (ensureLocaleFields) derives locale-specific slugs from translated titles,
        // but if the needsRetranslation flag was cleared before sync, those slugs
        // would be lost. The master slug is job.slug (source language), not
        // hardcoded to IT — jobs may be crawled in EN, DE, or FR.
        const sourceLang = crawlerJob.sourceLang || 'it';
        const masterSlug = String(crawlerJob.slug || '').trim();
        const isUnlocalizedSlug =
          field === 'slugByLocale' &&
          locale !== sourceLang &&
          trimmedExisting &&
          trimmedExisting === masterSlug &&
          trimmedValue !== trimmedExisting;
        if (isUnlocalizedSlug) {
          console.log(`     🔗 SLUG [${locale}] unlocalized → adopting: ${trimmedExisting.slice(0, 50)} → ${trimmedValue.slice(0, 50)}`);
        }
        // CRITICAL: Never overwrite the source-lang title with assembled data.
        // The crawler-extracted title (crawlerJob.title) is the canonical source.
        // AI can hallucinate source-lang titles (e.g. "Console Assicuravo" for "Consulente Assicurativo"),
        // and once synced here, the original is permanently destroyed.
        if (field === 'titleByLocale' && locale === sourceLang && crawlerJob.needsRetranslation) {
          // Preserve the canonical crawler title — skip this overwrite
          continue;
        }
        // For needsRetranslation jobs: always overwrite with assembled value.
        // The existing content was explicitly flagged as bad quality (wrong language,
        // untranslated copy of source, etc.) so any non-empty assembled value is better.
        // For normal jobs: only add where the crawler has no content, or adopt localized slugs.
        if (crawlerJob.needsRetranslation || !trimmedExisting || isUnlocalizedSlug) {
          // Before overwriting a slug, preserve the old value in previousSlugs
          // so the build plugin can generate bridge/redirect pages for SEO continuity.
          if (field === 'slugByLocale' && trimmedExisting && trimmedValue !== trimmedExisting) {
            console.log(`     📌 previousSlugs: preserving ${trimmedExisting.slice(0, 60)}`);
            if (!crawlerJob.previousSlugs) crawlerJob.previousSlugs = [];
            if (!crawlerJob.previousSlugs.includes(trimmedExisting)) {
              crawlerJob.previousSlugs.push(trimmedExisting);
            }
          }
          crawlerJob[field][locale] = value;
          changed = true;
        }
      }
    }

    // Sync previousSlugs from assembled dataset to per-crawler file so bridge pages
    // are generated even when slug changes happened in the assembled pipeline.
    // Note: do NOT filter out slugs that are still active in some locale. A slug like
    // "ingegnere-edile-jr-company-city" may still be slugByLocale.it but was previously
    // used for EN/DE/FR. Those locale-specific URLs need bridge pages too.
    if (assembled.previousSlugs && Array.isArray(assembled.previousSlugs)) {
      if (!crawlerJob.previousSlugs) crawlerJob.previousSlugs = [];
      for (const s of assembled.previousSlugs) {
        if (s && !crawlerJob.previousSlugs.includes(s)) {
          crawlerJob.previousSlugs.push(s);
          changed = true;
        }
      }
    }

    // Clear needsRetranslation flag only if job is now complete (all locales translated)
    if (crawlerJob.needsRetranslation && !isIncomplete(crawlerJob)) {
      console.log(`     ✅ Cleared needsRetranslation for: ${crawlerJob.slug?.slice(0, 60)}`);
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
  let pending = jobs.filter(needsTranslation);

  // Filter to a single company if --company-key is specified
  if (COMPANY_KEY_FILTER) {
    const before = pending.length;
    pending = pending.filter(j => normalizeCompanyKey(j.companyKey || j.company || '') === COMPANY_KEY_FILTER);
    console.log(`🎯 Company filter: ${COMPANY_KEY_FILTER} — ${pending.length}/${before} pending jobs match\n`);
  }

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

  // Fast-path: clear flags for jobs that are already complete (no AI call needed).
  // This handles the case where crawlers re-flag jobs that were already translated
  // (e.g. jobs with English titles identical across locales that triggered titleNeedsLocalization).
  const preCleared = clearRetranslationFlags(jobs);
  if (preCleared > 0) {
    fs.writeFileSync(DATA_JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n', 'utf-8');
    console.log(`⚡ Pre-cleared ${preCleared} flags for already-complete jobs (no AI needed)\n`);
    // Re-filter pending after pre-clear
    const stillPendingJobs = jobs.filter(needsTranslation);
    if (stillPendingJobs.length === 0) {
      console.log('✅ All jobs complete after pre-clear. Nothing left to translate.');
      // Sync cleared flags back to per-crawler files
      const companiesCleared = [...new Set(jobs
        .filter(j => !j.needsRetranslation)
        .map(j => normalizeCompanyKey(j.companyKey || j.company || ''))
        .filter(Boolean))];
      for (const key of companiesCleared) {
        const synced = syncTranslationsToCrawlerFile(key, jobs);
        if (synced > 0) console.log(`   📁 ${key}: ${synced} jobs synced`);
      }
      return;
    }
    // Update pending count, re-applying company filter if active
    pending.length = 0;
    const filtered = COMPANY_KEY_FILTER
      ? stillPendingJobs.filter(j => normalizeCompanyKey(j.companyKey || j.company || '') === COMPANY_KEY_FILTER)
      : stillPendingJobs;
    for (const j of filtered) pending.push(j);
    if (COMPANY_KEY_FILTER) {
      console.log(`🎯 Company filter re-applied after pre-clear: ${pending.length} jobs for ${COMPANY_KEY_FILTER}\n`);
    }
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
  const startTime = Date.now();

  for (const key of companyKeys) {
    const companyJobCount = companyJobCounts.get(key) || 0;

    // Time budget: stop before starting a new company if we're close to the limit.
    // This lets the workflow commit step run before the GitHub Actions timeout kills it.
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > TIME_BUDGET_MS) {
      const elapsedMin = Math.round(elapsedMs / 60_000);
      console.log(`\n⏰ Time budget reached (${elapsedMin}min elapsed) — stopping to allow commit step to run.`);
      console.log(`   ${totalFixed} jobs translated so far; ${companyKeys.length - companyKeys.indexOf(key)} companies remaining.`);
      break;
    }

    console.log(`\n🔄 [${totalProcessed + companyJobCount}/${effectiveMax}] Translating ${key} (${companyJobCount} jobs) — ${Math.round(elapsedMs / 60_000)}min elapsed...`);

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
