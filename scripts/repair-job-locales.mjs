#!/usr/bin/env node
/**
 * Repair Job Locales — Standalone Translation Repair Script
 *
 * Scans data/jobs.json for jobs with missing locale translations
 * (titleByLocale / descriptionByLocale) and fills them using the
 * free translation cascade: DeepL → MyMemory → Google Translate.
 *
 * Usage:
 *   node scripts/repair-job-locales.mjs              # Translate all gaps
 *   node scripts/repair-job-locales.mjs --max=20     # Translate up to 20 jobs
 *   node scripts/repair-job-locales.mjs --dry-run    # Show gaps without translating
 *
 * Environment:
 *   DEEPL_API_KEY — Optional. If set, DeepL is tried first (highest quality).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateMissingJobLocales } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_JOBS = path.resolve(__dirname, '..', 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

function analyzeGaps() {
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const gaps = [];
  for (const job of jobs) {
    const tl = job.titleByLocale || {};
    const dl = job.descriptionByLocale || {};
    const missingTitle = LOCALES.filter(l => !(tl[l] || '').trim());
    const missingDesc = LOCALES.filter(l => !(dl[l] || '').trim());
    if (missingTitle.length > 0 || missingDesc.length > 0) {
      gaps.push({
        company: job.company || '?',
        slug: job.slug || '?',
        missingTitle,
        missingDesc,
      });
    }
  }
  return { total: jobs.length, gaps };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const maxArg = args.find(a => a.startsWith('--max='));
  const maxJobs = maxArg ? parseInt(maxArg.split('=')[1], 10) || 0 : 0;

  console.log('🔍 Analyzing locale gaps in data/jobs.json...\n');

  const { total, gaps } = analyzeGaps();
  console.log(`Total jobs: ${total}`);
  console.log(`Jobs with locale gaps: ${gaps.length}`);

  if (gaps.length === 0) {
    console.log('\n✅ All jobs have complete locale translations!');
    return;
  }

  // Show gap details
  const byCompany = {};
  for (const g of gaps) {
    byCompany[g.company] = (byCompany[g.company] || 0) + 1;
  }
  console.log('\nGaps by company:');
  for (const [company, count] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${company}: ${count} jobs`);
  }

  console.log('\nDetailed gaps (first 20):');
  for (const g of gaps.slice(0, 20)) {
    const parts = [];
    if (g.missingTitle.length) parts.push(`title: ${g.missingTitle.join(',')}`);
    if (g.missingDesc.length) parts.push(`desc: ${g.missingDesc.join(',')}`);
    console.log(`  ${g.company} / ${g.slug.slice(0, 60)} → ${parts.join(' | ')}`);
  }
  if (gaps.length > 20) console.log(`  … +${gaps.length - 20} more`);

  if (dryRun) {
    console.log('\n⏭️  Dry run — no translations performed.');
    return;
  }

  console.log(`\n🌍 Translating missing locales${maxJobs > 0 ? ` (max ${maxJobs} jobs)` : ''}...`);
  const startTime = Date.now();

  const result = await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    maxJobs,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.changed) {
    console.log(`\n✅ Translated ${result.translated}/${result.total} jobs in ${elapsed}s`);
    for (const d of result.details.slice(0, 20)) {
      console.log(`  ✓ ${d.company} / ${d.slug?.slice(0, 50)} (source: ${d.sourceLang})`);
    }
    if (result.details.length > 20) console.log(`  … +${result.details.length - 20} more`);

    // Re-analyze to show remaining gaps
    const after = analyzeGaps();
    if (after.gaps.length > 0) {
      console.log(`\n⚠️  ${after.gaps.length} jobs still have gaps (translation services may have failed).`);
    } else {
      console.log('\n🎉 All jobs now have complete locale translations!');
    }
  } else {
    console.log(`\n✅ No translations needed (${elapsed}s).`);
  }
}

main().catch((err) => {
  console.error('❌ Repair failed:', err?.message || err);
  process.exitCode = 1;
});
