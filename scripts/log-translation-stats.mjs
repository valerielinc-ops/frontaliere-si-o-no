#!/usr/bin/env node
/**
 * Append a translation stats snapshot to data/translation-stats-history.json.
 * Called by translate-pending.yml after each run to build a monitoring history.
 *
 * Usage: node scripts/log-translation-stats.mjs [label]
 *
 * ── Why the percentage is FLOORED, never rounded ──────────────────────────
 * Until 2026-08-10 the summary line was
 *
 *     `   Complete:  ${entry.complete} (${Math.round(entry.complete/total*100)}%)`
 *
 * and `Math.round` turns 99.57% into "100%". The committed history shows a run
 * with 26208/26321 complete — i.e. 113 jobs with a missing locale slot and 1930
 * carrying `needsRetranslation: true` — printed as `Complete: … (100%)`. That
 * one `Math.round` is where "job translation is at 100%" came from.
 *
 * Two rules make that impossible now:
 *   1. the percentage is floored (`formatCompleteRatio`), so a non-zero
 *      incomplete count can never read as 100%;
 *   2. the raw counts are always printed next to it, and the word COMPLETE is
 *      reserved for the exact case — nothing missing AND nothing flagged.
 *
 * ── Why "complete" is not "translated" ────────────────────────────────────
 * `complete` here means "all four locale slots are populated, long enough,
 * and (since #5593 item1, 2026-08-13) each non-source title actually reads as
 * its own locale". It used to be a pure PRESENCE measure that counted
 * characters only; a German title copied into the `it` slot used to score as
 * complete. Jobs carrying `needsRetranslation: true` are still complete by
 * the presence half of that definition, which is why they are reported as a
 * separate, subtractive figure (`verifiedTranslated` = slots present minus
 * flagged).
 *
 * ── One `isIncomplete()`, not two (#5593 item1) ───────────────────────────
 * Until 2026-08-13 this file carried its OWN copy of the incomplete-job
 * predicate, with a comment claiming it was "bit-identical to the
 * pre-2026-08-10 isIncomplete()" in scripts/relocalize-pending-jobs.mjs. PR
 * #5575 (2026-08-11) removed that other isIncomplete()'s cross-locale
 * `othersDiffer` escape hatch (a DE-source job whose EN+FR slots translated
 * used to suppress the check on a still-German IT slot) — this file's copy
 * was never updated to match, so the same byte-copied title was judged
 * "excused" here and "incomplete" there. `classifyJob` now DELEGATES to the
 * single canonical `isIncomplete()` instead of re-deriving the same judgment
 * a second time — that duplication is what produced the drift, so the fix is
 * to have exactly one implementation, not to re-sync two.
 *
 * `sourceCopyExcused` is kept, but its meaning inverts from "known accepted
 * exemption" to "canary": since the canonical isIncomplete() has no more
 * escape hatch, a title byte-copy in a non-source locale is now ALWAYS
 * incomplete, so this counter should read effectively zero going forward. A
 * non-zero value flags something worth investigating — a byte copy that
 * slipped past the language check some other way — not an expected steady
 * state.
 *
 * ── Rounding direction is deliberate and asymmetric ───────────────────────
 * Success rates are floored here (never overstate the good news). Problem rates
 * are ceiled in validate-translation-completeness.mjs (`formatFlaggedRate`), so
 * a non-zero problem can never print as "0%". Same reason, opposite direction —
 * do not "unify" them into one helper.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIncomplete as isIncompleteCanonical } from './relocalize-pending-jobs.mjs';
import { titleOffence, descriptionOffence } from './mark-mistranslated-jobs.mjs';
import { summarizeQueueAge } from './lib/job-traffic-priority.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const CRAWLERS_DIR = 'data/jobs/by-crawler';
const STATS_FILE = 'data/translation-stats-history.json';

/**
 * Sidecar carrying the incomplete cohort from the `before` pass to the `after`
 * pass of the SAME run. Deliberately OUTSIDE the repository.
 *
 * Age at completion — the number the translation map's 24-hour target is
 * actually about — cannot be read off a single snapshot: a job that finishes
 * leaves the queue, so `queueAge` never sees it again. It needs a before/after
 * diff, and the only per-job state that requires is "which jobs were incomplete
 * when this run started".
 *
 * The corpus is NOT where that belongs. Stamping a `completedAt` on every job
 * record would put ~14k writes and a schema change into the hot path to
 * produce one median. The two passes run as two steps of one GitHub Actions
 * job, so the runner's temp dir already outlives the gap between them, and the
 * file dies with the runner.
 *
 * Override with TRANSLATION_COHORT_FILE (tests, local runs).
 */
