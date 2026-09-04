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
 *   - RELOCALIZE_MAX_JOBS — max jobs to re-localize (default: RELOCALIZE_DEFAULT_MAX_JOBS)
 *   - RELOCALIZE_DRY_RUN — set to '1' to only report, not run (default: '0')
 *   - RELOCALIZE_ALLOW_NO_TRAFFIC — '1' to run without traffic priority on purpose
 *
 * Priority (issue #5650): the queue (10.192 jobs on 2026-08-14) is two orders of
 * magnitude larger than any per-run cap, so the ordering IS the decision. See
 * scripts/lib/job-traffic-priority.mjs for the traffic source, the measured
 * ×17,5 gain over the previous ordering, and the oldest-first reserve.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
import { detectJobTitleLocaleDetails, titleLooksUntranslated } from './lib/job-locale-utils.mjs';
import {
  addPreviousSlugForLocale,
  captureLostSlugs,
  DEFAULT_PREV_SLUG_CAP,
  normalizeForLengthComparison,
} from './lib/dedicated-crawler-common.mjs';
import { collectMissingAssembledBridges } from './scatter-jobs-to-slices.mjs';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import {
  assertTrafficPriorityUsable,
  buildTrafficPriority,
  formatPriorityReport,
  TRAFFIC_SOURCE_PATH,
} from './lib/job-traffic-priority.mjs';
import { logCascadeSummary } from './lib/free-translate.mjs';
import { markRunStart, readRunStartMs } from './lib/translate-run-clock.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { runTranslationShadowPreflightV2 } from './lib/translation-shadow-preflight-v2.mjs';
import {
  applyThinkingArm,
  assignThinkingArm,
  isThinkingAbEnabled,
  runSalt,
  summarizeThinkingAb,
} from './lib/thinking-ab.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const JOB_POPULARITY_PATH = path.join(ROOT, TRAFFIC_SOURCE_PATH);
// Deliberate run without traffic priority (e.g. a local dry run with no data/).
// Anything else that finds the traffic source empty must FAIL, not degrade —
// see assertTrafficPriorityUsable() for why silence is the defect here.
const ALLOW_NO_TRAFFIC = String(process.env.RELOCALIZE_ALLOW_NO_TRAFFIC || '0') === '1';
const TRANSLATION_CACHE_DIR = path.join(ROOT, 'data', 'translation-cache');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;
const DRY_RUN = String(process.env.RELOCALIZE_DRY_RUN || '0') === '1';
// After this many runs where a flagged job still fails isIncomplete(), give up:
// LibreTranslate cannot satisfy the locale detectors (proper-noun-heavy text,
// structural fragments, mixed-language source). Suppress it via
// `localeMismatchSuppressed` so the flaggers stop re-queuing it every run and
// it stops starving genuinely-pending jobs. Auto-resets when the source changes
// (re-crawl) — see needsTranslation() and the direct-scan in run().
const MAX_RETRANSLATION_ATTEMPTS = 3;

// How many companies in a row can fail before the whole run aborts. A single
// company's error (transient network blip, malformed source data) used to
// `break` the entire per-company loop, leaving every company later in
// `companyKeys` order untouched for that run — and since that order is
// traffic-weighted (job-traffic-priority.mjs), low-traffic companies always
// sort last and could go untouched run after run (issue #5976: 408 jobs 30d+
// stuck, 93% never attempted even once). Only a run of consecutive failures —
// a real signal of a systemic outage (e.g. AI quota exhausted on every tier)
// — should still abort early to avoid burning quota on companies destined to
// fail too.
const MAX_CONSECUTIVE_COMPANY_FAILURES = 3;

/**
 * Default cascade cap when neither --max-jobs nor RELOCALIZE_MAX_JOBS is given.
 *
 * Was 100. Raised to 900 for issue #5650, and the number is a MEASUREMENT, not
 * a preference: on run 31766645401 (2026-08-14) Phase 2b translated its full
 * 100-job cap in 9,0 minutes — 11,1 jobs/min — against a 90-minute cascade
 * window (JOBS_CASCADE_DEADLINE_MS in translate-pending.yml). 90 × 11,1 ≈ 999,
 * so at the observed best throughput the cap, not the clock, was what stopped
 * the drain, and it stopped it at ~10% of the window.
 *
 * The constraint that stops it now is the 90-minute cascade deadline itself,
 * which is measured from RUN_START and therefore already self-throttling: on
 * the slow runs (31690534255: 87,3 min for the same 100 jobs, 1,15 jobs/min,
 * every free model exhausted) the clock binds long before 900 and the run stops
 * exactly where it stopped before. So this raise can only ever ADD drained
 * jobs; it cannot lengthen a run. Raising the deadline instead would take the
 * time from the Phase 2c Argos mop-up, which is the free unlimited pass — a
 * strictly worse trade.
 *
 * Not a budget knob: the cascade's cost is wall-clock, and both tiers it
 * reaches (free HTTP cascade, Claude CLI Haiku on the existing Max
 * subscription) are already paid for.
 */
export const RELOCALIZE_DEFAULT_MAX_JOBS = 900;

// Parse --max-jobs from CLI args (takes precedence over env var)
function parseMaxJobs() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--max-jobs');
  if (idx !== -1 && args[idx + 1]) {
    const val = Number(args[idx + 1]);
    if (!isNaN(val) && val > 0) return val;
  }
  return Number(process.env.RELOCALIZE_MAX_JOBS) || RELOCALIZE_DEFAULT_MAX_JOBS;
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

function parseShadowPreflightV2Options() {
  const args = process.argv.slice(2);
  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : '';
  };
  return Object.freeze({
    outputPath: valueFor('--shadow-preflight-v2-output'),
    baselineMainSha: valueFor('--shadow-preflight-v2-baseline-main-sha'),
    runnerTemp: valueFor('--shadow-preflight-v2-runner-temp'),
    repository: valueFor('--shadow-preflight-v2-repository'),
    workflow: valueFor('--shadow-preflight-v2-workflow'),
    runId: valueFor('--shadow-preflight-v2-run-id'),
    runAttempt: valueFor('--shadow-preflight-v2-run-attempt'),
    workflowBlobSha: valueFor('--shadow-preflight-v2-workflow-blob-sha'),
  });
}

const SHADOW_PREFLIGHT_V2 = parseShadowPreflightV2Options();

export function createObserverCompensatedClock(now = Date.now) {
  let observerElapsedMs = 0;
  return Object.freeze({
    now: () => now() - observerElapsedMs,
    measureObserver: (operation) => {
      const startedMs = now();
      try {
        return operation();
      } finally {
        const finishedMs = now();
        if (Number.isFinite(startedMs) && Number.isFinite(finishedMs)) {
          observerElapsedMs += Math.max(0, finishedMs - startedMs);
        }
      }
    },
  });
}

const LEGACY_CLOCK = createObserverCompensatedClock();

function emitTranslationShadowPreflightV2(inputFactory) {
  if (!SHADOW_PREFLIGHT_V2.outputPath) return null;
  return LEGACY_CLOCK.measureObserver(() => {
    try {
      const runBinding = {
        repository: SHADOW_PREFLIGHT_V2.repository,
        workflow: SHADOW_PREFLIGHT_V2.workflow,
        runId: SHADOW_PREFLIGHT_V2.runId,
        runAttempt: SHADOW_PREFLIGHT_V2.runAttempt,
        sourceCommit: SHADOW_PREFLIGHT_V2.baselineMainSha,
        workflowBlobSha: SHADOW_PREFLIGHT_V2.workflowBlobSha || null,
      };
      const input = inputFactory();
      return runTranslationShadowPreflightV2({
        ...input,
        baselineMainSha: SHADOW_PREFLIGHT_V2.baselineMainSha,
        runBinding,
      }, {
        outputPath: SHADOW_PREFLIGHT_V2.outputPath,
        runnerTemp: SHADOW_PREFLIGHT_V2.runnerTemp,
      });
    } catch (error) {
      // Shadow mode is observational. A bad path, timeout, or observer defect may
      // not change the legacy translation outcome or its production writes.
      console.warn(`⚠️  Translation shadow preflight v2 unavailable: ${error?.message || error}`);
      return null;
    }
  });
}

