#!/usr/bin/env node
/**
 * fix-untranslated-titles.mjs — One-shot batch fix for untranslated title slots.
 *
 * Finds jobs where titleByLocale[locale] is an exact copy or a
 * marker-backed partial copy of the source title and translates them using the
 * free-translate cascade (Codex Luna Max → DeepL → MyMemory → etc).
 *
 * Uses the free cascade. In translate-pending, the workflow supplies the
 * Codex Luna Max broker, which is the first tier of the cascade (owner
 * decision 2026-10-06); without that broker the ordinary free tiers remain
 * the complete cascade.
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
 *   UNTRANSLATED_TITLE_FIX_WINDOW_MS — optional window from this process's
 *     start; the lane stops at min(deadline, elapsed at start + window).
 *   UNTRANSLATED_TITLE_FIX_CONCURRENCY — optional cap for title candidates in
 *     flight; the default follows FREE_TRANSLATE_CODEX_LANES ×
 *     FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS and is clamped to a safe maximum.
 *   UNTRANSLATED_TITLE_FIX_FALLBACK_CONCURRENCY — cap used after Codex is
 *     absent or its per-run budget is spent (default 2).
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, getCascadeStats, getCodexTierStats as getCodexTierStatsDefault, logCascadeSummary } from './lib/free-translate.mjs';
import { installCodexReserveReport } from './lib/codex-reserve-report.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { isTitleSourceCopy, titleContainsLlmReasoning, titleLooksUntranslated } from './lib/job-locale-utils.mjs';
import { isTitleRepairQueueVerdict } from './lib/untranslated-title-repair.mjs';
import { resolveRunStartMs, windowedDeadlineMs } from './lib/translate-run-clock.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const TITLE_FIX_STATE_PATH = path.resolve(__dirname, '..', 'data', 'translation-title-fix-attempts.json');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');
// Run-wide deadline measured from the shared translate-pending start marker.
// Standalone invocations keep a local fallback; the workflow requires the marker.
const RUN_START_MS = resolveRunStartMs();
// UNTRANSLATED_TITLE_FIX_WINDOW_MS gives the lane its own window from this
// process's start, still bounded by the run-wide deadline (windowedDeadlineMs).
const TITLE_FIX_DEADLINE_MS = windowedDeadlineMs({
  deadlineMs: Number(process.env.UNTRANSLATED_TITLE_FIX_DEADLINE_MS) || 300 * 60 * 1000,
  windowMs: Number(process.env.UNTRANSLATED_TITLE_FIX_WINDOW_MS) || 0,
  elapsedAtStartMs: Date.now() - RUN_START_MS,
});

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

const TITLE_FIX_CONCURRENCY_MAX = 30;
const TITLE_FIX_FALLBACK_CONCURRENCY_DEFAULT = 2;
const TITLE_FIX_FALLBACK_CONCURRENCY_MAX = 5;

function boundedEnvInteger(name, fallback, min, max) {
  const raw = String(process.env[name] || '').trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Keep enough title requests in flight for the Codex collection window to
 * feed every configured lane, while retaining an explicit operator cap.
 */
export function resolveTitleFixConcurrency() {
  const lanes = boundedEnvInteger('FREE_TRANSLATE_CODEX_LANES', 2, 1, 3);
  const batchMaxTexts = boundedEnvInteger('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS', 5, 1, 10);
  const derived = Math.min(TITLE_FIX_CONCURRENCY_MAX, lanes * batchMaxTexts);
  return boundedEnvInteger('UNTRANSLATED_TITLE_FIX_CONCURRENCY', derived, 1, TITLE_FIX_CONCURRENCY_MAX);
}

export function resolveTitleFixFallbackConcurrency() {
  return boundedEnvInteger(
    'UNTRANSLATED_TITLE_FIX_FALLBACK_CONCURRENCY',
    TITLE_FIX_FALLBACK_CONCURRENCY_DEFAULT,
    1,
    TITLE_FIX_FALLBACK_CONCURRENCY_MAX,
  );
}

function normalizeConcurrency(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return fallback;
  return Math.min(Math.max(numeric, 1), max);
}