const COHORT_FILE = process.env.TRANSLATION_COHORT_FILE
  || path.join(os.tmpdir(), 'translation-incomplete-cohort.json');
export const LOCALES = ['it', 'en', 'de', 'fr'];
export const MIN_DESC = 120;
export const MIN_TITLE = 3;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Format a SUCCESS ratio (higher is better) so it can never overstate itself.
 *
 * Floors to one decimal and prints the raw counts alongside. `100%` is returned
 * only when `part >= total` — the `Math.min(…, 99.9)` is belt-and-braces for a
 * float that lands on 1000/1000 without the counts being equal.
 *
 * @param {number} part
 * @param {number} total
 * @returns {string} e.g. `26208/26321 (99.5%)` — never `(100%)` unless exact.
 */
export function formatCompleteRatio(part, total) {
  if (!Number.isFinite(total) || total <= 0) return `${part}/${total || 0} (n/a)`;
  if (part >= total) return `${part}/${total} (100%)`;
  const floored = Math.min(Math.floor((part / total) * 1000) / 10, 99.9);
  return `${part}/${total} (${floored.toFixed(1)}%)`;
}

/**
 * Classify one job.
 *
 * `incomplete` DELEGATES to the single canonical `isIncomplete()` in
 * scripts/relocalize-pending-jobs.mjs — see the module header for why this
 * file no longer carries its own copy of that predicate.
 *
 * `sourceCopyExcused` stays OBSERVATIONAL only and does not feed `incomplete`.
 * It records that a locale slot holds a byte-copy of the source title WHILE
 * the canonical predicate still says the job is complete — the pre-#5575
 * escape hatch this used to measure no longer exists anywhere, so this should
 * read as zero in practice. See the module header for what a non-zero value
 * would mean.
 *
 * @param {object} job
 * @returns {{ incomplete: boolean, sourceCopyExcused: boolean }}
 */
export function classifyJob(job) {
  const tbl = job.titleByLocale || {};
  const sourceTitle = (job.title || '').trim().toLowerCase();
  const sourceLang = job.sourceLang || 'it';
  const incomplete = isIncompleteCanonical(job);

  let sourceCopyExcused = false;
  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    if (title && title.toLowerCase() === sourceTitle && locale !== sourceLang) {
      sourceCopyExcused = true;
      break;
    }
  }
  // Only a canary when the job otherwise passed: if `incomplete` is already
  // true (the overwhelmingly common case for a byte copy now), there is
  // nothing to excuse.
  sourceCopyExcused = sourceCopyExcused && !incomplete;

  return { incomplete, sourceCopyExcused };
}

/** Re-exported for callers that only need the predicate (single implementation, #5593). */
export function isIncomplete(job) {
  return isIncompleteCanonical(job);
}

/**
 * All four locale slots populated by CHARACTER COUNT alone — no language
 * judgment of any kind.
 *
 * This is the measure the `Language-verified:` note has always *claimed* to
 * contrast itself against, and until now nothing in this file actually
 * computed it: `complete` stopped being a pure presence count on 2026-08-13,
 * when #5593 folded `titleLooksUntranslated()` and the >= 0.65 description
 * detector into the canonical `isIncomplete()`. Measured on origin/main
 * 2026-09-03 the two are far apart — 27,928 jobs have four populated slots,
 * only 12,766 clear `isIncomplete()` — so reporting `languageVerified` against
 * `complete` would be a tautology (every complete job passes the language
 * check BY CONSTRUCTION, because the check is already inside the predicate
 * that defined it). Against presence it is a real number.
 *
 * @param {object} job
 * @returns {boolean}
 */
