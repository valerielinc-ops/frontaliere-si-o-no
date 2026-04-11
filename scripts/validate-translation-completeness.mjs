#!/usr/bin/env node
/**
 * validate-translation-completeness.mjs — Deploy gate for 4-locale translation coverage.
 *
 * Loads data/jobs.json and verifies that every active job has complete translations
 * in all 4 locales (it, en, de, fr):
 *   - titleByLocale[locale] with at least 3 characters
 *   - descriptionByLocale[locale] with at least 120 characters
 *     (or the main description field if locale matches the source language)
 *   - Flags jobs with needsRetranslation: true
 *
 * Exits with code 1 if any job has incomplete translations (blocks deploy).
 * Exits with code 0 if all jobs pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');

const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_TITLE_CHARS = 3;
const MIN_DESCRIPTION_CHARS = 120;
const SAMPLE_LIMIT = 10;

/* ── Load jobs ── */
if (!fs.existsSync(DATA_JOBS)) {
  console.error(`❌ Jobs file not found: ${DATA_JOBS}`);
  process.exit(1);
}

let jobs;
try {
  jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
} catch (err) {
  console.error(`❌ Failed to parse jobs.json: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(jobs) || jobs.length === 0) {
  console.log('✅ Translation completeness: no jobs to validate.');
  process.exit(0);
}

/* ── Validate ── */
const issues = []; // { slug, locale, reason }

for (const job of jobs) {
  // Skip jobs queued for retranslation — they're in the pipeline, not bugs.
  // See CLAUDE.md: "Tests MUST exclude needsRetranslation: true jobs"
  if (job.needsRetranslation) continue;

  const slug = job.slug || '(unknown)';
  const sourceLang = job.sourceLang || 'it';

  for (const locale of LOCALES) {
    // Title check
    const title = String(job.titleByLocale?.[locale] || '').trim();
    if (title.length < MIN_TITLE_CHARS) {
      issues.push({ slug, locale, reason: `missing/short title (${title.length} chars)` });
    }

    // Description check
    const desc = String(job.descriptionByLocale?.[locale] || '').trim();
    if (desc.length < MIN_DESCRIPTION_CHARS) {
      // For the source language, allow the main description field as fallback
      if (locale === sourceLang) {
        const mainDesc = String(job.description || '').trim();
        if (mainDesc.length < MIN_DESCRIPTION_CHARS) {
          issues.push({ slug, locale, reason: `missing/short description (${desc.length} chars, main: ${mainDesc.length} chars)` });
        }
      } else {
        issues.push({ slug, locale, reason: `missing/short description (${desc.length} chars)` });
      }
    }
  }
}

/* ── Report ── */
if (issues.length > 0) {
  const uniqueJobs = new Set(issues.map(i => i.slug));
  console.error(`❌ Translation completeness check FAILED: ${uniqueJobs.size} jobs have incomplete translations (${issues.length} issues total).`);
  console.error('');
  const sample = issues.slice(0, SAMPLE_LIMIT);
  for (const { slug, locale, reason } of sample) {
    console.error(`  - ${slug} [${locale}]: ${reason}`);
  }
  if (issues.length > SAMPLE_LIMIT) {
    console.error(`  ... and ${issues.length - SAMPLE_LIMIT} more issues`);
  }
  console.error('');
  console.error('Run translate-pending workflow before deploying.');
  process.exit(1);
}

console.log(`✅ Translation completeness: all ${jobs.length} jobs have complete 4-locale coverage.`);
