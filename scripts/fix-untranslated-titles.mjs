#!/usr/bin/env node
/**
 * fix-untranslated-titles.mjs — One-shot batch fix for jobs with source-copy titles.
 *
 * Finds jobs where titleByLocale[locale] is an exact copy of the source title
 * and translates them using the free-translate cascade (DeepL → MyMemory → etc).
 *
 * Does NOT use AI/LLM — only the free cascade. Fast, cheap, reliable.
 * Does NOT modify descriptions, slugs, or needsRetranslation flags.
 *
 * Usage:
 *   DEEPL_API_KEY=xxx DEEPL_API_KEY_2=yyy node scripts/fix-untranslated-titles.mjs [--dry-run]
 *
 * Env:
 *   UNTRANSLATED_TITLE_FIX_DEADLINE_MS — run-wide wall-clock deadline measured
 *     from the translate-pending run marker (default 300*60*1000). Standalone
 *     runs without a marker use this process's start time; the workflow fails
 *     closed if its marker is missing.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';
import { isTitleSourceCopy, titleContainsLlmReasoning, titleLooksUntranslated } from './lib/job-locale-utils.mjs';
import { resolveRunStartMs } from './lib/translate-run-clock.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const TITLE_FIX_STATE_PATH = path.resolve(__dirname, '..', 'data', 'translation-title-fix-attempts.json');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');
// Run-wide deadline measured from the shared translate-pending start marker.
// Standalone invocations keep a local fallback; the workflow requires the marker.
const TITLE_FIX_DEADLINE_MS = Number(process.env.UNTRANSLATED_TITLE_FIX_DEADLINE_MS)
  || 300 * 60 * 1000;
const RUN_START_MS = resolveRunStartMs();

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function readAttemptState() {
  try {
    const value = readJson(TITLE_FIX_STATE_PATH);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { version: 1, attempts: value.attempts && typeof value.attempts === 'object' ? value.attempts : {} }
      : { version: 1, attempts: {} };
  } catch {
    return { version: 1, attempts: {} };
  }
}

function titleFixAttemptKey(file, job, jobIdx, locale) {
  const identity = job.id || job.url || job.slug || `${file}#${jobIdx}`;
  return `${identity}|${job.sourceLang || 'it'}|${locale}`;
}

function dateMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

async function main() {
  const files = listSliceFileNames(BY_CRAWLER_DIR).sort();
  const attemptState = readAttemptState();
  const candidates = [];
  const sliceCache = new Map();

  // Discover the whole queue before calling the cascade. Alphabetical slice
  // order used to spend the daily cap on the same early companies forever.
  // A small persisted attempt ledger makes never-tried locale slots win first;
  // firstSeenAt then gives older backlog priority within the same class.
  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    sliceCache.set(file, sliceData);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    for (let jobIdx = 0; jobIdx < jobs.length; jobIdx++) {
      const job = jobs[jobIdx];
      const sl = job.sourceLang || 'it';
      const sourceTitle = (job.title || '').trim();
      if (!sourceTitle) continue;
      const tbl = job.titleByLocale || {};
      for (const locale of LOCALES) {
        if (locale === sl) continue;
        const existing = String(tbl[locale] || '').trim();
        if (!existing) continue;
        const verdict = titleLooksUntranslated({
          title: existing,
          sourceTitle,
          sourceLang: sl,
          targetLocale: locale,
          company: job.company || '',
          location: job.addressLocality || job.location || '',
        });
        if (verdict.reason !== 'source-copy' && verdict.reason !== 'llm-reasoning') continue;
        const key = titleFixAttemptKey(file, job, jobIdx, locale);
        candidates.push({
          file,
          jobIdx,
          locale,
          key,
          reason: verdict.reason,
          attempts: Number(attemptState.attempts[key]?.attempts) || 0,
          firstSeenAt: job.firstSeenAt || job.crawledAt || '',
        });
      }
    }
  }
  candidates.sort((a, b) =>
    (a.attempts === 0 ? 0 : 1) - (b.attempts === 0 ? 0 : 1)
    || dateMs(a.firstSeenAt) - dateMs(b.firstSeenAt)
    || a.file.localeCompare(b.file)
    || a.jobIdx - b.jobIdx
    || a.locale.localeCompare(b.locale));

  let totalFixed = 0;
  let totalNoop = 0;
  let totalFailed = 0;
  let slicesChanged = 0;
  const budgetOk = () => (Date.now() - RUN_START_MS) < TITLE_FIX_DEADLINE_MS;
  let deadlineReached = false;
  const changedFiles = new Set();
  let stateChanged = false;

  console.log(`🔧 Fixing title repair candidates across ${files.length} slices (${candidates.length} slots)...`);
  if (DRY_RUN) console.log('   (DRY RUN — no files will be modified)\n');

  for (const candidate of candidates) {
    if (!budgetOk()) {
      deadlineReached = true;
      break;
    }
    const sliceData = sliceCache.get(candidate.file);
    const job = sliceData?.jobs?.[candidate.jobIdx];
    if (!job) continue;
    const sl = job.sourceLang || 'it';
    const sourceTitle = (job.title || '').trim();
    const tbl = job.titleByLocale || {};
    const existing = String(tbl[candidate.locale] || '').trim();
    if (!sourceTitle || !existing) continue;
    const stillBroken = candidate.reason === 'llm-reasoning'
      ? titleContainsLlmReasoning(existing)
      : isTitleSourceCopy(existing, sourceTitle);
    if (!stillBroken) continue;

    const translated = await freeTranslateWithRetry({
      text: sourceTitle,
      sourceLang: sl,
      targetLang: candidate.locale,
      maxRetries: 0,
    });
    if (!DRY_RUN) {
      const prior = attemptState.attempts[candidate.key] || {};
      attemptState.attempts[candidate.key] = {
        attempts: (Number(prior.attempts) || 0) + 1,
        lastAttemptAt: new Date().toISOString(),
      };
      stateChanged = true;
    }

    if (!translated) {
      totalFailed++;
      continue;
    }
    if (isTitleSourceCopy(translated, existing)) {
      totalNoop++;
      continue;
    }
    if (isTitleSourceCopy(translated, sourceTitle) || titleContainsLlmReasoning(translated)) {
      totalFailed++;
      continue;
    }

    if (!DRY_RUN) {
      tbl[candidate.locale] = translated;
      job.titleByLocale = tbl;
      changedFiles.add(candidate.file);
    }
    totalFixed++;
  }

  if (!DRY_RUN) {
    for (const file of changedFiles) {
      writeJson(path.join(BY_CRAWLER_DIR, file), sliceCache.get(file));
      slicesChanged++;
      console.log(`  ✅ ${file.replace('.json', '')}`);
    }
    if (stateChanged) writeJson(TITLE_FIX_STATE_PATH, attemptState);
  }

  if (deadlineReached) {
    const elapsedMin = Math.round((Date.now() - RUN_START_MS) / 60000);
    console.log(`\n⏰ Title-fix deadline reached after ~${elapsedMin}min — completed work was persisted; remaining slices stay queued for the next run.`);
  }

  console.log(`\n📊 Title fix complete: ${totalFixed} translated, ${totalNoop} no-op, ${totalFailed} failed`);
  console.log(`   ${slicesChanged} slices modified`);
  logCascadeSummary();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