export function slotsPresentByLength(job) {
  const tbl = job.titleByLocale || {};
  const dbl = job.descriptionByLocale || {};
  return LOCALES.every((locale) =>
    String(tbl[locale] || '').trim().length >= MIN_TITLE &&
    String(dbl[locale] || '').trim().length >= MIN_DESC);
}

/**
 * Does a job with four populated slots actually READ in the four locales it
 * claims? STRICTLY OBSERVATIONAL: nothing here feeds `incomplete`, marks a job,
 * or changes what the pipeline translates — see the module header.
 *
 * Both detectors are imported, never re-implemented (#5593's lesson):
 *   - titles   -> `titleOffence`, exact-lexical `titleLooksUntranslated()`.
 *     The statistical detector is NOT usable here: measured on 300 live titles
 *     it false-alarms on 32.7% of correct Italian and misses 55.0% of broken
 *     ones (scripts/lib/job-locale-utils.mjs, TITLE_LANG_CONFIDENCE_FLOOR).
 *   - descriptions -> `descriptionOffence`, the statistical detector at its
 *     production operating point (>= 120 chars, confidence >= 0.65).
 *
 * @param {object} job
 * @returns {boolean}
 */
export function isLanguageVerified(job) {
  if (!slotsPresentByLength(job)) return false;
  return !titleOffence(job) && !descriptionOffence(job);
}

/** @returns {object} a zeroed counter bag for {@link summarizeJobs}. */
export function emptyCounters() {
  return {
    total: 0,
    incomplete: 0,
    needsRetranslation: 0,
    flaggedAmongSlotsPresent: 0,
    suppressed: 0,
    sourceCopyExcused: 0,
    // Observational pair (#6389): presence with no language judgment, and the
    // subset of it that also reads in its own locale. Neither feeds `incomplete`.
    slotsPresentByLength: 0,
    languageVerified: 0,
    byLocale: { it: 0, en: 0, de: 0, fr: 0 },
    // One minimal timestamp-bearing stand-in per FLAGGED job, for the queue-age
    // metric (#5653 item 2). Not the job objects themselves: keeping references
    // to 10k jobs would pin every slice this loop was written to release.
    queuedSamples: [],
    // Identity of every INCOMPLETE job, collected only when the caller asks
    // (the `before` pass). ~14k short strings; the `after` pass does not need
    // them and does not pay for them.
    incompleteIds: [],
    // The same minimal stand-in, for jobs that are complete NOW and were in the
    // cohort the `before` pass handed over — i.e. the jobs THIS run completed.
    // A few hundred per run, never the whole corpus, because the cohort filter
    // is applied here rather than after the fact.
    //
    // `null`, not `[]`, is the DEFAULT on purpose: every caller that does not
    // hand over a cohort — the `before` pass, a manual snapshot,
    // lib/translation-observability.mjs — has not measured age at completion,
    // which is a different statement from having measured zero. An empty array
    // by default would quietly make all of them claim the second.
    completedSamples: null,
  };
}

/**
 * Stable-enough identity for the before/after cohort diff.
 *
 * `url` is the field every crawler slice carries for every job (1.226/1.226 on
 * roche.json, the shape is uniform) and it is what `extractStableJobId()` is
 * itself derived from. A job whose URL changes between the two passes of one
 * run simply drops out of the cohort, which understates the completion count
 * rather than inventing one.
 *
 * @param {object} job
 * @returns {string|null}
 */
export function jobCohortId(job) {
  const url = job && typeof job.url === 'string' ? job.url.trim() : '';
  return url || null;
}

/**
 * Count one array of jobs (one crawler slice). Pure — no I/O.
 *
 * @param {object[]} jobs
 * @param {{ collectIncompleteIds?: boolean, previouslyIncomplete?: Set<string>|null }} [opts]
 *   `collectIncompleteIds` fills `incompleteIds` (the `before` pass writes it to
 *   the cohort sidecar). `previouslyIncomplete` is that cohort read back on the
 *   `after` pass: a job that is complete now and appears in it was completed by
 *   THIS run, and only those jobs land in `completedSamples`.
 * @returns {ReturnType<typeof emptyCounters>}
 */
