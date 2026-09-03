#!/usr/bin/env node
/**
 * mark-mistranslated-jobs.mjs
 *
 * Flags jobs whose localized text is in the WRONG LANGUAGE with
 * `needsRetranslation = true`, so `translate-pending.yml` re-generates them.
 *
 * Two independent detectors:
 *   - DESCRIPTIONS (original behaviour): `descriptionByLocale[locale]` whose
 *     `detectLanguageWithConfidence` verdict differs from the slot at >= 0.65
 *     confidence, minimum 120 characters.
 *   - TITLES (2026-08-10): `titleByLocale[locale]` flagged by
 *     `titleLooksUntranslated()` (scripts/lib/job-locale-utils.mjs).
 *
 * WHY TITLES NEEDED A SEPARATE DETECTOR. This script read `descriptionByLocale`
 * only, and skipped anything under 120 characters — which excludes every title
 * by construction (median 46 chars). It was therefore the layer the crawler
 * deferred wrong-language titles to ("the translate pipeline handles real
 * contamination cases") while structurally unable to see them. The statistical
 * detector used for descriptions cannot be reused: measured on 300 live titles
 * it false-alarms on 32.7% of correct Italian and misses 55.0% of broken ones,
 * because titles are too short for trigram profiles. `titleLooksUntranslated()`
 * is exact-lexical instead — no threshold, no confidence.
 *
 * IDEMPOTENCE — this is the part that has bitten this repo before, so it is
 * enforced in four independent ways:
 *   1. `needsRetranslation` jobs are skipped: a job already in the queue is
 *      never re-marked, so a run over an unchanged dataset marks 0.
 *   2. `localeMismatchSuppressed` jobs are skipped. relocalize-pending-jobs.mjs
 *      sets that flag after repeated failed retranslation runs (proper-noun-
 *      heavy titles the engines cannot satisfy); re-flagging them is exactly
 *      what "kept the backlog looping forever" — the same guard
 *      mark-locale-mismatched-jobs.mjs and assemble-jobs-dataset.mjs apply.
 *   3. A hard per-run cap (`--max-marks`, env `TITLE_MISTRANSLATION_MARK_CAP`)
 *      plus a queue ceiling (`TITLE_MISTRANSLATION_QUEUE_CEILING`) — see
 *      THROUGHPUT below.
 *   4. Slices are only rewritten when a value actually changed, and no flag is
 *      ever cleared — the marking is monotone, so it converges instead of
 *      oscillating.
 *
 * Because (1)+(2) shrink the candidate set on every pass and nothing here ever
 * un-marks a job, repeated runs are strictly decreasing. The failure mode this
 * avoids is the one recorded at scripts/lib/shared-jobs-crawler.mjs:1826
 * (`ensureLocaleFields`, `_preTitleByLocale` snapshot): re-running a
 * wrong-language heuristic over titles a pass left untouched re-flagged
 * **76%/51% of already-translated jobs on every run** (EOC/migros). At the
 * volume the fixed title detector reports (13,250 of 26,605 jobs, 2026-08-10)
 * that mistake would flag half the dataset five times a day.
 *
 * THROUGHPUT — the cap is sized to the drain, not to the backlog.
 * `needsRetranslation` is drained by two different steps of
 * translate-pending.yml:
 *   - Phase 2a/2c, `local-mt-mopup.mjs` — free, unlimited, 6000 jobs/run. Its
 *     `missingSlots()` rebuilds a title slot that is MISSING, under 3
 *     characters, an exact lowercase copy of the source title, OR flagged by
 *     `titleLooksUntranslated()` with the SAME arguments `titleOffence()`
 *     below passes it (2026-08-24, issue #6354) — so a partially translated
 *     title ("Apprendistato 2027 come Fachfrau / Fachmann Gesundheit CFC") now
 *     reaches the free path too, across every family this file's title
 *     detector can mark (binnen-i, compound-residue, source-function-word,
 *     source-orthography, source-overlap, source-copy).
 *   - Phase 2b, `relocalize-pending-jobs.mjs` — the AI cascade. It remains the
 *     only step that repairs mistranslated DESCRIPTIONS, and it is
 *     quota-bound:
 *     `--max-jobs` defaults to 100/run in translate-pending.yml, and the
 *     workflow's own notes record the premium tiers as chronically exhausted.
 * So the ceiling on real DESCRIPTION repair is ~100 jobs/run (titles now drain
 * through the free, unlimited tier instead — see above). `DEFAULT_MARK_CAP`
 * still matches the cascade number rather than the backlog: marking
 * descriptions faster than the cascade drains would build a queue that only
 * ever grows, which is worse than no queue (it also starves the
 * genuinely-incomplete jobs competing for the same 100 slots — flagged jobs
 * sort FIRST in that queue). Raising the shared cap specifically for titles is
 * a separate throughput change, not made here.
 * `DEFAULT_QUEUE_CEILING` is the backpressure: when the existing
 * `needsRetranslation` backlog is already at the ceiling, this script marks
 * NOTHING and says so, so a stalled cascade (quota exhausted for days) cannot
 * be compounded by five more marking runs a day. Raise either env var for a
 * deliberate owner-driven backfill.
 *
 * Usage:
 *   node scripts/mark-mistranslated-jobs.mjs [--dry-run] [--no-titles]
 *                                            [--no-descriptions] [--max-marks N]
 *                                            [--queue-ceiling N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { titleLooksUntranslated, DEFAULT_JOB_LOCALES } from './lib/job-locale-utils.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { applyMarks, persistMarksToSlices } from './lib/job-mark-persistence.mjs';

// Re-exported: `applyMarks` moved to lib/ so the descriptions marker shares one
// write path with this one (see that module's header for why). Kept on this
// module's surface because callers and tests already import it from here.
export { applyMarks };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOCALES = DEFAULT_JOB_LOCALES;

/** Matches translate-pending.yml's `max_jobs` default for the AI cascade — the
 *  only step that can repair a partially-translated title. See THROUGHPUT. */
