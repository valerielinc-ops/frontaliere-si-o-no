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
import { captureLostSlugs, normalizeForLengthComparison } from './lib/dedicated-crawler-common.mjs';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';

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
  const baseDesc = (job.description || '').trim();

  // Source locale 85% guard: if the source locale copy has lost significant content
  // compared to the authoritative base, the job needs reprocessing.
  // Guard: skip if base is unparsed HTML garbage (>10 tags).
  // Threshold 0.55: crawlers often clean raw descriptions (strip recruitment blurbs,
  // PDF links, footer text) so dbl[srcLang] is naturally 20-35% shorter than
  // job.description. Only flag when >45% of content is genuinely missing.
  const srcLang = job.sourceLang || 'it';
  if (baseDesc.length >= 120 && (baseDesc.match(/<[^>]+>/g) || []).length <= 10) {
    const currentSrc = (dbl[srcLang] || '').trim();
    if (currentSrc) {
      const normBase = normalizeForLengthComparison(baseDesc);
      const normSrc = normalizeForLengthComparison(currentSrc);
      if (normSrc.length / Math.max(1, normBase.length) < 0.55) return true;
    }
  }

  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();

    // Missing or too short
    if (title.length < MIN_TITLE_CHARS || desc.length < MIN_DESC_CHARS) return true;

    // Untranslated (title identical to source in a different language).
    // Guard: if at least one OTHER non-source locale has a different title, the job
    // has been translated — this locale just happens to match the source because it's
    // an international/corporate title (e.g. "Sales Assistant", "Senior Associate in
    // Digital Assurance"). Don't flag it.
    if (title.toLowerCase() === sourceTitle && locale !== (job.sourceLang || 'it')) {
      const srcLang = job.sourceLang || 'it';
      const otherLocalesTranslated = LOCALES.some(
        (l) => l !== locale && l !== srcLang && (tbl[l] || '').trim().toLowerCase() !== sourceTitle,
      );
      if (!otherLocalesTranslated) return true;
      // At least one other locale was translated → this is an international title, skip
    }

    // Description identical to source (not translated) — exact match
    if (desc.length > 0 && desc.toLowerCase() === sourceDesc && locale !== (job.sourceLang || 'it')) return true;

    // Description near-identical to source (whitespace-normalized match) — catches
    // crawler-seeded copies where the description got stripped of newlines but
    // still contains the raw untranslated source text.
    if (desc.length >= MIN_DESC_CHARS && locale !== (job.sourceLang || 'it')) {
      const normDesc = normalizeForLengthComparison(desc).toLowerCase();
      const normSource = normalizeForLengthComparison(baseDesc).toLowerCase();
      if (normSource.length >= MIN_DESC_CHARS && normDesc === normSource) return true;
    }

    // Cross-locale description contamination: description text detected as a
    // DIFFERENT language than the locale slot it sits in. This catches:
    //   1. Crawler seed-copies of source text that weren't translated
    //   2. AI translation that wrote to the wrong locale slot
    //   3. Locale slots polluted with a different translation pass
    // Only flag when detection is confident (>=0.65) and the detected language
    // is actually one of our supported locales (avoid false positives on short
    // or mixed-language text). Aligned with title contamination threshold (0.65)
    // to reduce false positives from Romance-language cognates (IT/FR share many words).
    if (desc.length >= MIN_DESC_CHARS) {
      const detected = detectLanguageWithConfidence(desc, locale);
      if (
        detected.confidence >= 0.65 &&
        detected.lang !== locale &&
        LOCALES.includes(detected.lang)
      ) {
        return true;
      }
    }

    // Thin translation: locale description is suspiciously short compared to the source.
    // Language-pair aware thresholds — Italian is the most verbose Romance language,
    // so IT→DE/FR translations naturally compress 40-50%. FR/DE sources also compress.
    // Only EN source uses the stricter 0.55 threshold (EN→other compression is minimal).
    if (locale !== (job.sourceLang || 'it') && desc.length > 0) {
      const srcLangThin = job.sourceLang || 'it';
      const srcDesc = (dbl[srcLangThin] || job.description || '').trim();
      if (srcDesc.length >= 500) {
        const normDesc = normalizeForLengthComparison(desc);
        const normSrc = normalizeForLengthComparison(srcDesc);
        // IT source compresses heavily to DE/FR (40-50% normal) → 0.45
        // FR/DE source compresses to other languages → 0.50
        // EN source has minimal compression → 0.55
        const thinRatio = srcLangThin === 'it' ? 0.45
          : (srcLangThin === 'fr' || srcLangThin === 'de') ? 0.50
          : 0.55;
        if (normSrc.length >= 500 && normDesc.length < normSrc.length * thinRatio) return true;
      }
    }

    // Cross-locale contamination: title detected as SOURCE language in a non-source slot.
    // Guard: if other non-source locales have different titles, the job WAS translated.
    // The "contaminated" locale likely just contains cognates or loanwords (e.g. FR "des"
    // matching DE stop-word, FR "collaborateur" matching IT "collaborat"). Only flag if
    // NO other locale was translated — meaning the job truly wasn't processed.
    if (locale !== (job.sourceLang || 'it') && title.length >= 8) {
      const srcLang = job.sourceLang || 'it';
      // Skip contamination check if other locales prove translation happened
      const otherLocalesTranslated = LOCALES.some(
        (l) => l !== locale && l !== srcLang && (tbl[l] || '').trim().toLowerCase() !== sourceTitle,
      );
      if (!otherLocalesTranslated) {
        // No other locale was translated — contamination check is relevant
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
  }

  // NOTE: Slug localization is NOT checked here anymore.
  // Slugs are a cosmetic concern handled by Phase 3 (regenerate-slugs-by-locale.mjs).
  // Previously, slug checks here caused an infinite loop:
  //   isIncomplete() flags for slug → clearRetranslationFlags can't clear →
  //   translate pipeline re-processes job → no translation needed → flag stays → repeat
  // 342 jobs were stuck in this loop. Slugs are now decoupled from translation completeness.

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

    // Snapshot slugByLocale before merge so captureLostSlugs can detect changes.
    const slugByLocaleBefore = { ...(crawlerJob.slugByLocale || {}) };
    const slugBefore = String(crawlerJob.slug || '').trim();

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
          continue;
        }
        // STABILITY: For titles that are already CORRECTLY translated, don't overwrite
        // with a new AI translation (AI generates inconsistent translations across runs).
        // BUT: allow overwrite when the existing title is in the WRONG language
        // (e.g., Italian text "Assemblaggio / Imballo" sitting in the DE slot).
        if (field === 'titleByLocale' && crawlerJob.needsRetranslation && trimmedExisting && trimmedValue) {
          const sourceTitle = String(crawlerJob.title || '').trim().toLowerCase();
          const isSourceCopy = trimmedExisting.toLowerCase() === sourceTitle;
          // Check if existing title is in the wrong language (source-lang contamination)
          const detected = detectJobTitleLocaleDetails(trimmedExisting, locale);
          const isWrongLanguage = detected.confidence >= 0.6 && detected.lang === sourceLang && locale !== sourceLang;
          // Also check source-language words in wrong locale slots.
          // IMPORTANT: only match words from the ACTUAL source language, not words
          // that happen to appear in mixed-language titles.
          const lc = trimmedExisting.toLowerCase();
          const hasSourceWords =
            (sourceLang === 'it' && locale !== 'it' && /\b(per il|per la|assemblaggio|imballo|collaudo|responsabile|impiegat)\b/i.test(lc)) ||
            (sourceLang === 'de' && locale !== 'de' && /\b(und|für|mit fokus|der|die|fachspezialist)\b/i.test(lc));
          if (!isSourceCopy && !isWrongLanguage && !hasSourceWords) {
            // Title is correctly translated — keep it stable
            continue;
          }
        }
        // GUARD: never overwrite a translated title with a source copy from the assembled data.
        // The shared crawler may produce source-copy titles for jobs it couldn't translate.
        if (field === 'titleByLocale' && trimmedExisting && trimmedValue && locale !== sourceLang) {
          const srcTitle = String(crawlerJob.title || '').trim().toLowerCase();
          const assembledIsCopy = trimmedValue.toLowerCase() === srcTitle;
          const existingIsCopy = trimmedExisting.toLowerCase() === srcTitle;
          if (assembledIsCopy && !existingIsCopy) {
            // Assembled is WORSE (source copy), existing is better (translated) — skip
            continue;
          }
        }
        // For needsRetranslation jobs: overwrite with assembled value if it's an improvement.
        // For normal jobs: only add where the crawler has no content, or adopt localized slugs.
        if (crawlerJob.needsRetranslation || !trimmedExisting || isUnlocalizedSlug) {
          crawlerJob[field][locale] = value;
          changed = true;
        }
      }
    }

    // Capture any slugs lost during the locale field merge above.
    const captured = captureLostSlugs(crawlerJob, slugByLocaleBefore, slugBefore);
    if (captured.length > 0) {
      console.log(`     📌 previousSlugs: preserved ${captured.length} lost slug(s)`);
      changed = true;
    }

    // Sync previousSlugs from assembled dataset to per-crawler file so bridge pages
    // are generated even when slug changes happened in the assembled pipeline.
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

  // FIRST: scan per-crawler files DIRECTLY for orphaned needsRetranslation flags.
  // Some crawler files have jobs that don't make it into the assembled dataset
  // (e.g. failed quality gate). This runs unconditionally before any early exit.
  let directCleared = 0;
  if (fs.existsSync(BY_CRAWLER_DIR)) {
    for (const file of fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json') && !f.includes('-locale-cache'))) {
      const filePath = path.join(BY_CRAWLER_DIR, file);
      const crawlerData = readJson(filePath);
      if (!crawlerData?.jobs || !Array.isArray(crawlerData.jobs)) continue;
      let fileChanged = false;
      for (const job of crawlerData.jobs) {
        if (job.needsRetranslation && !isIncomplete(job)) {
          delete job.needsRetranslation;
          directCleared++;
          fileChanged = true;
        }
      }
      if (fileChanged) {
        fs.writeFileSync(filePath, JSON.stringify(crawlerData, null, 2) + '\n', 'utf-8');
      }
    }
  }
  if (directCleared > 0) {
    console.log(`⚡ Cleared ${directCleared} stale needsRetranslation flags from per-crawler files\n`);
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
  const preCleared = clearRetranslationFlags(jobs);
  if (preCleared > 0) {
    fs.writeFileSync(DATA_JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n', 'utf-8');
    console.log(`⚡ Pre-cleared ${preCleared} flags for already-complete jobs in assembled dataset`);
    console.log('');

    // Re-filter pending after pre-clear
    const stillPendingJobs = jobs.filter(needsTranslation);
    if (stillPendingJobs.length === 0) {
      console.log('✅ All jobs complete after pre-clear. Nothing left to translate.');
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
          console.log(`   ℹ️  ${key}: no flags cleared this pass`);
          // Diagnose: how many jobs for this company are still incomplete after crawler ran?
          const companyJobs = currentJobs.filter(j =>
            normalizeCompanyKey(j.companyKey || j.company || '') === normalizeCompanyKey(key));
          const companyIncomplete = companyJobs.filter(j => needsTranslation(j));
          if (companyIncomplete.length > 0) {
            console.log(`   🔬 ${key}: ${companyIncomplete.length}/${companyJobs.length} still pending after crawler`);
            for (const j of companyIncomplete.slice(0, 3)) {
              const tbl = j.titleByLocale || {};
              const src = (j.title || '').trim().toLowerCase();
              const info = LOCALES.map(l => {
                const t = (tbl[l] || '').trim();
                if (!t) return `${l}:EMPTY`;
                if (t.toLowerCase() === src) return `${l}:=src`;
                return `${l}:ok(${t.length})`;
              }).join(' ');
              console.log(`      "${j.title?.slice(0, 50)}" titles:[${info}] flag:${!!j.needsRetranslation}`);
            }
          }
        }

        // ALWAYS sync improvements to per-crawler files, even when not all flags cleared.
        // Previously, sync was gated on cleared > 0, creating a loop: shared crawler
        // improved translations in jobs.json, but improvements never reached per-crawler
        // slices (source of truth). Next assemble started from stale data.
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

  // ── Retry pass: re-attempt companies that had partial success ──────────
  // Rate limits often clear partway through a run. Companies processed early
  // may have had failures that would succeed now. Only retry if we have time.
  const retryElapsedMs = Date.now() - startTime;
  if (totalFixed > 0 && retryElapsedMs < TIME_BUDGET_MS * 0.85) {
    const retryJobs = readJson(DATA_JOBS_PATH);
    const retryPending = Array.isArray(retryJobs)
      ? retryJobs.filter(j => j.needsRetranslation && needsTranslation(j))
      : [];

    // Only retry companies that had at least one success (partial failure)
    const retryCompanies = new Map();
    for (const j of retryPending) {
      const k = normalizeCompanyKey(j.companyKey || j.company || '');
      if (k && companyJobCounts.has(k)) {
        retryCompanies.set(k, (retryCompanies.get(k) || 0) + 1);
      }
    }

    if (retryCompanies.size > 0) {
      const retryTotal = [...retryCompanies.values()].reduce((a, b) => a + b, 0);
      console.log(`\n🔁 Retry pass: ${retryTotal} jobs across ${retryCompanies.size} companies still pending...`);

      for (const [key, count] of retryCompanies) {
        const retryNow = Date.now() - startTime;
        if (retryNow > TIME_BUDGET_MS * 0.95) {
          console.log(`   ⏰ Time budget reached during retry — stopping`);
          break;
        }

        console.log(`   🔁 Retrying ${key} (${count} jobs)...`);
        try {
          await runSharedCrawler([key], count);
          const afterRetry = readJson(DATA_JOBS_PATH);
          if (Array.isArray(afterRetry)) {
            const cleared = clearRetranslationFlags(afterRetry);
            if (cleared > 0) {
              fs.writeFileSync(DATA_JOBS_PATH, JSON.stringify(afterRetry, null, 2) + '\n', 'utf-8');
              totalFixed += cleared;
              console.log(`   ✅ ${key} retry: ${cleared} more jobs translated`);
              syncTranslationsToCrawlerFile(key, afterRetry);
            }
          }
        } catch {
          console.log(`   ⚠️  ${key} retry failed — will be picked up by next scheduled run`);
        }
      }
    }
  }

  // Final summary — use saved slug set instead of re-reading data/jobs.json
  // (data/jobs.json is gitignored and gets rewritten by the shared crawler with
  // stripCopyPasteLocales, causing a measurement drift that doesn't reflect reality)
  const afterJobs = readJson(DATA_JOBS_PATH);
  const afterPendingJobs = Array.isArray(afterJobs) ? afterJobs.filter(needsTranslation) : [];
  const stillPending = afterPendingJobs.length;
  const fixed = totalFixed; // use actual cleared count, not before-after diff

  console.log(`\n📈 Re-localization results:`);
  console.log(`   Before: ${pending.length} pending (${flaggedCount} flagged)`);
  console.log(`   After (re-scan): ${stillPending} pending`);
  console.log(`   Actually fixed:  ${fixed} flags cleared`);
  if (stillPending > pending.length) {
    console.log(`   ⚠️  Re-scan shows +${stillPending - pending.length} — this is a measurement artifact from`);
    console.log(`      stripCopyPasteLocales in shared crawler (not applied by assemble-jobs-dataset).`);
    console.log(`      The per-crawler files (source of truth) were not degraded.`);
  }

  // Categorize remaining pending jobs for visibility
  const categories = { flagged: 0, sourceCopyTitle: 0, sourceCopyDesc: 0, emptyLocale: 0, contaminated: 0 };
  for (const job of afterPendingJobs) {
    if (job.needsRetranslation) { categories.flagged++; continue; }
    const tbl = job.titleByLocale || {};
    const dbl = job.descriptionByLocale || {};
    const src = (job.title || '').trim().toLowerCase();
    const srcDesc = (job.description || '').trim().toLowerCase();
    let categorized = false;
    for (const locale of LOCALES) {
      const t = (tbl[locale] || '').trim();
      const d = (dbl[locale] || '').trim();
      if (t.length < MIN_TITLE_CHARS || d.length < MIN_DESC_CHARS) { categories.emptyLocale++; categorized = true; break; }
      if (d.toLowerCase() === srcDesc && locale !== (job.sourceLang || 'it')) { categories.sourceCopyDesc++; categorized = true; break; }
      if (t.toLowerCase() === src && locale !== (job.sourceLang || 'it')) { categories.sourceCopyTitle++; categorized = true; break; }
    }
    if (!categorized) categories.contaminated++;
  }
  console.log(`\n📊 Pending breakdown:`);
  console.log(`   🚩 ${categories.flagged} flagged (needsRetranslation)`);
  console.log(`   📝 ${categories.emptyLocale} empty/short locale fields`);
  console.log(`   🔄 ${categories.sourceCopyTitle} title source copies`);
  console.log(`   📋 ${categories.sourceCopyDesc} description source copies`);
  console.log(`   🔍 ${categories.contaminated} contamination-detected\n`);

  console.log('✅ Re-localization complete.');
}

main().catch((err) => {
  console.error('❌ Re-localization failed:', err?.message || err);
  process.exit(1);
});