export function summarizeJobs(jobs, { collectIncompleteIds = false, previouslyIncomplete = null } = {}) {
  const c = emptyCounters();
  // Asked for the diff — so from here on "no sample" means zero, not unmeasured.
  if (previouslyIncomplete) c.completedSamples = [];
  for (const job of jobs) {
    c.total++;
    const { incomplete, sourceCopyExcused } = classifyJob(job);
    const flagged = !!job.needsRetranslation;
    if (flagged) {
      c.needsRetranslation++;
      c.queuedSamples.push({
        firstSeenAt: job.firstSeenAt,
        postedDate: job.postedDate,
        crawledAt: job.crawledAt,
        datePosted: job.datePosted,
      });
    }
    // A flagged job whose four slots are all populated is precisely the job the
    // old report called "complete". Subtracting these is what turns a presence
    // count into a (still upper-bound) translation count.
    if (flagged && !incomplete) c.flaggedAmongSlotsPresent++;
    if (job.localeMismatchSuppressed) c.suppressed++;
    if (sourceCopyExcused) c.sourceCopyExcused++;
    // Observational, and deliberately OUTSIDE the `incomplete` branch below:
    // this pair is measured for every job and steers nothing.
    if (slotsPresentByLength(job)) {
      c.slotsPresentByLength++;
      if (isLanguageVerified(job)) c.languageVerified++;
    }
    // Age AT COMPLETION, the number the 24-hour target is about (#17).
    // `queueAge` cannot produce it: a job that finishes leaves the queue, so a
    // snapshot never sees the moment it was served. Only the diff against the
    // cohort the `before` pass captured identifies the jobs this run completed.
    if (!incomplete && previouslyIncomplete) {
      const id = jobCohortId(job);
      if (id && previouslyIncomplete.has(id)) {
        c.completedSamples.push({
          firstSeenAt: job.firstSeenAt,
          postedDate: job.postedDate,
          crawledAt: job.crawledAt,
          datePosted: job.datePosted,
        });
      }
    }
    if (incomplete) {
      c.incomplete++;
      if (collectIncompleteIds) {
        const id = jobCohortId(job);
        if (id) c.incompleteIds.push(id);
      }
      const sourceDesc = (job.description || '').trim().toLowerCase();
      const sourceLang = job.sourceLang || 'it';
      for (const loc of LOCALES) {
        const title = (job.titleByLocale?.[loc] || '').trim();
        const desc = (job.descriptionByLocale?.[loc] || '').trim();
        if (title.length < MIN_TITLE || desc.length < MIN_DESC ||
            (desc.toLowerCase() === sourceDesc && loc !== sourceLang)) {
          c.byLocale[loc]++;
        }
      }
    }
  }
  return c;
}

/** Accumulate `src` into `dst` in place. @returns {object} dst */
export function mergeCounters(dst, src) {
  dst.total += src.total;
  dst.incomplete += src.incomplete;
  dst.needsRetranslation += src.needsRetranslation;
  dst.flaggedAmongSlotsPresent += src.flaggedAmongSlotsPresent;
  dst.suppressed += src.suppressed;
  dst.sourceCopyExcused += src.sourceCopyExcused;
  dst.slotsPresentByLength += src.slotsPresentByLength;
  dst.languageVerified += src.languageVerified;
  for (const loc of LOCALES) dst.byLocale[loc] += src.byLocale[loc];
  if (src.queuedSamples?.length) dst.queuedSamples.push(...src.queuedSamples);
  if (src.incompleteIds?.length) dst.incompleteIds.push(...src.incompleteIds);
  // An EMPTY array still promotes `dst` out of `null`: a slice that was diffed
  // and completed nothing is a measurement, and merging it must not read as
  // "never measured". Only a `null` on every side leaves the total unmeasured.
  if (Array.isArray(src.completedSamples)) {
    if (!Array.isArray(dst.completedSamples)) dst.completedSamples = [];
    dst.completedSamples.push(...src.completedSamples);
  }
  return dst;
}

