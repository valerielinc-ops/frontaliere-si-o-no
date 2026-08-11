/**
 * job-locale-consistency — rate-based ratchets on wrong-language job content.
 *
 * Both assertions ratchet on a RATE, never on an absolute count. An absolute
 * threshold flickers in this repo as the dataset grows: the same defect density
 * crosses a fixed count purely because more jobs were crawled, so the gate goes
 * red for a reason nobody caused and gets raised instead of fixed. A rate moves
 * only when the *quality* moves.
 *
 * HISTORY. The description assertion was `it.skip(...)` from 2026-05-19 to
 * 2026-08-10 with a TODO describing this exact bug class ("translator pipeline
 * marked them translated without translating"), and it only ever inspected
 * descriptions — so the wrong-language TITLE defect that shipped German `<h1>`
 * on Italian pages had no gate at all. Un-skipped here, converted to a rate,
 * and extended to titles via `titleLooksUntranslated()`.
 *
 * BOTH BASELINES NAME THEIR POPULATION, and that is load-bearing. This file
 * reads the ASSEMBLED `data/jobs.json` (DATA_JOBS_PATH), the artefact CI builds
 * with `scripts/assemble-jobs-dataset.mjs` before vitest. The first calibration
 * of both ratchets was taken instead on the committed `data/jobs/by-crawler/*.json`
 * SLICES — a different, larger, more diluted set. Descriptions read 0.058% there
 * against 0.194% here, titles 30.14% against 32.55%. One gate went red on the
 * first dataset refresh after being switched on and the other was passing on
 * 0.45pp of accidental margin. Re-measure on the assembled artefact, never on
 * the slices, and say so in the comment when you do.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';
import { titleLooksUntranslated } from '../scripts/lib/job-locale-utils.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');

interface Job {
  company?: string;
  slug?: string;
  title?: string;
  location?: string;
  sourceLang?: string;
  needsRetranslation?: boolean;
  localeMismatchSuppressed?: boolean;
  titleByLocale?: Record<string, string>;
  descriptionByLocale?: Record<string, string>;
}

// data/jobs.json is a gitignored build artefact: CI assembles it before vitest
// (.github/workflows/tests.yml "Assemble data/jobs.json"), but a sparse worktree
// does not have it and must not go red for that. Load defensively and skip with
// a loud message instead of throwing at describe-evaluation time, which is what
// the previous version did.
function loadJobs(): Job[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

describe('job-locale-consistency', () => {
  const jobs = loadJobs();
  const hasDataset = jobs !== null;
  if (!hasDataset) {
    console.warn(
      '[job-locale-consistency] data/jobs.json absent — ratchets skipped. '
        + 'Run `node scripts/assemble-jobs-dataset.mjs` to exercise them locally.'
    );
  }

  /**
   * DESCRIPTIONS — wrong-language text in a `descriptionByLocale` slot.
   *
   * MEASURED BASELINE 2026-08-11: **73 of 37,722** eligible description slots =
   * **0.194%**, on 22,781 active jobs.
   *
   * POPULATION — read this before touching the constant. The measurement above
   * was taken on `data/jobs.json` AS ASSEMBLED BY `scripts/assemble-jobs-dataset.mjs`,
   * because that is the artefact this test reads (DATA_JOBS_PATH) and the one
   * CI builds before vitest. It is NOT the committed `data/jobs/by-crawler/*.json`
   * slices.
   *
   * That distinction is the whole reason this comment exists. The first version
   * of this gate carried `0.15% — measured 0.058% on 2026-08-10`, and that
   * 0.058% (60 / 104,139 slots) came from the SLICES. The assembled dataset is
   * 36% of that slot count and holds MORE mismatches in absolute terms (73 vs
   * 60): the slices dilute the defect with jobs that never reach the assembled
   * artefact, so the slice figure understated the gated population by 3.3x and
   * the gate went red on the first dataset refresh after it was switched on.
   * A baseline that does not name its population is not a baseline.
   *
   * HEADROOM — 0.30%, i.e. 0.106pp above the measurement:
   *   · counting noise: 73 events, sigma = sqrt(73) = 8.5 events = 0.023pp on
   *     this denominator, so the margin is ~4.7 sigma;
   *   · composition drift: two consecutive CI runs an hour apart measured
   *     <=0.150% and then 0.194% (>=0.044pp of swing) purely because the branch
   *     merged a refreshed `publisher-submitted.json` slice. The margin is
   *     ~2.4x that observed swing.
   * This is deliberately TIGHTER than the "~2.5x headroom" rule the original
   * comment used, which on the corrected measurement would give 0.49%: the
   * noise model supports a tighter gate than a blanket multiplier does.
   *
   * REPRODUCE (both ratchets, on the population they actually gate):
   *   node scripts/assemble-jobs-dataset.mjs --stats
   *   npx vitest run tests/job-locale-consistency.test.ts
   * The measured rate is printed on PASS as well as on failure — see the
   * `console.log` below. That is what makes the next recalibration possible
   * without re-deriving it from a red run.
   *
   * Repairing the 73 offenders is NOT this gate's job: `mark-mistranslated-jobs.mjs`
   * only queues them for the production translate-pending cascade. Lower this
   * constant as that backlog drains; it can only ever be tightened.
   */
  it.skipIf(!hasDataset)(
    'localized descriptions are not stored under the wrong locale',
    { timeout: 180000 },
    () => {
      // 0.30% — measured 0.194% on the ASSEMBLED data/jobs.json, 2026-08-11.
      const MAX_RATE = 0.003;
      const mismatches: string[] = [];
      let slots = 0;

      for (const job of jobs!) {
        // Jobs awaiting translation are expected to hold source-language
        // fallbacks until translate-pending processes them.
        if (job.needsRetranslation) continue;

        for (const locale of LOCALES) {
          const description = String(job.descriptionByLocale?.[locale] || '').trim();
          if (description.length < 120) continue;
          slots += 1;

          const detected = detectLanguageWithConfidence(description, locale);
          if (detected.confidence >= 0.65 && detected.lang !== locale) {
            mismatches.push(
              `${job.company || '?'}/${job.slug || '?'} [${locale}] => ${detected.lang} (${detected.confidence.toFixed(2)})`
            );
          }
        }
      }

      const rate = slots > 0 ? mismatches.length / slots : 0;
      // Printed on PASS too, on purpose. The defect this gate was born with was
      // a baseline nobody could re-derive without making the gate red first.
      console.log(
        `[ratchet] descriptions-wrong-locale ${mismatches.length}/${slots} = `
          + `${(rate * 100).toFixed(3)}% (max ${(MAX_RATE * 100).toFixed(3)}%) `
          + 'population=assembled data/jobs.json'
      );
      expect(
        rate,
        `Descriptions stored under the wrong locale: ${mismatches.length}/${slots} = `
          + `${(rate * 100).toFixed(3)}% (max ${(MAX_RATE * 100).toFixed(3)}%)\n`
          + `${mismatches.slice(0, 20).join('\n')}`
      ).toBeLessThanOrEqual(MAX_RATE);
    }
  );

  /**
   * TITLES — a non-source `titleByLocale` slot that still reads as another
   * language once the employer/location names are stripped.
   *
   * MEASURED BASELINE 2026-08-11: **22,236 of 68,306** non-source title slots =
   * **32.55%**, on 22,781 active jobs (per target locale it 38.55%, en 34.48%,
   * fr 27.81%, de 21.43%; per source language de 37.37%, en 23.15%, it 20.46%,
   * fr 14.42%).
   *
   * POPULATION — same correction as the descriptions ratchet above, and it was
   * NOT cosmetic here either. The first version of this gate carried
   * `33.00% — measured 30.14%`, taken on 26,605 jobs / 79,796 slots read from
   * the committed `data/jobs/by-crawler/*.json` SLICES. This test reads the
   * ASSEMBLED `data/jobs.json`, where the same measurement is **32.55%** — the
   * slices understated it by 2.41pp. The old constant therefore shipped with
   * 0.45pp of real headroom (1.4% relative) while its comment claimed 2.86pp,
   * and it passed CI by luck, not by margin. Its sibling above, calibrated the
   * same way, went red on the first dataset refresh.
   *
   * DETECTOR CONTEXT — unchanged and still true: the baseline is taken with
   * `titleLooksUntranslated()` as shipped by PR #5570, so it already reflects
   * the fixed detector. This ratchet deliberately does NOT exclude
   * `needsRetranslation` jobs from either side of the ratio (the site serves
   * them regardless), so merge order cannot move the number on its own.
   *
   * A "meaningful" threshold — anywhere near the ~3% one would want — would be
   * red on day one for a defect that predates this test by months, which is a
   * broken gate, not a gate. So this LOCKS IN THE STATUS QUO at 35.50%, i.e.
   * 2.95pp over the measurement:
   *   · counting noise is the SMALL term — sigma on the count is
   *     sqrt(68306 * 0.3255 * 0.6745) = 122 slots = 0.18pp, so 3 sigma is
   *     0.54pp;
   *   · composition drift is the binding one — moving from the slices to the
   *     assembled artefact alone shifted this by 2.41pp, and the crawl mix
   *     changes daily.
   * 2.41 + 0.54 = 2.95pp. The margin is sized to measured movement, not to a
   * round number, and can only ever be tightened.
   *
   * Tightening is tracked work, not a TODO to forget: the alert threshold in
   * `.github/workflows/job-title-locale-audit.yml` is 20%, and every weekly run
   * publishes the current rate into the tracking issue. Lower this constant as
   * the repair path (`scripts/mark-mistranslated-jobs.mjs` in
   * translate-pending.yml) drains the backlog.
   *
   * NOTE for whoever tightens it: part of the 32.55% is DETECTOR noise, not
   * broken pages — the audit's `topEvidence` table isolates it (e.g. the German
   * article `des` firing on correct French titles). Fix the lexicon in
   * `scripts/lib/job-locale-utils.mjs` first, re-measure ON THE ASSEMBLED
   * ARTEFACT, then lower this.
   */
  it.skipIf(!hasDataset)(
    'non-source job titles are not left in the source language',
    { timeout: 180000 },
    () => {
      // 35.50% — measured 32.55% on the ASSEMBLED data/jobs.json, 2026-08-11.
      const MAX_RATE = 0.355;
      const offenders: string[] = [];
      let slots = 0;
      let flagged = 0;

      for (const job of jobs!) {
        const sourceLang = String(job.sourceLang || 'it').toLowerCase();
        const titles = job.titleByLocale || {};
        const sourceTitle = String(titles[sourceLang] || job.title || '');

        for (const locale of LOCALES) {
          if (locale === sourceLang) continue;
          const title = String(titles[locale] || '').trim();
          if (!title) continue; // empty slot: a completeness defect, gated elsewhere
          slots += 1;

          const verdict = titleLooksUntranslated({
            title,
            sourceTitle,
            sourceLang,
            targetLocale: locale,
            company: job.company || '',
            location: job.location || '',
          });
          if (!verdict.untranslated) continue;
          flagged += 1;
          if (offenders.length < 20) {
            offenders.push(`${job.company || '?'}/${job.slug || '?'} [${locale}] ${verdict.reason} (${verdict.evidence}): ${title}`);
          }
        }
      }

      const rate = slots > 0 ? flagged / slots : 0;
      // See the sibling assertion: printed on PASS too, so the next person to
      // tighten this has the current number without needing a red run.
      console.log(
        `[ratchet] titles-wrong-locale ${flagged}/${slots} = `
          + `${(rate * 100).toFixed(2)}% (max ${(MAX_RATE * 100).toFixed(2)}%) `
          + 'population=assembled data/jobs.json'
      );
      expect(
        rate,
        `Non-source titles still in a foreign language: ${flagged}/${slots} = `
          + `${(rate * 100).toFixed(2)}% (max ${(MAX_RATE * 100).toFixed(2)}%)\n`
          + 'Repair: node scripts/mark-mistranslated-jobs.mjs --dry-run\n'
          + 'Detail: npm run audit:job-title-locale\n'
          + `${offenders.join('\n')}`
      ).toBeLessThanOrEqual(MAX_RATE);
    }
  );
});
