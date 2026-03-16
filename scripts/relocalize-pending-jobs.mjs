#!/usr/bin/env node
/**
 * Re-localize jobs with incomplete locale coverage.
 *
 * Problem: Dedicated crawlers run on staggered cron schedules throughout the
 * UTC day (currently up to 10:45 UTC). Late-running crawlers (USI 06:45,
 * Cornèr 08:25, Schindler 08:35, Galenica 10:15, Manor 10:45, etc.) often
 * find all AI models exhausted because earlier crawlers have consumed the
 * daily free-tier quotas across GitHub Models, Gemini, Groq, and OpenRouter.
 *
 * Solution: This script runs on the following UTC day AFTER daily quotas reset,
 * once the previous day's dedicated crawlers have all finished. A backup
 * scheduled run later in the night covers GitHub Actions cron delays. It
 * identifies jobs with incomplete translations (< 4 locales with adequate
 * title/description) and runs the shared crawler in LOCALIZE_EXISTING_ONLY
 * mode to fill the gaps.
 *
 * Usage:
 *   node scripts/relocalize-pending-jobs.mjs
 *
 * Environment:
 *   - Requires the same API keys as the shared crawler (GH_MODELS_PAT, etc.)
 *   - GOOGLE_APPLICATION_CREDENTIALS for Firestore-backed score store
 *   - RELOCALIZE_MAX_JOBS — max jobs to re-localize (default: 120)
 *   - RELOCALIZE_DRY_RUN — set to '1' to only report, not run (default: '0')
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;
const MAX_JOBS = Number(process.env.RELOCALIZE_MAX_JOBS) || 120;
const DRY_RUN = String(process.env.RELOCALIZE_DRY_RUN || '0') === '1';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
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
 * Run the shared crawler in LOCALIZE_EXISTING_ONLY mode.
 */
function runSharedCrawler(companyKeys, maxJobs) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      JOBS_CRAWLER_COMPANY_KEYS: companyKeys.join(','),
      JOBS_CRAWLER_FORCE_LOCALIZE_KEYS: companyKeys.join(','),
      JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY: '1',
      JOBS_AI_LOCALIZATION_ENABLED: '1',
      JOBS_AI_MAX_JOBS_PER_RUN: String(maxJobs),
      JOBS_FORCE_LOCALIZE_WORKDAY: '0',
      JOBS_SKIP_CRAWL_CHANGE_SUMMARY: '1',
    };

    console.log(`\n🚀 Running shared crawler in LOCALIZE_EXISTING_ONLY mode...`);
    console.log(`   Company keys: ${companyKeys.join(', ')}`);
    console.log(`   Max AI jobs: ${maxJobs}\n`);

    const child = spawn('node', ['scripts/lib/shared-jobs-crawler.mjs'], {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`shared-jobs-crawler exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('🔍 Scanning for jobs with incomplete locale coverage...\n');

  if (!fs.existsSync(DATA_JOBS_PATH)) {
    console.log('ℹ️  data/jobs.json not found — nothing to re-localize.');
    return;
  }

  const jobs = readJson(DATA_JOBS_PATH);
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log('ℹ️  No jobs found in data/jobs.json.');
    return;
  }

  // Find incomplete jobs
  const incomplete = jobs.filter(isIncomplete);

  if (incomplete.length === 0) {
    console.log('✅ All jobs have complete locale coverage. Nothing to re-localize.');
    return;
  }

  // Group by company
  const byCompany = {};
  for (const job of incomplete) {
    const company = job.company || 'unknown';
    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(job);
  }

  // Report
  console.log(`📊 Found ${incomplete.length}/${jobs.length} jobs with incomplete locale coverage:\n`);
  const sorted = Object.entries(byCompany).sort((a, b) => b[1].length - a[1].length);
  for (const [company, companyJobs] of sorted) {
    const key = normalizeCompanyKey(company);
    console.log(`   ${String(companyJobs.length).padStart(3)} jobs — ${company} (key: ${key})`);
  }

  if (DRY_RUN) {
    console.log('\n🏁 Dry run — skipping re-localization.');
    return;
  }

  // Extract unique company keys, capped at MAX_JOBS
  const companyKeys = [...new Set(
    incomplete
      .slice(0, MAX_JOBS)
      .map(j => normalizeCompanyKey(j.companyKey || j.company || ''))
      .filter(Boolean)
  )];

  if (companyKeys.length === 0) {
    console.log('⚠️  No valid company keys found. Skipping.');
    return;
  }

  const effectiveMax = Math.min(MAX_JOBS, incomplete.length);
  console.log(`\n🔄 Re-localizing up to ${effectiveMax} jobs across ${companyKeys.length} companies...`);

  await runSharedCrawler(companyKeys, effectiveMax);

  // Report results
  const afterJobs = readJson(DATA_JOBS_PATH);
  if (Array.isArray(afterJobs)) {
    const stillIncomplete = afterJobs.filter(isIncomplete).length;
    const fixed = incomplete.length - stillIncomplete;
    console.log(`\n📈 Re-localization results:`);
    console.log(`   Before: ${incomplete.length} incomplete`);
    console.log(`   After:  ${stillIncomplete} incomplete`);
    console.log(`   Fixed:  ${fixed} jobs\n`);
  }

  console.log('✅ Re-localization complete.');
}

main().catch((err) => {
  console.error('❌ Re-localization failed:', err?.message || err);
  process.exit(1);
});