/**
 * Turn counters into the history entry.
 *
 * `complete` keeps its old key AND its old meaning so the 200-entry committed
 * series stays comparable; `slotsPresent` is the same number under a name that
 * does not claim more than it measures.
 */
export function finalizeEntry(counters, { label, topPending = [], timestamp = new Date().toISOString(), now = Date.now() } = {}) {
  const complete = counters.total - counters.incomplete;
  // Queue AGE, not just queue SIZE (#5653 item 2).
  //
  // The retranslation queue is a moving window — between 2026-08-11 and
  // 2026-08-14 the corpus grew 22.690 → 26.924 (+18,5%) while the queue fell
  // 14.041 → 10.192. With only the count, a drain that is genuinely clearing
  // the backlog and a drain that is merely keeping up with new arrivals trace
  // the SAME curve. The age of the oldest job still queued separates them: it
  // can only fall if the tail is actually being served.
  //
  // It is also the specific detector for the risk that traffic-weighted
  // ordering (#5650, scripts/lib/job-traffic-priority.mjs) introduces — old
  // jobs carry less accumulated traffic, so a pure traffic order would drain
  // the head forever. `queueAge.alert` fires when the oldest queued job passes
  // QUEUE_AGE_ALERT_DAYS, which sits above the live maximum measured on
  // 2026-08-14 (123,2 days).
  const queueAge = summarizeQueueAge(counters.queuedSamples || [], { now });
  // Age AT COMPLETION for the jobs THIS run finished (#17). Same function, a
  // different population: `summarizeQueueAge` measures "days since first seen"
  // for whatever jobs it is handed, so handing it the newly-completed cohort
  // turns `p50AgeDays` into the median age at completion the map's second
  // destination condition is written against — no second implementation of the
  // same percentile.
  //
  // `null`, not an empty summary, when the `before` pass left no cohort: a run
  // that could not measure must not read as a run that completed nothing.
  const completionAge = counters.completedSamples
    ? summarizeQueueAge(counters.completedSamples, { now })
    : null;
  return {
    timestamp,
    label,
    total: counters.total,
    needsRetranslation: counters.needsRetranslation,
    suppressed: counters.suppressed,
    incomplete: counters.incomplete,
    complete,                          // legacy key, legacy meaning: slots present
    slotsPresent: complete,            // same number, honest name
    flaggedAmongSlotsPresent: counters.flaggedAmongSlotsPresent,
    verifiedTranslated: complete - counters.flaggedAmongSlotsPresent,
    sourceCopyExcused: counters.sourceCopyExcused,
    // Wired 2026-09-03 (#6389). The seam used to read `null` = "not measured";
    // `null` is now reserved for the 200 history rows written before the wiring,
    // so a series reader can still tell "we did not look" from "we looked and
    // found zero". The DENOMINATOR is `slotsPresentByLength`, not `complete`:
    // measured against `complete` this ratio is 100% by construction, because
    // #5593 put the same language check inside `isIncomplete()`.
    slotsPresentByLength: counters.slotsPresentByLength,
    languageVerified: counters.languageVerified,
    missingByLocale: counters.byLocale,
    // Measured from the job's first-seen timestamp (100% coverage on the live
    // queue), so it is an UPPER bound on time-in-queue — no field records when
    // the flag was set. Named for what it measures, never conflated with a
    // flag-time age this repo does not have.
    queueAge,
    // Present only on the `after` pass of a run whose `before` pass ran; `null`
    // everywhere else, including on the 200 rows written before #17.
    completionAge,
    topPending,
  };
}

/**
 * Render the console report. Pure — returns lines, prints nothing.
 * @returns {string[]}
 */