// Time budget: stop starting new companies when this many ms have elapsed.
// The workflow job has timeout-minutes:350; we stop at 320min to leave a
// comfortable margin for the commit/deploy steps to run.
const TIME_BUDGET_MS = 320 * 60 * 1000;

// SHARED run start (ms). Used to make the shared crawler's per-company
// localization budget ELAPSED-AWARE: each runSharedCrawler() call gets
// `CASCADE_LOCALIZATION_DEADLINE_MS − elapsed`, not a fresh full budget. Without
// this, a heavy company starting late would get a brand-new budget and could run
// past the 350min job timeout (review #2205 🔴), losing ALL uncommitted writes.
// Prefer the run-clock marker (written write-once by the FIRST translation step):
// under the Argos-first ordering the local-MT BULK pass (Phase 2a) runs before
// this cascade and seeds the marker, so the cascade's 250min deadline correctly
// counts the time Phase 2a already spent — keeping Phase 2a + cascade + mop-up
// inside the 350min timeout. Falls back to now() when no marker exists
// (cascade-first / standalone), identical to the prior behaviour.
const RUN_START_MS = readRunStartMs() ?? Date.now();
// Run-wide deadline for the slow HTTP/ONNX cascade. Default 250min (cascade-first
// era: the cascade IS the primary translator). Under Argos-first the fast
// CTranslate2 bulk (Phase 2a) + the Argos mop-up (Phase 2c) already cover the
// backlog, so the cascade only needs a SHORT premium-upgrade / contamination-fix
// pass — translate-pending.yml caps it via JOBS_CASCADE_DEADLINE_MS so the cascade
// stops expanding to fill 250min and the whole job's wall-clock drops. Measured
// from RUN_START_MS, so a long Phase 2a self-throttles the cascade (it steps aside
// when the bulk pass ran long, takes its window when the bulk was quick).
const CASCADE_LOCALIZATION_DEADLINE_MS =
  Number(process.env.JOBS_CASCADE_DEADLINE_MS) || 250 * 60 * 1000;

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
export function needsTranslation(job) {
  // Explicit flag set by either a crawler or the assembler's locale-completeness
  // guard (assemble-jobs-dataset.mjs flags suppressed jobs whose locale slots are
  // still empty). Takes priority over the suppression check so that assembler-
  // re-flagged jobs get retried: per-crawler files have no needsRetranslation
  // (cleared by the 'gaveup' path), so reconcileRetranslationState returns 'noop'
  // in the per-crawler context — the give-up counter is NOT advanced and the job
  // is not immediately re-suppressed.
  if (job.needsRetranslation) return true;
  // Gave up on this job after MAX_RETRANSLATION_ATTEMPTS failed runs. Stay out of
  // the work pool unless the source content changed since we suppressed it
  // (re-crawl brings fresh text worth a new attempt).
  if (job.localeMismatchSuppressed && !sourceChangedSinceSuppression(job)) return false;
  return isIncomplete(job);
}

/**
 * True if the job's source description length drifted >15% from the snapshot
 * taken when it was suppressed — i.e. a re-crawl rewrote the content, so the
 * give-up no longer applies and we should retry.
 */
function sourceChangedSinceSuppression(job) {
  const snap = job.localeMismatchSuppressedLen;
  if (typeof snap !== 'number') return true; // no snapshot → treat as changed (retry)
  const now = (job.description || '').trim().length;
  return Math.abs(now - snap) > snap * 0.15;
}

/**
 * State machine for the needsRetranslation give-up cycle. Mutates `job` in place
 * and returns the outcome.
 *
 * CRITICAL: the give-up counter must only advance when a translation was actually
 * ATTEMPTED on this job and still failed — NOT merely because the job sat in the
 * queue. relocalize runs with `--max-jobs 100` against thousands of flagged jobs,
 * so most are never reached by the throughput budget on a given run. Counting an
 * attempt per-run (per queue presence) would suppress the entire un-reached
 * backlog after a few runs, permanently pulling translatable jobs out of the pool
 * (source-language text frozen on IT/EN/FR pages — a duplicate-content / indexing
 * regression). Hence `attempted`:
 *   - direct-scan over all slices → attempted=false (reset + clear only)
 *   - per-company sync of jobs actually translated this run → attempted=true
 *
 *   'reset'   — a re-crawl rewrote a suppressed job → give-up lifted, retry
 *   'cleared' — flagged job now passes isIncomplete() → flag + bookkeeping cleared
 *   'gaveup'  — attempted, still incomplete after MAX_RETRANSLATION_ATTEMPTS → suppressed
 *   'counted' — attempted, still incomplete → attempt counter bumped
 *   'waiting' — still incomplete but NOT attempted this run → left flagged, no count
 *   'noop'    — nothing to do
 *
 * @param {object} job
 * @param {{ attempted?: boolean }} [opts]
 * @returns {'reset'|'cleared'|'gaveup'|'counted'|'waiting'|'noop'}
 */
export function reconcileRetranslationState(job, { attempted = false } = {}) {
  let outcome = 'noop';
  // A re-crawl rewrote a previously-suppressed job → drop the give-up so the
  // fresh content gets a new translation attempt.
  if (job.localeMismatchSuppressed && sourceChangedSinceSuppression(job)) {
    delete job.localeMismatchSuppressed;
    delete job.localeMismatchSuppressedLen;
    delete job.retranslationAttempts;
    outcome = 'reset';
  }
  if (!job.needsRetranslation) return outcome;
  if (!isIncomplete(job)) {
    // Now complete + consistent: clear flag and all give-up bookkeeping.
    delete job.needsRetranslation;
    delete job.retranslationAttempts;
    delete job.localeMismatchSuppressed;
    delete job.localeMismatchSuppressedLen;
    return 'cleared';
  }
  // Still incomplete. Only advance the give-up counter if a translation was
  // actually attempted on this job this run — otherwise leave it queued.
  if (!attempted) return 'waiting';
  const attempts = (job.retranslationAttempts || 0) + 1;
  job.retranslationAttempts = attempts;
  if (attempts >= MAX_RETRANSLATION_ATTEMPTS) {
    delete job.needsRetranslation;
    job.localeMismatchSuppressed = true;
    job.localeMismatchSuppressedLen = (job.description || '').trim().length;
    return 'gaveup';
  }
  return 'counted';
}

/**
 * Locale-content signature of a job (titles + descriptions across locales).
 * Used to detect whether the shared crawler ACTUALLY touched a job in a run:
 * the crawler stops at its per-run budget and on quota, so a company slice can
 * hold far more flagged jobs than were translated. A give-up attempt must only
 * be counted for jobs whose content actually changed — never for the un-reached
 * tail (counting those would suppress translatable backlog; see
 * reconcileRetranslationState). Erring toward "unchanged ⇒ not attempted" is the
 * safe side: it can only delay a give-up, never cause a false suppression.
 */
export function jobLocaleSignature(job) {
  return `${JSON.stringify(job.titleByLocale || {})}\u0000${JSON.stringify(job.descriptionByLocale || {})}`;
}

/** Snapshot { slug → signature } for one company's jobs (call before the crawler runs). */
export function snapshotCompanySignatures(jobs, companyKey) {
  const m = new Map();
  for (const j of jobs) {
    if (normalizeCompanyKey(j.companyKey || j.company || '') !== companyKey) continue;
    if (j.slug) m.set(j.slug, jobLocaleSignature(j));
  }
  return m;
}

