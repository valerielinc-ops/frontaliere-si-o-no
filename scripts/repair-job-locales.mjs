#!/usr/bin/env node
/**
 * Repair Job Locales — Standalone Translation Repair Script
 *
 * Scans per-crawler slice files for jobs with missing locale translations
 * (titleByLocale / descriptionByLocale) and fills them using the
 * free translation cascade: DeepL → MyMemory → Google Translate.
 *
 * Operates on per-crawler slices in data/jobs/by-crawler/ (the committed
 * source of truth). Falls back to data/jobs.json if it exists (e.g. after
 * local assembly).
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
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

function listSliceFiles() {
  if (!fs.existsSync(SLICES_DIR)) return [];
  return fs
    .readdirSync(SLICES_DIR)
    .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    .map((f) => path.join(SLICES_DIR, f))
    .sort();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function analyzeGapsInJobs(jobs) {
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
  return gaps;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const maxArg = args.find(a => a.startsWith('--max='));
  const maxJobs = maxArg ? parseInt(maxArg.split('=')[1], 10) || 0 : 0;

  const sliceFiles = listSliceFiles();

  if (sliceFiles.length === 0) {
    // Fallback to assembled jobs.json if slices don't exist
    if (fs.existsSync(DATA_JOBS)) {
      console.log('ℹ️  No per-crawler slices found. Falling back to data/jobs.json...');
      await repairSingleFile(DATA_JOBS, dryRun, maxJobs);
      return;
    }
    console.log('❌ No per-crawler slices or data/jobs.json found.');
    process.exitCode = 1;
    return;
  }

  console.log(`🔍 Analyzing locale gaps across ${sliceFiles.length} per-crawler slices...\n`);

  let totalJobs = 0;
  let totalGaps = 0;
  const slicesWithGaps = [];

  for (const slicePath of sliceFiles) {
    const slice = readJson(slicePath, null);
    if (!slice || !Array.isArray(slice.jobs)) continue;
    const gaps = analyzeGapsInJobs(slice.jobs);
    totalJobs += slice.jobs.length;
    totalGaps += gaps.length;
    if (gaps.length > 0) {
      slicesWithGaps.push({ slicePath, slice, gaps });
    }
  }

  console.log(`Total jobs across slices: ${totalJobs}`);
  console.log(`Jobs with locale gaps: ${totalGaps}`);

  if (totalGaps === 0) {
    console.log('\n✅ All jobs have complete locale translations!');
    return;
  }

  // Show gaps by slice
  console.log('\nGaps by crawler:');
  for (const { slicePath, gaps } of slicesWithGaps.sort((a, b) => b.gaps.length - a.gaps.length)) {
    console.log(`  ${path.basename(slicePath, '.json')}: ${gaps.length} jobs`);
  }

  if (dryRun) {
    console.log('\n⏭️  Dry run — no translations performed.');
    return;
  }

  console.log(`\n🌍 Translating missing locales${maxJobs > 0 ? ` (max ${maxJobs} jobs)` : ''}...`);
  const startTime = Date.now();

  let totalTranslated = 0;
  let remaining = maxJobs || Infinity;

  for (const { slicePath, slice } of slicesWithGaps) {
    if (remaining <= 0) break;

    // Write jobs to a temp file for translateMissingJobLocales
    const tmpPath = slicePath + '.repair-tmp.json';
    writeJson(tmpPath, slice.jobs);

    try {
      const result = await translateMissingJobLocales({
        dataJobsPath: tmpPath,
        maxJobs: remaining,
      });

      if (result.changed) {
        // Read translated jobs back and update the slice
        const repairedJobs = readJson(tmpPath, slice.jobs);
        const envelope = { ...slice, jobs: repairedJobs, assembledAt: new Date().toISOString() };
        writeJson(slicePath, envelope);
        totalTranslated += result.translated;
        remaining -= result.translated;
        console.log(`  ✅ ${path.basename(slicePath, '.json')}: translated ${result.translated} jobs`);
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Translated ${totalTranslated} jobs across ${slicesWithGaps.length} slices in ${elapsed}s`);
}

async function repairSingleFile(filePath, dryRun, maxJobs) {
  const jobs = readJson(filePath, []);
  const gaps = analyzeGapsInJobs(jobs);

  console.log(`Total jobs: ${jobs.length}`);
  console.log(`Jobs with locale gaps: ${gaps.length}`);

  if (gaps.length === 0) {
    console.log('\n✅ All jobs have complete locale translations!');
    return;
  }

  if (dryRun) {
    console.log('\n⏭️  Dry run — no translations performed.');
    return;
  }

  console.log(`\n🌍 Translating missing locales${maxJobs > 0 ? ` (max ${maxJobs} jobs)` : ''}...`);
  const result = await translateMissingJobLocales({ dataJobsPath: filePath, maxJobs });

  if (result.changed) {
    console.log(`\n✅ Translated ${result.translated}/${result.total} jobs`);
  } else {
    console.log('\n✅ No translations needed.');
  }
}

main().catch((err) => {
  console.error('❌ Repair failed:', err?.message || err);
  process.exitCode = 1;
});