export function formatReport(entry) {
  const lines = [];
  const row = (label, value, note = '') =>
    lines.push(`   ${String(label).padEnd(30)}${value}${note ? `  ${note}` : ''}`);

  lines.push('');
  lines.push(`📊 Translation stats [${entry.label}]`);
  row('Total jobs:', entry.total);
  row('4 locale slots present:', formatCompleteRatio(entry.slotsPresent, entry.total));
  row('Missing/short slots:', entry.incomplete);
  row('Flagged needsRetranslation:', entry.needsRetranslation,
      `(${entry.flaggedAmongSlotsPresent} of them counted as "present" above — flagged is NOT translated)`);
  row('Verified translated:', formatCompleteRatio(entry.verifiedTranslated, entry.total),
      '= present minus flagged');
  // Denominator is presence-by-character-count, never `complete`: see the
  // finalizeEntry comment. `null` only ever comes from a pre-#6389 history row.
  row('4 slots by char count:', entry.slotsPresentByLength ?? 'not measured',
      '(pure presence — no language judgment)');
  row('Language-verified:',
      entry.languageVerified == null
        ? 'not measured'
        : formatCompleteRatio(entry.languageVerified, entry.slotsPresentByLength ?? entry.total),
      '= of those, the ones that read in their own locale (observational)');
  row('Source-copy titles excused:', entry.sourceCopyExcused,
      '(byte-copy of the source title, waved through by the "others differ" rule)');
  row('Suppressed (gave up):', entry.suppressed);
  const bl = entry.missingByLocale;
  row('Missing by locale:', `IT=${bl.it} EN=${bl.en} DE=${bl.de} FR=${bl.fr}`);

  // Queue AGE. Printed unconditionally, including the `n/a` case, so a run that
  // stopped producing the metric is visible in the log instead of looking like
  // a run with an empty queue.
  const qa = entry.queueAge;
  if (qa) {
    row('Queue age (oldest):', `${qa.oldestAgeDays ?? 'n/a'}d`,
        `(p50 ${qa.p50AgeDays ?? 'n/a'}d · p90 ${qa.p90AgeDays ?? 'n/a'}d · dated ${qa.withTimestamp}/${qa.count} · from first-seen, upper bound)`);
    row('Queue age buckets:', Object.entries(qa.buckets).map(([k, v]) => `${k}=${v}`).join(' '),
        '(0-1d/1-2d/2-7d subdivide 0-7d — they are not additional to it)');
    if (qa.alert) {
      lines.push(`   ⚠️ QUEUE AGE ALERT — oldest queued job is ${qa.oldestAgeDays}d, at or past the ${qa.alertDays}d ratchet:`);
      lines.push('      the count can still be falling while the tail is never served. Check the oldest-first');
      lines.push('      reserve (RESERVE_FOR_OLDEST in scripts/lib/job-traffic-priority.mjs) and the cascade cap.');
    }
  }

  // Age AT COMPLETION (#17). Printed unconditionally, `not measured` included,
  // so a run that lost its before/after cohort is visible instead of passing
  // for a run that completed nothing.
  const ca = entry.completionAge;
  if (ca == null) {
    row('Age at completion (p50):', 'not measured',
        '(no `before` cohort for this run — needs both passes)');
  } else if (ca.count === 0) {
    row('Age at completion (p50):', 'n/a', '(this run completed no job)');
  } else {
    row('Age at completion (p50):', `${ca.p50AgeDays ?? 'n/a'}d`,
        `(p90 ${ca.p90AgeDays ?? 'n/a'}d · ${ca.count} jobs completed this run · under 24h: ${ca.buckets['0-1d']})`);
  }

  // COMPLETE is reserved for the exact case: nothing missing and nothing
  // flagged. Anything else says so in words, not just in a percentage.
  if (entry.incomplete === 0 && entry.needsRetranslation === 0) {
    lines.push('   Verdict: COMPLETE — every job has 4 populated locale slots and none is flagged.');
  } else {
    lines.push(`   Verdict: NOT COMPLETE — ${entry.incomplete} jobs with a missing/short slot, ` +
               `${entry.needsRetranslation} flagged for retranslation.`);
  }

  if (entry.topPending.length > 0) {
    lines.push('   Top pending companies:');
    for (const { company, pending } of entry.topPending.slice(0, 5)) {
      lines.push(`     ${String(pending).padStart(4)} — ${company}`);
    }
  }
  return lines;
}