export const DEFAULT_MARK_CAP = 100;
/** Stop marking entirely once this many jobs already await retranslation. */
export const DEFAULT_QUEUE_CEILING = 2000;
const MIN_DESCRIPTION_CHARS = 120;
const DESCRIPTION_CONFIDENCE = 0.65;

/**
 * A job is out of scope when it is already queued or has been given up on.
 * Exported so the wiring test can assert both guards without re-deriving them.
 */
export function isAlreadyQueued(job) {
  return Boolean(job?.needsRetranslation) || Boolean(job?.localeMismatchSuppressed);
}

/**
 * Wrong-language description slot? (unchanged semantics)
 *
 * Exported since #6389 so `scripts/log-translation-stats.mjs` can REPORT the
 * same verdict this file ACTS on. It is deliberately the same function and not
 * a second copy: the one lesson this area has already paid for (see that file's
 * "One `isIncomplete()`, not two" header) is that a duplicated predicate drifts
 * and then the marker and the reporter disagree about the same job.
 */
export function descriptionOffence(job) {
  for (const locale of LOCALES) {
    const desc = String(job.descriptionByLocale?.[locale] || '').trim();
    if (desc.length < MIN_DESCRIPTION_CHARS) continue;
    const detected = detectLanguageWithConfidence(desc, locale);
    if (detected.confidence >= DESCRIPTION_CONFIDENCE && detected.lang !== locale && LOCALES.includes(detected.lang)) {
      return { locale, detail: `description ${locale} => ${detected.lang} (${detected.confidence.toFixed(2)})` };
    }
  }
  return null;
}

/** Wrong-language title slot? Exported for the same reason as
 *  `descriptionOffence` above — one implementation, two readers. */
export function titleOffence(job) {
  const sourceLang = String(job.sourceLang || 'it').toLowerCase();
  const titles = job.titleByLocale && typeof job.titleByLocale === 'object' ? job.titleByLocale : {};
  const sourceTitle = String(titles[sourceLang] || job.title || '');
  for (const locale of LOCALES) {
    if (locale === sourceLang) continue;
    const title = String(titles[locale] || '').trim();
    if (!title) continue; // empty slot = a completeness defect, handled elsewhere
    const verdict = titleLooksUntranslated({
      title,
      sourceTitle,
      sourceLang,
      targetLocale: locale,
      company: job.company || '',
      location: job.location || '',
    });
    if (verdict.untranslated) {
      return { locale, detail: `title ${locale} => ${verdict.reason} (${verdict.evidence})` };
    }
  }
  return null;
}

/**
 * Select which jobs to mark. Pure: takes an array, returns slugs + diagnostics,
 * mutates nothing. Deterministic given the same input order, so a dry-run and
 * the real run agree.
 *
 * @param {Array<object>} jobs
 * @param {object} [options]
 * @param {number}  [options.cap=DEFAULT_MARK_CAP]  max jobs marked this run (0 = unlimited)
 * @param {number}  [options.queueCeiling=DEFAULT_QUEUE_CEILING]  backpressure (0 = off)
 * @param {boolean} [options.titles=true]
 * @param {boolean} [options.descriptions=true]
 * @returns {{slugs: Set<string>, hits: Array<{slug: string, detail: string}>,
 *            titleHits: number, descriptionHits: number, eligible: number,
 *            remaining: number, capped: boolean, throttled: boolean,
 *            queueDepth: number}}
 */
