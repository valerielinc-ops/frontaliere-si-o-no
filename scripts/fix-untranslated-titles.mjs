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

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, getCascadeStats, getCodexTierStats as getCodexTierStatsDefault, logCascadeSummary } from './lib/free-translate.mjs';
import { installCodexReserveReport } from './lib/codex-reserve-report.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { isTitleSourceCopy, titleContainsLlmReasoning, titleLooksUntranslated } from './lib/job-locale-utils.mjs';
import { isTitleRepairQueueVerdict, titleRepairQueueLocales, titleRepairSourceTitle } from './lib/untranslated-title-repair.mjs';
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

/**
 * Retry backoff for a title slot the lane already failed on.
 *
 * Every entry of the attempt ledger is a slot that is still queued, i.e. a
 * slot no attempt has fixed: a success removes it from the queue. Before this
 * backoff the lane re-sent the same residue every run. Translate-pending runs
 * 37741838594…38457393561 (2026-10-09…13): the 2a.2 lane spent its whole
 * budget (350 Codex calls) for 0-9 titles fixed per run, mostly echoes of
 * titles already in the target language; the ledger had 967 slots tried 20+
 * times and 4320 retried in the last two days. That spend exhausted the Codex
 * subscription about an hour into each run, and the 2d/2e repair lanes then
 * stopped after three failed calls.
 *
 * A slot tried N >= 2 times waits min(2^(N-1), 30) days before the next try;
 * a changed source title restarts it (the ledger stores a hash of the title it
 * tried). Legacy entries without the hash wait at most 7 days, so a changed
 * title is never parked for long. Never-tried slots are unaffected.
 */
export const TITLE_FIX_BACKOFF_MAX_DAYS = 30;
const TITLE_FIX_LEGACY_BACKOFF_MAX_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function titleFixSourceHash(sourceTitle) {
  return createHash('sha256').update(String(sourceTitle || '').trim()).digest('hex').slice(0, 12);
}

export function isTitleFixBackedOff(entry, sourceTitle, nowMs = Date.now()) {
  const attempts = Number(entry?.attempts) || 0;
  if (attempts < 2) return false;
  if (entry?.source && entry.source !== titleFixSourceHash(sourceTitle)) return false;
  const last = Date.parse(String(entry?.lastAttemptAt || ''));
  if (!Number.isFinite(last)) return false;
  const maxDays = entry?.source ? TITLE_FIX_BACKOFF_MAX_DAYS : TITLE_FIX_LEGACY_BACKOFF_MAX_DAYS;
  const waitDays = Math.min(2 ** (attempts - 1), maxDays);
  return nowMs - last < waitDays * DAY_MS;
}

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
  // Keep this clamp aligned with free-translate's calibration ceiling. The
  // workflow default remains 10 until a real Luna Max run selects a larger
  // production value.
  const batchMaxTexts = boundedEnvInteger('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS', 5, 1, 50);
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
    const sourceTitle = titleRepairSourceTitle(job);
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
      // A changed source title restarts the count: the backoff only applies
      // to repeated failures on the same text.
      const source = titleFixSourceHash(sourceTitle);
      const sameSource = !prior.source || prior.source === source;
      attemptState.attempts[candidate.key] = {
        attempts: (sameSource ? (Number(prior.attempts) || 0) : 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        source,
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
  const discoveryNowMs = Date.now();
  let backedOff = 0;
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
      // Same source-title fallback and admission predicate as the Argos
      // handoff (`shouldQueueArgosSlot`): a slot Argos leaves to this lane must
      // become a candidate here.
      for (const { locale, reason } of titleRepairQueueLocales(job, LOCALES)) {
        const key = titleFixAttemptKey(file, job, jobIdx, locale);
        if (isTitleFixBackedOff(attemptState.attempts[key], titleRepairSourceTitle(job), discoveryNowMs)) {
          backedOff++;
          continue;
        }
        candidates.push({
          file,
          jobIdx,
          locale,
          key,
          reason,
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
  if (backedOff > 0) console.log(`   ⏸️  ${backedOff} slot(s) waiting for their retry backoff (already tried 2+ times on the same source title).`);
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