/**
 * Read the cohort the `before` pass left behind, or `null` when there is none.
 *
 * Fail-open on purpose: a missing, empty or malformed sidecar degrades the run
 * to "age at completion not measured" and is reported as such. It must never
 * fail the translation run, which has real work to commit either way.
 *
 * @returns {Set<string>|null}
 */
function readCohort() {
  const raw = readJson(COHORT_FILE);
  // An EMPTY cohort is a cohort: the `before` pass ran and found nothing
  // incomplete. Collapsing it onto `null` would make the `after` pass report
  // "not measured" for a run that measured perfectly and found zero — the same
  // null/zero conflation that `completedSamples: null` exists to prevent,
  // reopened by the reader. `null` is reserved for a sidecar that is absent or
  // malformed, which is the only case where nothing was measured.
  if (!Array.isArray(raw)) return null;
  return new Set(raw);
}

function main() {
  const label = process.argv[2] || 'translate-pending';
  // The two passes of one translate-pending run, and the only two labels the
  // live workflow uses. Any other label (a manual run, a one-off audit) is a
  // snapshot with no partner pass, so it neither writes nor reads the cohort.
  const isBefore = label === 'before';
  const isAfter = label === 'after';
  const previouslyIncomplete = isAfter ? readCohort() : null;

  const files = listSliceFileNames(CRAWLERS_DIR);

  const counters = emptyCounters();
  const topCompanies = [];

  for (const file of files) {
    const content = readJson(path.join(CRAWLERS_DIR, file));
    if (!content) continue;
    const jobs = Array.isArray(content) ? content : (content.jobs || []);
    const sliceCounters = summarizeJobs(jobs, {
      collectIncompleteIds: isBefore,
      previouslyIncomplete,
    });
    mergeCounters(counters, sliceCounters);
    if (sliceCounters.incomplete > 0) {
      const company = jobs[0]?.company || file.replace('.json', '');
      topCompanies.push({ company, pending: sliceCounters.incomplete });
    }
  }

  topCompanies.sort((a, b) => b.pending - a.pending);

  const entry = finalizeEntry(counters, { label, topPending: topCompanies.slice(0, 10) });

  for (const line of formatReport(entry)) console.log(line);

  const history = readJson(STATS_FILE) || [];
  history.push(entry);
  // Keep last 200 entries
  if (history.length > 200) history.splice(0, history.length - 200);
  fs.writeFileSync(STATS_FILE, JSON.stringify(history, null, 2) + '\n', 'utf-8');
  console.log(`   Saved to ${STATS_FILE} (${history.length} entries total)\n`);

  // Hand the incomplete cohort to the `after` pass of this same run. Written
  // LAST so a failure here cannot cost the history entry, and swallowed for the
  // same reason: losing the sidecar costs one metric, not the run.
  if (isBefore) {
    try {
      fs.writeFileSync(COHORT_FILE, JSON.stringify(counters.incompleteIds), 'utf-8');
      console.log(`   Cohort for age-at-completion: ${counters.incompleteIds.length} incomplete jobs → ${COHORT_FILE}\n`);
    } catch (err) {
      console.warn(`   ⚠️ Could not write ${COHORT_FILE}: ${err.message} — age at completion will read "not measured".\n`);
    }
  }
}

// Main-guarded so the pure helpers above can be imported by tests (and by
// nothing else) without appending to the history file. NOTE (#5593 item1):
// since `isIncomplete` now delegates to relocalize-pending-jobs.mjs, IMPORTING
// this module transitively loads that file's dependency graph — which reads
// a couple of small data/ files at module-eval time (same tradeoff
// scripts/local-mt-mopup.mjs already accepted for the same import). That
// happens regardless of this guard, because it happens at import time, before
// this line ever runs. See CLAUDE.md's sparse-worktree notes: this makes
// tests that import this module red in a sparse worktree missing data/,
// green in CI and in any full checkout — not a regression introduced here.
const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();