export function selectMistranslatedJobs(
  jobs,
  { cap = DEFAULT_MARK_CAP, queueCeiling = DEFAULT_QUEUE_CEILING, titles = true, descriptions = true } = {}
) {
  const list = Array.isArray(jobs) ? jobs : [];
  const slugs = new Set();
  const hits = [];
  let titleHits = 0;
  let descriptionHits = 0;
  let eligible = 0;
  let matched = 0;

  // Backpressure: the AI cascade is the only step that can repair a partially
  // translated title and it moves ~100 jobs/run. If its queue is already at the
  // ceiling it is not keeping up (quota exhaustion is routine here), and adding
  // more would grow a queue that is not draining. Measured before anything is
  // scanned so the check is cheap and the log is honest.
  const queueDepth = list.filter((job) => job && job.needsRetranslation).length;
  if (queueCeiling > 0 && queueDepth >= queueCeiling) {
    return {
      slugs, hits, titleHits, descriptionHits,
      eligible: 0, remaining: 0, capped: false, throttled: true, queueDepth,
    };
  }

  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    // Guards 1 + 2 — see the IDEMPOTENCE block in the module header.
    if (isAlreadyQueued(job)) continue;
    eligible += 1;
    const slug = String(job.slug || '').trim();
    if (!slug) continue;

    // Titles first: the lexical title check is ~5x cheaper than the trigram
    // pass over four full descriptions, and it is the detector that actually
    // fires (measured 2026-08-10 on 26,605 jobs: 13,250 title-flagged vs 60
    // description-flagged), so short-circuiting on it skips most of the cost.
    const offence = (titles ? titleOffence(job) : null) || (descriptions ? descriptionOffence(job) : null);
    if (!offence) continue;
    matched += 1;
    // Guard 3 — the cap bounds what we MARK, but `matched` keeps counting so the
    // log can report the true remaining backlog instead of a truncated one.
    if (cap > 0 && slugs.size >= cap) continue;
    if (slugs.has(slug)) continue;
    slugs.add(slug);
    hits.push({ slug, detail: offence.detail });
    if (offence.detail.startsWith('title ')) titleHits += 1;
    else descriptionHits += 1;
  }

  return {
    slugs,
    hits,
    titleHits,
    descriptionHits,
    eligible,
    remaining: Math.max(0, matched - slugs.size),
    capped: cap > 0 && matched > slugs.size,
    throttled: false,
    queueDepth,
  };
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    titles: !argv.includes('--no-titles'),
    descriptions: !argv.includes('--no-descriptions'),
    cap: num(get('--max-marks') ?? process.env.TITLE_MISTRANSLATION_MARK_CAP, DEFAULT_MARK_CAP),
    queueCeiling: num(
      get('--queue-ceiling') ?? process.env.TITLE_MISTRANSLATION_QUEUE_CEILING,
      DEFAULT_QUEUE_CEILING
    ),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jobsPath = path.join(ROOT, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) {
    console.log('data/jobs.json not found — run scripts/assemble-jobs-dataset.mjs first. Nothing to do.');
    return;
  }
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));

  const selection = selectMistranslatedJobs(jobs, opts);
  if (selection.throttled) {
    console.log(
      `⏸️  Backpressure: ${selection.queueDepth} jobs already await retranslation (ceiling ${opts.queueCeiling}).`
        + ' The AI cascade is not draining fast enough — marking nothing this run.'
        + ' Raise TITLE_MISTRANSLATION_QUEUE_CEILING for a deliberate backfill.'
    );
    return;
  }
  console.log(
    `Offending jobs: ${selection.slugs.size} (titles ${selection.titleHits}, descriptions ${selection.descriptionHits})`
      + ` of ${selection.eligible} eligible; queue depth ${selection.queueDepth}`
  );
  if (selection.capped) {
    console.log(
      `⚠️  Per-run cap ${opts.cap} reached — ${selection.remaining} more eligible jobs left for the next run.`
        + ' Raise TITLE_MISTRANSLATION_MARK_CAP for a deliberate backfill.'
    );
  }
  for (const hit of selection.hits.slice(0, 15)) console.log(`  ${hit.slug}: ${hit.detail}`);

  // Write BOTH the assembled dataset and the per-crawler slices:
  //  - jobs.json so the translate steps LATER IN THE SAME RUN see the flags
  //    (relocalize-pending-jobs.mjs reads data/jobs.json, not the slices);
  //  - the slices because only those are committed — a flag written to
  //    jobs.json alone evaporates when the build artifact is regenerated.
  let assembledMarked = 0;
  if (selection.slugs.size > 0) {
    assembledMarked = applyMarks(jobs, selection.slugs);
    if (!opts.dryRun && assembledMarked > 0) writeJsonAtomic(jobsPath, jobs);
  }

  const { totalMarked, slicesChanged } = persistMarksToSlices(selection.slugs, {
    root: ROOT,
    dryRun: opts.dryRun,
  });

  console.log(
    `${opts.dryRun ? '[dry-run] would mark' : 'Marked'} ${totalMarked} jobs across ${slicesChanged} slices`
      + ` (+${assembledMarked} in data/jobs.json)`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();