/** Slugs whose locale content changed vs the pre-crawler snapshot (= actually attempted). */
export function changedSlugsSince(snapshot, jobs, companyKey) {
  const changed = new Set();
  for (const j of jobs) {
    if (normalizeCompanyKey(j.companyKey || j.company || '') !== companyKey) continue;
    if (!j.slug) continue;
    const before = snapshot.get(j.slug);
    if (before === undefined || before !== jobLocaleSignature(j)) changed.add(j.slug);
  }
  return changed;
}

/**
 * Decide whether the per-company cascade loop should abort after a company
 * failed, given how many companies failed in a row so far (including this
 * one). A single/isolated failure returns false (continue to the next
 * company); MAX_CONSECUTIVE_COMPANY_FAILURES in a row is treated as a
 * systemic signal (e.g. AI quota exhausted on every tier) and returns true.
 */
export function shouldStopAfterConsecutiveFailures(
  consecutiveFailures,
  max = MAX_CONSECUTIVE_COMPANY_FAILURES,
) {
  return consecutiveFailures >= max;
}

/**
 * Return why a cascade pass must stop, with the run-wide cascade deadline
 * taking precedence over the general workflow time-budget guard.
 */
export function cascadeStopReason({
  nowMs,
  runStartMs,
  cascadeDeadlineMs,
  passStartMs,
  timeBudgetMs,
  timeBudgetFraction,
}) {
  if (nowMs >= runStartMs + cascadeDeadlineMs) return 'cascade deadline';
  if (nowMs - passStartMs >= timeBudgetMs * timeBudgetFraction) return 'time budget';
  return null;
}

/**
 * Check if a job has incomplete locale coverage.
 * Returns true if any locale is missing an adequate title or description.
 */