function codexCanAcceptMoreWork(getCodexStats) {
  let stats;
  try {
    stats = getCodexStats();
  } catch {
    return false;
  }
  if (!stats || stats.lanePresent !== true || stats.stopReason) return false;
  const calls = Number(stats.calls);
  const maxCalls = Number(stats.maxCalls);
  if (Number.isFinite(maxCalls) && maxCalls >= 0 && Number.isFinite(calls) && calls >= maxCalls) return false;
  const spentMs = Number(stats.spentMs);
  const maxMs = Number(stats.maxMs);
  if (Number.isFinite(maxMs) && maxMs >= 0 && Number.isFinite(spentMs) && spentMs >= maxMs) return false;
  return true;
}

function titleFixCandidateContext(job, sourceTitle, locale) {
  return {
    sourceTitle,
    sourceLang: job.sourceLang || 'it',
    targetLang: locale,
    targetLocale: locale,
    company: job.company || '',
    location: job.addressLocality || job.location || '',
  };
}

function normalizeTitleMemoPart(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function titleTranslationMemoKey(sourceTitle, sourceLang, targetLang) {
  return JSON.stringify([
    normalizeTitleMemoPart(sourceTitle),
    normalizeTitleMemoPart(sourceLang),
    normalizeTitleMemoPart(targetLang),
  ]);
}

/**
 * Process the discovered queue with a bounded, priority-preserving pool.
 * The callback is called once per candidate; free-translate owns the Codex
 * collection window and batches the requests that overlap here.
 */
export function runTitleFixCandidatePool({
  candidates = [],
  sliceCache,
  attemptState = { version: 1, attempts: {} },
  dryRun = false,
  budgetOk = () => true,
  translate = freeTranslateWithRetry,
  getCodexTierStats = getCodexTierStatsDefault,
  maxConcurrency = resolveTitleFixConcurrency(),
  fallbackConcurrency = resolveTitleFixFallbackConcurrency(),
} = {}) {
  if (!attemptState || typeof attemptState !== 'object') {
    attemptState = { version: 1, attempts: {} };
  }
  if (!attemptState.attempts || typeof attemptState.attempts !== 'object') {
    attemptState.attempts = {};
  }
  const codexConcurrency = normalizeConcurrency(maxConcurrency, resolveTitleFixConcurrency(), TITLE_FIX_CONCURRENCY_MAX);
  const freeProviderConcurrency = normalizeConcurrency(
    fallbackConcurrency,
    resolveTitleFixFallbackConcurrency(),
    TITLE_FIX_FALLBACK_CONCURRENCY_MAX,
  );
  const changedFiles = new Set();
  let nextIndex = 0;
  let active = 0;
  let deadlineReached = false;
  let stateChanged = false;
  let totalFixed = 0;
  let totalNoop = 0;
  let totalFailed = 0;
  const titleTranslationMemo = new Map();

  const memoizedTranslate = (options) => {
    const key = titleTranslationMemoKey(options.text, options.sourceLang, options.targetLang);
    const cached = titleTranslationMemo.get(key);
    if (cached) return cached;
    // Store the promise before awaiting it so candidates launched in the same
    // pool turn share both an in-flight request and its empty result.
    const pending = Promise.resolve()
      .then(() => translate(options))
      .catch(() => '');
    titleTranslationMemo.set(key, pending);
    return pending;
  };

  const processCandidate = async (candidate) => {
    const sliceData = sliceCache?.get(candidate.file);
    const job = sliceData?.jobs?.[candidate.jobIdx];
    if (!job) return;
    const sourceLang = job.sourceLang || 'it';
    const sourceTitle = (job.title || '').trim();
    const table = job.titleByLocale || {};
    const existing = String(table[candidate.locale] || '').trim();
    if (!sourceTitle || !existing) return;

    const currentVerdict = titleLooksUntranslated({
      ...titleFixCandidateContext(job, sourceTitle, candidate.locale),
      title: existing,
    });
    if (!isTitleRepairQueueVerdict(currentVerdict)) return;

    let translated = '';
    try {
      translated = await memoizedTranslate({
        text: sourceTitle,
        sourceLang,
        targetLang: candidate.locale,
        maxRetries: 0,
      });
    } catch {
      translated = '';
    }

    if (!dryRun) {
      const prior = attemptState.attempts[candidate.key] || {};
      attemptState.attempts[candidate.key] = {
        attempts: (Number(prior.attempts) || 0) + 1,
        lastAttemptAt: new Date().toISOString(),
      };
      stateChanged = true;
    }

    if (!translated) {
      totalFailed++;
      return;
    }
    if (isTitleSourceCopy(translated, existing)) {
      totalNoop++;
      return;
    }
    if (isTitleSourceCopy(translated, sourceTitle) || titleContainsLlmReasoning(translated)) {
      totalFailed++;
      return;
    }
    const translatedVerdict = titleLooksUntranslated({
      ...titleFixCandidateContext(job, sourceTitle, candidate.locale),
      title: translated,
    });
    if (translatedVerdict.untranslated) {
      totalFailed++;
      return;
    }

    if (!dryRun) {
      // Re-read the table after the await. JavaScript resumes each candidate
      // synchronously here, so two locales of one job retain each other's
      // completed write instead of assigning a stale snapshot.
      const latestTable = job.titleByLocale || {};
      latestTable[candidate.locale] = translated;
      job.titleByLocale = latestTable;
      changedFiles.add(candidate.file);
    }
    totalFixed++;
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({
        totalFixed,
        totalNoop,
        totalFailed,
        deadlineReached,
        changedFiles,
        stateChanged,
        attemptState,
      });
    };

    const schedule = () => {
      if (settled) return;
      const targetConcurrency = codexCanAcceptMoreWork(getCodexTierStats)
        ? codexConcurrency
        : freeProviderConcurrency;

      while (!deadlineReached && active < targetConcurrency && nextIndex < candidates.length) {
        // This check is deliberately inside the single-candidate claim, not
        // once per batch: every new candidate must pass the shared deadline.
        if (!budgetOk()) {
          deadlineReached = true;
          break;
        }
        const candidate = candidates[nextIndex++];
        active++;
        Promise.resolve()
          .then(() => processCandidate(candidate))
          .catch((error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          })
          .finally(() => {
            active--;
            schedule();
          });
      }

      if (active === 0 && (deadlineReached || nextIndex >= candidates.length)) finish();
    };

    schedule();
  });
}