export function isIncomplete(job) {
  const dbl = job.descriptionByLocale || {};
  const tbl = job.titleByLocale || {};
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

    // Title still in a language that is not `locale`.
    //
    // S3 (2026-08-10) — what was here and why it is gone. Two separate title
    // checks, each wrapped in the same cross-locale escape hatch: "if at least
    // one OTHER non-source locale has a title differing from the source, the job
    // has been translated, so skip this locale". That rule is the written-down
    // form of the reported bug: a DE-source job whose EN and FR slots translated
    // and whose IT slot stayed German had the IT check suppressed BY EN and FR.
    // The second occurrence also gated the only dataset-level title-language
    // check in this file, so that check ran on almost nothing.
    //
    // The verdict is now per slot and needs no corroboration from the other
    // slots by construction: whether THIS title reads as `locale` is a property
    // of this title. It also replaces the local hint-detector + stop-word
    // regexes that followed — `detectJobTitleLocaleDetails(title, locale) >= 0.65`
    // was measured (300 live titles, 2026-08-10) at a 32.7% false-alarm rate on
    // correct Italian and a 55.0% miss rate on broken titles, and passing
    // `locale` as its fallback is what it returns when uncertain, i.e. it hid
    // the bug. One implementation, in job-locale-utils.mjs, for every caller.
    //
    // Volume: this function SELECTS work, it does not flag it. `main()` sorts
    // and slices to `effectiveMax = min(MAX_JOBS, pending.length)` (default 100)
    // before any write, and the only place it turns into a stored
    // `needsRetranslation` is the per-company re-flag loop, which iterates
    // `cappedPending`. So a wider predicate changes WHICH ~100 jobs a run picks,
    // never how many. Genuinely-international titles that no translator can
    // improve are absorbed by the existing give-up valve
    // (MAX_RETRANSLATION_ATTEMPTS → `localeMismatchSuppressed`).
    if (locale !== (job.sourceLang || 'it') && title) {
      const verdict = titleLooksUntranslated({
        title,
        sourceTitle: (tbl[job.sourceLang || 'it'] || job.title || '').trim(),
        sourceLang: job.sourceLang || 'it',
        targetLocale: locale,
        company: job.company || '',
        location: job.addressLocality || job.location || '',
      });
      if (verdict.untranslated) return true;
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

    // (The second title check — "cross-locale contamination", same escape hatch,
    // three hand-rolled stop-word regexes and the unreliable hint detector — was
    // folded into the single per-slot verdict above. See the S3 note there.)
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
 * Order the pending queue by served traffic, with an oldest-first reserve.
 *
 * The I/O half of scripts/lib/job-traffic-priority.mjs (which is pure so the
 * observer can import it from a sparse worktree). Reads the daily Firestore
 * `job_views` export, orders, prints the queue-age block, and REFUSES to
 * continue on an unusable traffic source.
 *
 * @param {object[]} pending
 * @returns {object[]} the same jobs, reordered
 */
export function orderPendingByTraffic(pending, { capture } = {}) {
  let popularity = readJson(JOB_POPULARITY_PATH);
  if (!popularity || typeof popularity !== 'object' || Array.isArray(popularity)) {
    if (!ALLOW_NO_TRAFFIC) {
      throw new Error(
        `traffic priority unusable: ${TRAFFIC_SOURCE_PATH} is missing or not an object. ` +
        'It is committed daily by refresh-job-popularity.yml; a run without it would ' +
        'order the queue by nothing while still reporting progress. Set ' +
        'RELOCALIZE_ALLOW_NO_TRAFFIC=1 to run without traffic priority on purpose.',
      );
    }
    console.warn(`⚠️  ${TRAFFIC_SOURCE_PATH} unreadable — running WITHOUT traffic priority (RELOCALIZE_ALLOW_NO_TRAFFIC=1).`);
    popularity = {};
  }

  const { order, stats } = buildTrafficPriority(pending, popularity);
  for (const line of formatPriorityReport(stats)) console.log(line);
  assertTrafficPriorityUsable(stats, { allowEmpty: ALLOW_NO_TRAFFIC });
  if (capture && typeof capture === 'object') {
    capture.popularity = popularity;
    capture.stats = stats;
  }
  return order;
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
    // Translation throughput knob. Set to 2 to match the 2-core GitHub runner:
    // self-hosted LibreTranslate (Argos Translate, CPU-bound) degrades under
    // concurrency > 2 on a 2-core box — each overloaded request pays the full
    // LIBRETRANSLATE_TIMEOUT_MS before falling through to the next tier. At
    // concurrency=2 the runner's cores are fully utilised without thrashing.
    // Higher concurrency values measured flat or negative throughput on 2-core
    // hardware (#2018 → #2044 revert). Env-overridable for local/stronger runners.
    // REVERT-TRIGGER: this combined state (concurrency 2 + warmup-aware LT timeout
    // in free-translate.mjs + max-jobs default 100) is NOT measured pre-merge — the
    // instrumented run (wall-clock, needsRetranslation/complete Δ) is deferred to the
    // next live translate-pending.yml. If that scheduled run shows wall-clock ≥ the
    // prior baseline OR fewer jobs completed/run, revert this knob (and the warmup
    // timeout) to their prior values (#2076).
    JOBS_AI_LOCALIZATION_CONCURRENCY: process.env.JOBS_AI_LOCALIZATION_CONCURRENCY || '2',
    // ELAPSED-AWARE localization budget (review #2205 🔴): remaining time until
    // the run-wide cascade deadline, recomputed per call. A company starting near
    // the deadline gets a small budget and defers its tail to the next run,
    // instead of a fresh 250min that could blow past the 350min job timeout. The
    // shared crawler reads this and stops queuing new jobs once exceeded; jobs
    // already localized are written incrementally per-company, so nothing is lost.
    // max(1, …) NOT max(0, …): the shared crawler treats 0 as "no budget =
    // unlimited" (raw > 0 ? raw : 0), so collapsing to 0 past the deadline would
    // make a late company run UNLIMITED into the 350min job timeout (review #2205
    // 🔴 round 2). Flooring at 1ms means "already exceeded → defer every job",
    // i.e. a company that starts past the deadline does nothing and leaves its
    // jobs for the next run, never an unbounded run.
    JOBS_AI_LOCALIZATION_TIME_BUDGET_MS: String(
      Math.max(1, CASCADE_LOCALIZATION_DEADLINE_MS - (LEGACY_CLOCK.now() - RUN_START_MS)),
    ),
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
      delete job.retranslationAttempts;
      delete job.localeMismatchSuppressed;
      delete job.localeMismatchSuppressedLen;
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
 * @param {Set<string>} [attemptedSlugs] - Slugs the crawler actually translated
 *   this run (locale content changed). Only these advance the give-up counter;
 *   omitting the set means "nothing attempted" — the safe default.
 * @returns {number} Number of jobs updated in the per-crawler file
 */
/**
 * Build the crawler-job → assembled-job lookup used by
 * syncTranslationsToCrawlerFile. Exported for tests.
 *
 * previousSlugs writer regression (#3785/#3794/#3844/#3852/#3874, same class
 * as #3734 already fixed in scatter-jobs-to-slices): the old single-pass
 * first-wins index let one job's `previousSlugs` (or a stale locale slug)
 * CLAIM another job's ACTIVE slug key before the true owner was even seen —
 * common in same-title families (e.g. KSA "Dipl. Pflegefachfrau" ×10,
 * "Berufswahlpraktikum Dentalassistent" ×8) whose histories get unioned by
 * duplicate-merging. syncTranslationsToCrawlerFile then matched a slice job
 * to its SIBLING and copied the sibling's titleByLocale/slugByLocale into it,
 * reverting real translations; cleanPreviousSlugsPerLocale subsequently
 * dropped the history entries that now matched the (wrong) active slugs —
 * a silent previousSlugs loss with no journal capture.
 *
 * Fix: tiered index — URL identity keys first (never shadowed), then active
 * slugs, then previousSlugs as weakest fallback.
 */
export function buildAssembledJobIndex(assembledJobs, companyKey) {
  const assembledByKey = new Map();
  const _addKey = (key, job) => {
    const k = String(key || '').trim();
    if (k && !assembledByKey.has(k)) assembledByKey.set(k, job);
  };
  const inScope = [];
  for (const job of assembledJobs) {
    const jobKey = normalizeCompanyKey(job.companyKey || job.company || '');
    if (jobKey !== companyKey) continue;
    inScope.push(job);
  }
  // Tier 1: URL (most stable identifier — never changes). Indexed for ALL
  // in-scope jobs before any slug key so a slug/previousSlug of one job can
  // never shadow another job's URL identity.
  for (const job of inScope) {
    if (job.url) _addKey(String(job.url).trim().toLowerCase(), job);
  }
  // Tier 2: ACTIVE slugs (master + per-locale) for all jobs.
  for (const job of inScope) {
    _addKey(job.slug, job);
    if (job.slugByLocale && typeof job.slugByLocale === 'object') {
      for (const localeSlug of Object.values(job.slugByLocale)) _addKey(localeSlug, job);
    }
  }
  // Tier 3 (weakest): previousSlugs — the assembled job may have renamed its
  // main slug and the crawler file still references the old one. Added LAST so
  // a job's history can never claim a key that is another job's active slug.
  for (const job of inScope) {
    if (Array.isArray(job.previousSlugs)) {
      for (const s of job.previousSlugs) _addKey(s, job);
    }
  }
  return assembledByKey;
}

/**
 * Resolve the assembled counterpart of a crawler slice job. Exported for tests.
 *
 * URL match is tried FIRST (stable identity); the slug key is only a fallback.
 * Identity guard: a slug-keyed match is REJECTED when both sides carry a URL
 * and the URLs disagree — matching by slug across two different postings is
 * exactly the cross-job contamination this regression class is about. Skipping
 * the sync for that job is always safer than syncing the wrong job's locales.
 */
export function matchAssembledJob(crawlerJob, assembledByKey) {
  const crawlerUrl = String(crawlerJob.url || '').trim().toLowerCase();
  if (crawlerUrl) {
    const byUrl = assembledByKey.get(crawlerUrl);
    if (byUrl) return byUrl;
  }
  const bySlug = assembledByKey.get(String(crawlerJob.slug || '').trim()) || null;
  if (!bySlug) return null;
  const assembledUrl = String(bySlug.url || '').trim().toLowerCase();
  if (crawlerUrl && assembledUrl && crawlerUrl !== assembledUrl) {
    console.log(`     🛑 sync identity guard: slice job ${crawlerJob.id || crawlerJob.slug} matched a DIFFERENT posting by slug (${bySlug.id || bySlug.slug}) — skipping to avoid cross-job locale corruption`);
    return null;
  }
  return bySlug;
}

/**
 * Carry forward SEO bridge slugs the assembled dataset already knows about
 * (e.g. captured by assemble-jobs-dataset's trackSlugHistoryDrift) but this
 * per-crawler file (the committed source of
 * truth the build plugin reads to emit redirect/bridge pages) is still
 * missing. Mutates `crawlerJob` in place; returns whether anything was added.
 *
 * Previously syncTranslationsToCrawlerFile only unioned the flat legacy
 * `previousSlugs` array here, NEVER `previousSlugsByLocale` — so a bridge the
 * collision guard captured per-locale on the assembled side (e.g. when many
 * KSA/Coop postings sharing an identical title+company+location independently
 * derive the same locale slug and applyPerLocaleSlugCollisionGuard demotes all
 * but the rightful owner) was silently dropped the moment this function wrote
 * the job back to the committed slice. Same class as the previousSlugs writer
 * regression #4165/#4161/#4134/#4112/#4102/#4088/#4076/#3885/#3734/#4208 —
 * scatter-jobs-to-slices.mjs already fixed its OWN instance of this gap (see
 * collectMissingAssembledBridges there); this sync path was the sibling that
 * still had it. Reuses that shared, cap-headroom-aware helper instead of a
 * second hand-rolled flat-only implementation, so the two writers can never
 * drift apart again.
 *
 * Must be called AFTER any per-locale rename/capture on `crawlerJob` this run
 * (not on a pre-merge snapshot) — mirrors scatter-jobs-to-slices.mjs's own
 * #4208 fix: computing headroom before a same-run rename lands under-reports
 * how many flat-cap slots are already spent.
 *
 * @param {object} crawlerJob the per-crawler slice job (mutated in place)
 * @param {object} assembled  the matching assembled data/jobs.json entry
 * @returns {boolean} true if any bridge was added
 */
export function carryForwardMissingSlugBridges(crawlerJob, assembled) {
  const missingBridges = collectMissingAssembledBridges(crawlerJob, assembled);
  for (const { locale, slug } of missingBridges) {
    addPreviousSlugForLocale(
      crawlerJob,
      locale,
      slug,
      DEFAULT_PREV_SLUG_CAP,
      `relocalize-pending-jobs/carry-forward-${locale === 'it' ? 'flat' : 'locale'}`,
    );
  }
  return missingBridges.length > 0;
}

function syncTranslationsToCrawlerFile(companyKey, assembledJobs, attemptedSlugs) {
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

  // Build a multi-key lookup for assembled jobs (URL identity first — see
  // buildAssembledJobIndex for the cross-job contamination this prevents).
  const assembledByKey = buildAssembledJobIndex(assembledJobs, companyKey);

  let updated = 0;
  const handledSlugs = new Set();
  for (const crawlerJob of crawlerData.jobs) {
    const assembled = matchAssembledJob(crawlerJob, assembledByKey);
    if (!assembled) continue;

    // Track that this job was matched — used to avoid double retry-counting
    if (crawlerJob.slug) handledSlugs.add(crawlerJob.slug);

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
        // GUARD (previousSlugs writer regression #3785/#3794/#3844/#3852/#3874):
        // never overwrite a TRANSLATED locale slug with a source-copy from the
        // assembled data. Mirrors the title guard above — slugByLocale had no
        // equivalent, so a needsRetranslation job whose assembled twin still
        // carried untranslated (source-copy) slugs had its real translated
        // slugs reverted to the raw source slug; the old translated slug was
        // then the only bridge left and cleanPreviousSlugsPerLocale dropped
        // the raw history entries that now matched the active slugs.
        if (field === 'slugByLocale' && trimmedExisting && trimmedValue && locale !== sourceLang) {
          const srcSlugAssembled = String(assembled.slugByLocale?.[sourceLang] || '').trim();
          const srcSlugCrawler = String(crawlerJob.slugByLocale?.[sourceLang] || '').trim();
          const assembledIsCopy = (srcSlugAssembled && trimmedValue === srcSlugAssembled)
            || (srcSlugCrawler && trimmedValue === srcSlugCrawler);
          const existingIsCopy = (srcSlugAssembled && trimmedExisting === srcSlugAssembled)
            || (srcSlugCrawler && trimmedExisting === srcSlugCrawler);
          if (assembledIsCopy && !existingIsCopy) {
            // Assembled is WORSE (source-copy slug), existing is a real translation — skip
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

    if (carryForwardMissingSlugBridges(crawlerJob, assembled)) {
      changed = true;
    }

    // Advance the give-up counter only if the crawler actually translated THIS job
    // this run (its locale content changed). Jobs that merely sat in the processed
    // company's slice but were never reached by the per-run budget must NOT count —
    // otherwise the un-reached tail gets mass-suppressed (frozen source-copy locales).
    const attempted = !!(attemptedSlugs && (
      attemptedSlugs.has(crawlerJob.slug) || (assembled && attemptedSlugs.has(assembled.slug))
    ));
    const outcome = reconcileRetranslationState(crawlerJob, { attempted });
    if (outcome === 'cleared') {
      console.log(`     ✅ Cleared needsRetranslation for: ${crawlerJob.slug?.slice(0, 60)}`);
      changed = true;
    } else if (outcome === 'gaveup') {
      console.log(`     🛑 Giving up after ${MAX_RETRANSLATION_ATTEMPTS} attempts: ${crawlerJob.slug?.slice(0, 60)}`);
      changed = true;
    } else if (outcome === 'counted' || outcome === 'reset') {
      changed = true;
    }

    if (changed) updated += 1;
  }

  if (updated > 0) {
    writeJsonAtomic(crawlerFilePath, crawlerData);
  }

  return { updated, handledSlugs };
}

/**
 * Increment retry counter directly on per-crawler file for stuck jobs.
 * This catches jobs that don't appear in the assembled dataset (e.g. companies
 * not in the shared crawler's census) where syncTranslationsToCrawlerFile can't
 * match them. After 3 failed attempts, suppress the flag to break the loop.
 * @param {Set<string>} [attemptedSlugs] - Slugs the crawler actually translated
 *   this run; only these advance the give-up counter.
 */
function incrementRetryCounterOnCrawlerFile(companyKey, handledSlugs, attemptedSlugs) {
  const crawlerFilePath = path.join(BY_CRAWLER_DIR, `${companyKey}.json`);

  if (!fs.existsSync(crawlerFilePath)) return;

  const crawlerData = readJson(crawlerFilePath);
  if (!crawlerData || !Array.isArray(crawlerData.jobs)) return;

  let changed = false;
  for (const job of crawlerData.jobs) {
    if (!job.needsRetranslation) continue;
    // Skip jobs already handled by syncTranslationsToCrawlerFile to avoid
    // double-incrementing the retry counter in the same pipeline run.
    if (handledSlugs && handledSlugs.has(job.slug)) continue;

    // Advance the give-up counter only for jobs the crawler actually translated
    // this run (content changed) — never the un-reached tail of a processed
    // company (that would mass-suppress translatable backlog).
    const attempted = !!(attemptedSlugs && attemptedSlugs.has(job.slug));
    const outcome = reconcileRetranslationState(job, { attempted });
    if (outcome === 'gaveup') {
      console.log(`     🛑 Giving up after ${MAX_RETRANSLATION_ATTEMPTS} direct attempts: ${String(job.slug || '').slice(0, 60)}`);
    }
    if (outcome !== 'noop' && outcome !== 'waiting') changed = true;
  }

  if (changed) {
    writeJsonAtomic(crawlerFilePath, crawlerData);
  }
}

/**
 * Invalidate translation cache entries for jobs that isIncomplete() flags.
 * This breaks the deadlock where stale cache serves bad translations that
 * isIncomplete() rejects but the translation loop accepts (non-empty slot).
 */
function invalidateCacheForIncompleteJobs(companyKey, incompleteJobs) {
  if (!incompleteJobs.length) return 0;
  const cacheFile = path.join(TRANSLATION_CACHE_DIR, `${companyKey}.json`);
  if (!fs.existsSync(cacheFile)) return 0;

  let cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch { return 0; }

  const slugs = new Set(incompleteJobs.map(j => j.slug).filter(Boolean));
  let invalidated = 0;
  for (const slug of slugs) {
    if (cache[slug]) {
      delete cache[slug];
      invalidated++;
    }
  }

  if (invalidated > 0) {
    writeJsonAtomic(cacheFile, cache);
  }
  return invalidated;
}

export function filterPendingForCompany(pendingJobs, companyKeyFilter) {
  if (!companyKeyFilter) return [...pendingJobs];
  return pendingJobs.filter((job) => (
    normalizeCompanyKey(job.companyKey || job.company || '') === companyKeyFilter
  ));
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
  // attempted=false here: this scan does NOT translate, so it only clears flags on
  // now-complete jobs and lifts give-up on re-crawled ones — it must NEVER count a
  // give-up attempt (that would suppress un-reached backlog; see
  // reconcileRetranslationState). Give-up counting happens only in the per-company
  // sync paths below, which run on jobs actually translated this run.
  let directCleared = 0;
  let directReset = 0;
  if (fs.existsSync(BY_CRAWLER_DIR)) {
    for (const file of listSliceFileNames(BY_CRAWLER_DIR)) {
      const filePath = path.join(BY_CRAWLER_DIR, file);
      const crawlerData = readJson(filePath);
      if (!crawlerData?.jobs || !Array.isArray(crawlerData.jobs)) continue;
      let fileChanged = false;
      for (const job of crawlerData.jobs) {
        const outcome = reconcileRetranslationState(job, { attempted: false });
        if (outcome === 'reset' || outcome === 'cleared') fileChanged = true;
        if (outcome === 'cleared') directCleared++;
        else if (outcome === 'reset') directReset++;
      }
      if (fileChanged) {
        writeJsonAtomic(filePath, crawlerData);
      }
    }
  }
  if (directCleared > 0) {
    console.log(`⚡ Cleared ${directCleared} stale needsRetranslation flags from per-crawler files`);
  }
  if (directReset > 0) {
    console.log(`♻️  Lifted give-up on ${directReset} re-crawled job(s) (source changed)`);
  }

  // Find all jobs needing translation (flagged or incomplete)
  let pending = jobs.filter(needsTranslation);
  const pendingBeforeCompanyFilter = pending.length;

  // Filter to a single company if --company-key is specified
  if (COMPANY_KEY_FILTER) {
    const before = pending.length;
    pending = filterPendingForCompany(pending, COMPANY_KEY_FILTER);
    console.log(`🎯 Company filter: ${COMPANY_KEY_FILTER} — ${pending.length}/${before} pending jobs match\n`);
  }
  const pendingAfterCompanyFilter = pending.length;

  const flaggedCount = pending.filter(j => j.needsRetranslation).length;
  const incompleteCount = pending.length - flaggedCount;

  if (pending.length === 0) {
    emitTranslationShadowPreflightV2(() => ({
      dryRun: false,
      notAttemptedReason: 'legacy_no_pending_before_execution_plan',
      jobs,
      pendingJobs: pending,
      legacy: {
        allowNoTraffic: ALLOW_NO_TRAFFIC,
        companyFilter: {
          population: 'assembled_company_filtered',
          value: COMPANY_KEY_FILTER || null,
          before: pendingBeforeCompanyFilter,
          after: pendingAfterCompanyFilter,
        },
        maxJobs: MAX_JOBS,
        preClear: { status: 'not_needed' },
        postClear: { population: 'assembled_company_filtered', pending: 0 },
        trafficSource: TRAFFIC_SOURCE_PATH,
      },
    }));
    console.log('✅ All jobs have complete locale coverage. Nothing to re-localize.');
    return;
  }

  // Flag-first ordering only. The ordering that decides WHICH jobs make the cap
  // is applied AFTER the pre-clear below (orderPendingByTraffic) — applying it
  // here too would be wasted work, and the pre-clear rebuilds `pending` from
  // scratch, which is exactly how the old `pending.sort(sortByPriority)` came to
  // be silently discarded on every run that pre-cleared anything.
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
    emitTranslationShadowPreflightV2(() => ({
      dryRun: true,
      jobs,
      pendingJobs: pending,
      legacy: {
        allowNoTraffic: ALLOW_NO_TRAFFIC,
        companyFilter: {
          population: 'assembled_company_filtered',
          value: COMPANY_KEY_FILTER || null,
          before: pendingBeforeCompanyFilter,
          after: pendingAfterCompanyFilter,
        },
        maxJobs: MAX_JOBS,
        preClear: { status: 'not_attempted', reason: 'legacy_dry_run_before_execution_plan' },
        postClear: null,
        trafficSource: TRAFFIC_SOURCE_PATH,
      },
    }));
    console.log('\n🏁 Dry run — skipping re-localization.');
    return;
  }

  // Fast-path: clear flags for jobs that are already complete (no AI call needed).
  const preCleared = clearRetranslationFlags(jobs);
  if (preCleared > 0) {
    writeJsonAtomic(DATA_JOBS_PATH, jobs, { compact: true });
    console.log(`⚡ Pre-cleared ${preCleared} flags for already-complete jobs in assembled dataset`);
    console.log('');

    // Re-filter pending after pre-clear
    const stillPendingJobs = jobs.filter(needsTranslation);
    const filteredStillPendingJobs = filterPendingForCompany(stillPendingJobs, COMPANY_KEY_FILTER);
    if (filteredStillPendingJobs.length === 0) {
      emitTranslationShadowPreflightV2(() => ({
        dryRun: false,
        notAttemptedReason: 'legacy_preclear_emptied_execution_plan',
        jobs,
        pendingJobs: filteredStillPendingJobs,
        legacy: {
          allowNoTraffic: ALLOW_NO_TRAFFIC,
          companyFilter: {
            population: 'assembled_company_filtered',
            value: COMPANY_KEY_FILTER || null,
            before: pendingBeforeCompanyFilter,
            after: 0,
            reappliedAfterPreClear: Boolean(COMPANY_KEY_FILTER),
          },
          maxJobs: MAX_JOBS,
          preClear: {
            direct: {
              population: 'all_per_crawler_occurrences',
              cleared: directCleared,
              reset: directReset,
            },
            assembled: {
              population: 'all_assembled_jobs',
              flagsCleared: preCleared,
            },
            filteredPending: {
              population: 'assembled_company_filtered',
              before: pendingAfterCompanyFilter,
            },
          },
          postClear: { population: 'assembled_company_filtered', pending: 0 },
          trafficSource: TRAFFIC_SOURCE_PATH,
        },
      }));
      console.log('✅ All jobs complete after pre-clear. Nothing left to translate.');
      return;
    }
    // Update pending count, re-applying company filter if active
    pending.length = 0;
    for (const j of filteredStillPendingJobs) pending.push(j);
    if (COMPANY_KEY_FILTER) {
      console.log(`🎯 Company filter re-applied after pre-clear: ${pending.length} jobs for ${COMPANY_KEY_FILTER}\n`);
    }
  }

  // ── Traffic-weighted ordering (issue #5650) ────────────────────────────
  // Applied HERE, after the pre-clear, because the pre-clear rebuilds `pending`
  // and would otherwise discard it. This is the decision the cap makes: the
  // queue is far larger than any per-run cap, so the only lever that changes
  // what users see is WHICH jobs the cap contains. Ordered by served pageviews
  // (data/job-popularity.json, Firestore job_views), with a fixed share of the
  // batch drawn oldest-first so the tail cannot starve. An unusable traffic
  // source throws instead of falling back — see assertTrafficPriorityUsable.
  const trafficCapture = {};
  const orderedPending = orderPendingByTraffic(pending, { capture: trafficCapture });
  pending.length = 0;
  for (const j of orderedPending) pending.push(j);

  // Build ordered list of (companyKey, jobCount) pairs from priority-sorted pending jobs, capped at MAX_JOBS
  const effectiveMax = Math.min(MAX_JOBS, pending.length);
  const cappedPending = pending.slice(0, effectiveMax);
  const companyJobCounts = new Map();
  for (const job of cappedPending) {
    const key = normalizeCompanyKey(job.companyKey || job.company || '');
    if (!key) {
      continue;
    }
    companyJobCounts.set(key, (companyJobCounts.get(key) || 0) + 1);
  }

  const companyKeys = [...companyJobCounts.keys()];

  emitTranslationShadowPreflightV2(() => ({
    dryRun: false,
    jobs,
    pendingJobs: pending,
    orderedPending,
    capWindow: cappedPending,
    capWindowCompanyKeys: cappedPending.map((job) => {
      const key = normalizeCompanyKey(job.companyKey || job.company || '');
      return key || null;
    }),
    companyBudgets: [...companyJobCounts].map(([companyKey, count]) => ({ companyKey, jobs: count })),
    traffic: trafficCapture,
    legacy: {
      allowNoTraffic: ALLOW_NO_TRAFFIC,
      companyFilter: {
        population: 'assembled_company_filtered',
        value: COMPANY_KEY_FILTER || null,
        before: pendingBeforeCompanyFilter,
        after: pending.length,
        reappliedAfterPreClear: preCleared > 0,
      },
      maxJobs: MAX_JOBS,
      preClear: {
        direct: {
          population: 'all_per_crawler_occurrences',
          cleared: directCleared,
          reset: directReset,
        },
        assembled: {
          population: 'all_assembled_jobs',
          flagsCleared: preCleared,
        },
        filteredPending: {
          population: 'assembled_company_filtered',
          before: pendingAfterCompanyFilter,
        },
      },
      postClear: { population: 'assembled_company_filtered', pending: pending.length },
      trafficSource: TRAFFIC_SOURCE_PATH,
    },
  }));

  if (companyKeys.length === 0) {
    console.log('⚠️  No valid company keys found. Skipping.');
    return;
  }

  console.log(`\n🔄 Re-localizing up to ${effectiveMax} jobs across ${companyKeys.length} companies (incremental save)...`);

  // Process each company separately with intermediate saves
  let totalFixed = 0;
  let totalProcessed = 0;
  let consecutiveFailures = 0;
  const startTime = LEGACY_CLOCK.now();

  // A/B sul thinking di claude-cli/haiku. Spento di default: si accende con
  // TRANSLATION_THINKING_AB=1. Vedi scripts/lib/thinking-ab.mjs per il perche'
  // il braccio si assegna per azienda e il sale include l'id della run.
  const thinkingAb = isThinkingAbEnabled(process.env);
  const thinkingSalt = runSalt(process.env);
  const thinkingRows = [];
  if (thinkingAb) {
    console.log(`\n🧪 A/B thinking attivo (sale ${thinkingSalt}): ogni azienda va a un braccio, il tempo e l'accettazione sono registrati per braccio.`);
  }

  for (const key of companyKeys) {
    const companyJobCount = companyJobCounts.get(key) || 0;

    // Stop before starting a new company once the RUN-WIDE cascade deadline
    // passes, so no company is started that would only immediately
    // defer (its per-call budget would be ~0) and so ~100min is left for the
    // Argos mop-up + the always()-guarded commit/scatter/slug/deploy steps before
    // the 350min job timeout. (Was TIME_BUDGET_MS=320min, which left a 250–320min
    // window where late companies could still run — review #2205 🔴 round 2.)
    const companyNowMs = LEGACY_CLOCK.now();
    const companyStopReason = cascadeStopReason({
      nowMs: companyNowMs,
      runStartMs: RUN_START_MS,
      cascadeDeadlineMs: CASCADE_LOCALIZATION_DEADLINE_MS,
      passStartMs: startTime,
      timeBudgetMs: TIME_BUDGET_MS,
      timeBudgetFraction: 1,
    });
    if (companyStopReason) {
      const elapsedMin = Math.round((companyNowMs - RUN_START_MS) / 60_000);
      console.log(`\n⏰ ${companyStopReason === 'cascade deadline' ? 'Cascade deadline' : 'Time budget'} reached (${elapsedMin}min run-wide elapsed) — stopping to leave room for mop-up + commit.`);
      console.log(`   ${totalFixed} jobs translated so far; ${companyKeys.length - companyKeys.indexOf(key)} companies remaining (deferred to next run).`);
      break;
    }

    const elapsedMs = companyNowMs - RUN_START_MS;
    console.log(`\n🔄 [${totalProcessed + companyJobCount}/${effectiveMax}] Translating ${key} (${companyJobCount} jobs) — ${Math.round(elapsedMs / 60_000)}min elapsed...`);

    // Invalidate stale cache entries for incomplete jobs so the shared crawler
    // actually calls translation APIs instead of serving cached bad translations.
    const companyIncomplete = cappedPending.filter(j =>
      normalizeCompanyKey(j.companyKey || j.company || '') === normalizeCompanyKey(key));
    const invalidated = invalidateCacheForIncompleteJobs(key, companyIncomplete);
    if (invalidated > 0) {
      console.log(`   🗑️  Invalidated ${invalidated} stale cache entries for incomplete jobs`);
    }

    // Re-set needsRetranslation on per-crawler file for incomplete jobs so the
    // FRO-327 cache bypass kicks in (even if the circuit breaker previously cleared it).
    if (companyIncomplete.length > 0) {
      const crawlerFilePath = path.join(BY_CRAWLER_DIR, `${key}.json`);
      if (fs.existsSync(crawlerFilePath)) {
        const crawlerData = readJson(crawlerFilePath);
        if (crawlerData?.jobs && Array.isArray(crawlerData.jobs)) {
          const incompleteSlugs = new Set(companyIncomplete.map(j => j.slug).filter(Boolean));
          let flagged = 0;
          for (const cj of crawlerData.jobs) {
            if (incompleteSlugs.has(cj.slug) && !cj.needsRetranslation
                && !cj.localeMismatchSuppressed && isIncomplete(cj)) {
              cj.needsRetranslation = true;
              cj.retranslationAttempts = 0;
              flagged++;
            }
          }
          if (flagged > 0) {
            writeJsonAtomic(crawlerFilePath, crawlerData);
            console.log(`   🔁 Re-flagged ${flagged} stuck jobs for retranslation`);
          }
        }
      }
    }

    try {
      // Snapshot locale content BEFORE the crawler so we can tell which jobs it
      // actually translated (changed) vs the budget-unreached tail.
      const preCrawlerJobs = readJson(DATA_JOBS_PATH);
      const preSig = Array.isArray(preCrawlerJobs)
        ? snapshotCompanySignatures(preCrawlerJobs, key) : new Map();

      // Il braccio si applica SOLO attorno alla chiamata del crawler, e il
      // ripristino sta in finally: se il crawler lancia, l'azienda successiva
      // erediterebbe il braccio sbagliato e l'esperimento misurerebbe un mix.
      const thinkingArm = thinkingAb ? assignThinkingArm(key, thinkingSalt) : null;
      const armHandle = thinkingArm ? applyThinkingArm(thinkingArm, process.env) : null;
      // Il tempo si legge da LEGACY_CLOCK, mai dall'orologio di sistema: dopo
      // il punto di emissione dello shadow preflight vale l'orologio compensato,
      // e un test in translation-shadow-preflight-v2.test.ts lo difende
      // cercando il nome dell'altra funzione nel sorgente — quindi non va
      // nominata nemmeno in un commento. Per questa misura la scelta e' anche
      // piu' corretta: esclude il costo dell'osservatore invece di addebitarlo
      // al crawler.
      const companyStartedMs = LEGACY_CLOCK.now();
      try {
        await runSharedCrawler([key], companyJobCount);
      } finally {
        if (armHandle) armHandle.restore();
      }
      const companyElapsedMs = LEGACY_CLOCK.now() - companyStartedMs;

      // Save progress after each company: clear flags and write to disk
      const fixedBeforeCompany = totalFixed;
      const currentJobs = readJson(DATA_JOBS_PATH);
      const attemptedSlugs = Array.isArray(currentJobs)
        ? changedSlugsSince(preSig, currentJobs, key) : new Set();
      if (Array.isArray(currentJobs)) {
        const cleared = clearRetranslationFlags(currentJobs);
        if (cleared > 0) {
          writeJsonAtomic(DATA_JOBS_PATH, currentJobs, { compact: true });
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
        const syncResult = syncTranslationsToCrawlerFile(key, currentJobs, attemptedSlugs);
        if (syncResult.updated > 0) {
          console.log(`   📁 ${key}: ${syncResult.updated} jobs synced to per-crawler file`);
        }

        // Increment retry counter directly on per-crawler file for stuck jobs.
        // This catches jobs that don't appear in the assembled dataset (e.g. companies
        // not in the shared crawler's census) where syncTranslationsToCrawlerFile can't
        // match them. After 3 failed attempts, suppress the flag to break the loop.
        incrementRetryCounterOnCrawlerFile(key, syncResult.handledSlugs, attemptedSlugs);
      }

      if (thinkingArm) {
        // `cleared` e' il delta di totalFixed: le traduzioni che hanno superato
        // il gate. `attempted` e' quante il crawler ne ha toccate. Il rapporto
        // fra i due e' la meta' che conta dell'esperimento — un braccio piu'
        // veloce che produce piu' scarti non e' piu' veloce.
        const row = {
          arm: thinkingArm,
          companyKey: key,
          jobCount: companyJobCount,
          elapsedMs: companyElapsedMs,
          attempted: attemptedSlugs.size,
          cleared: totalFixed - fixedBeforeCompany,
        };
        thinkingRows.push(row);
        console.log(`   🧪 ${key}: braccio ${row.arm}, ${Math.round(row.elapsedMs / 1000)}s per ${row.jobCount} job, ${row.cleared}/${row.attempted} accettate`);
      }

      totalProcessed += companyJobCount;
      consecutiveFailures = 0;
      if (totalProcessed >= effectiveMax) break;

    } catch (err) {
      consecutiveFailures++;
      console.error(`   ❌ ${key} failed: ${err.message}`);
      console.log(`   💾 Progress saved: ${totalFixed} jobs translated before failure`);
      if (shouldStopAfterConsecutiveFailures(consecutiveFailures)) {
        // N failures in a row is a systemic signal (e.g. AI quota exhausted on
        // every tier) — stop to avoid burning more quota on companies that
        // would fail too. A single/isolated failure continues to the next
        // company instead of starving every later company for the whole run.
        console.log(`   🛑 ${consecutiveFailures} consecutive company failures — stopping to avoid burning more AI quota`);
        break;
      }
      console.log(`   ⏭️  Isolated failure, continuing to next company`);
    }
  }

  // ── Retry pass: re-attempt companies that had partial success ──────────
  // Rate limits often clear partway through a run. Companies processed early
  // may have had failures that would succeed now. Only retry if we have time.
  const retryStartReason = cascadeStopReason({
    nowMs: LEGACY_CLOCK.now(),
    runStartMs: RUN_START_MS,
    cascadeDeadlineMs: CASCADE_LOCALIZATION_DEADLINE_MS,
    passStartMs: startTime,
    timeBudgetMs: TIME_BUDGET_MS,
    timeBudgetFraction: 0.85,
  });
  if (totalFixed > 0 && !retryStartReason) {
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
        const retryCompanyStopReason = cascadeStopReason({
          nowMs: LEGACY_CLOCK.now(),
          runStartMs: RUN_START_MS,
          cascadeDeadlineMs: CASCADE_LOCALIZATION_DEADLINE_MS,
          passStartMs: startTime,
          timeBudgetMs: TIME_BUDGET_MS,
          timeBudgetFraction: 0.95,
        });
        if (retryCompanyStopReason) {
          console.log(`   ⏰ Retry stopped: ${retryCompanyStopReason} reached — deferring remaining companies to the next run`);
          break;
        }

        console.log(`   🔁 Retrying ${key} (${count} jobs)...`);
        try {
          const preRetryJobs = readJson(DATA_JOBS_PATH);
          const preRetrySig = Array.isArray(preRetryJobs)
            ? snapshotCompanySignatures(preRetryJobs, key) : new Map();
          // Stesso braccio del primo passaggio: `assignThinkingArm` e'
          // deterministica sulla coppia (azienda, sale), quindi l'azienda non
          // cambia braccio fra i due passaggi. Senza questo l'azienda verrebbe
          // ritentata con il thinking al default mentre l'esperimento la conta
          // nel braccio assegnato, e la misura sarebbe un miscuglio.
          const retryArm = thinkingAb ? assignThinkingArm(key, thinkingSalt) : null;
          const retryHandle = retryArm ? applyThinkingArm(retryArm, process.env) : null;
          const retryStartedMs = LEGACY_CLOCK.now();
          const fixedBeforeRetry = totalFixed;
          try {
            await runSharedCrawler([key], count);
          } finally {
            if (retryHandle) retryHandle.restore();
          }
          const retryElapsedMs = LEGACY_CLOCK.now() - retryStartedMs;
          const afterRetry = readJson(DATA_JOBS_PATH);
          // La riga si registra SEMPRE, anche quando il retry non fa passare
          // niente. Dentro un `if (cleared > 0)` un retry sterile — che il
          // tempo lo ha speso comunque — non entrerebbe in nessun braccio, e
          // il braccio con piu' retry a vuoto perderebbe proprio le righe che
          // lo penalizzano: ogni riga sopravvissuta avrebbe `cleared >= 1` e
          // l'acceptRate risulterebbe gonfiato per costruzione. E' l'opposto
          // di cio' che questa metrica esiste per catturare.
          const retryAttemptedAll = Array.isArray(afterRetry)
            ? changedSlugsSince(preRetrySig, afterRetry, key) : new Set();
          if (retryArm) {
            thinkingRows.push({
              arm: retryArm,
              companyKey: key,
              pass: 'retry',
              // Zero, non `count`: sono gli STESSI job gia' contati nella riga
              // del primo passaggio. Il tempo del retry va nel numeratore di
              // msPerJob perche' e' stato speso davvero, ma i job non vanno
              // contati due volte nel denominatore.
              jobCount: 0,
              elapsedMs: retryElapsedMs,
              attempted: retryAttemptedAll.size,
              cleared: 0,
            });
          }
          if (Array.isArray(afterRetry)) {
            const cleared = clearRetranslationFlags(afterRetry);
            if (cleared > 0) {
              writeJsonAtomic(DATA_JOBS_PATH, afterRetry, { compact: true });
              totalFixed += cleared;
              console.log(`   ✅ ${key} retry: ${cleared} more jobs translated`);
              syncTranslationsToCrawlerFile(key, afterRetry, retryAttemptedAll);
              if (retryArm) {
                // La riga e' gia' in coda: qui si aggiorna solo l'esito.
                thinkingRows[thinkingRows.length - 1].cleared = totalFixed - fixedBeforeRetry;
              }
            }
          }
        } catch {
          console.log(`   ⚠️  ${key} retry failed — will be picked up by next scheduled run`);
        }
      }
    }
  } else if (totalFixed > 0) {
    console.log(`\n⏰ Retry pass skipped: ${retryStartReason} reached — deferring retries to the next run`);
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

  logCascadeSummary();

  if (thinkingAb && thinkingRows.length > 0) {
    const summary = summarizeThinkingAb(thinkingRows);
    console.log(`\n🧪 A/B thinking — ${summary.rows} aziende, sale ${thinkingSalt}`);
    for (const [arm, a] of Object.entries(summary.arms)) {
      const ms = a.msPerJob === null ? 'n/d' : `${Math.round(a.msPerJob / 1000)}s/job`;
      const acc = a.acceptRate === null ? 'n/d' : `${(a.acceptRate * 100).toFixed(1)}%`;
      console.log(`   ${arm.padEnd(12)} ${String(a.companies).padStart(3)} aziende, ${String(a.jobs).padStart(4)} job, ${ms.padStart(8)}, accettate ${acc} (${a.cleared}/${a.attempted})`);
    }
    // L'artefatto vive nel RUNNER_TEMP e viene caricato dal workflow: non
    // committarlo, sarebbe un file di dati riscritto a ogni run.
    const outDir = process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp';
    const outPath = path.join(outDir, 'translation-thinking-ab.json');
    try {
      writeJsonAtomic(outPath, { salt: thinkingSalt, generatedAt: new Date().toISOString(), summary, rows: thinkingRows });
      console.log(`   📄 righe scritte in ${outPath}`);
    } catch (err) {
      console.log(`   ⚠️  impossibile scrivere l'artefatto A/B: ${err.message}`);
    }
  }
  console.log('✅ Re-localization complete.');
}

// Only run the pipeline when invoked directly (`node scripts/relocalize-pending-jobs.mjs`).
// Importing the module (e.g. from tests, to exercise reconcileRetranslationState /
// isIncomplete) must NOT trigger a full relocalization that mutates slice files.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false; // node REPL / no script → not a direct invocation
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
  } catch { return false; }
})();

if (invokedDirectly) {
  // Publish the run start so the local-MT mop-up (a separate process in a later
  // workflow step) can bound itself ELAPSED-AWARE to the SAME run start rather
  // than getting a fresh full budget — preventing cascade-overflow + mop-up +
  // commit from approaching the 350min job timeout (#2212). Done here, inside the
  // direct-invocation guard, so importing this module (e.g. from the mop-up) does
  // NOT overwrite the marker with the importer's start time.
  markRunStart(RUN_START_MS);
  main().catch((err) => {
    console.error('❌ Re-localization failed:', err?.message || err);
    process.exit(1);
  });
}