export function persistTitleFixWork({
  changedFiles,
  sliceCache,
  attemptState,
  stateChanged,
  byCrawlerDir = BY_CRAWLER_DIR,
  statePath = TITLE_FIX_STATE_PATH,
}) {
  let slicesChanged = 0;
  for (const file of changedFiles || []) {
    writeJson(path.join(byCrawlerDir, file), sliceCache.get(file));
    slicesChanged++;
    console.log(`  ✅ ${file.replace('.json', '')}`);
  }
  if (stateChanged) writeJson(statePath, attemptState);
  return slicesChanged;
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
        if (!isTitleRepairQueueVerdict(verdict)) continue;
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

  const budgetOk = () => (Date.now() - RUN_START_MS) < TITLE_FIX_DEADLINE_MS;

  console.log(`🔧 Fixing title repair candidates across ${files.length} slices (${candidates.length} slots)...`);
  if (DRY_RUN) console.log('   (DRY RUN — no files will be modified)\n');

  const result = await runTitleFixCandidatePool({
    candidates,
    sliceCache,
    attemptState,
    dryRun: DRY_RUN,
    budgetOk,
  });
  const slicesChanged = DRY_RUN ? 0 : persistTitleFixWork({
    changedFiles: result.changedFiles,
    sliceCache,
    attemptState: result.attemptState,
    stateChanged: result.stateChanged,
  });

  if (result.deadlineReached) {
    const elapsedMin = Math.round((Date.now() - RUN_START_MS) / 60000);
    console.log(`\n⏰ Title-fix deadline reached after ~${elapsedMin}min — completed work was persisted; remaining slices stay queued for the next run.`);
  }

  console.log(`\n📊 Title fix complete: ${result.totalFixed} translated, ${result.totalNoop} no-op, ${result.totalFailed} failed`);
  console.log(`   ${slicesChanged} slices modified`);
  logCascadeSummary();
}

const IS_MAIN = isInvokedDirectly(import.meta.url);
if (IS_MAIN) {
  installCodexReserveReport('2d-titles', () => ({ codex: getCodexTierStatsDefault(), cascade: getCascadeStats() }));
  main().catch(err => { console.error('❌', err.message); process.exit(1); });
}
