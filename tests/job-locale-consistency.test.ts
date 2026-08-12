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
 * on Italian pages had no gate at all. Un-skipped, converted to a rate, and
 * extended to titles via `titleLooksUntranslated()`.
 *
 * THE POPULATION IS NOW PINNED IN CODE, not in this comment — see
 * `scripts/lib/job-locale-population.mjs`. The previous version of this file
 * opened with "A baseline that does not name its population is not a baseline",
 * named its population in prose, and then went red anyway on 2026-08-11 for
 * exactly the reason it had described: nothing could CHECK the prose.
 *
 * What went wrong, measured on the assembled artefact at two states of `main`
 * ninety minutes apart, across the daily dedicated-crawler wave:
 *
 *   needsRetranslation (the pipeline queue)   7,126  →  14,041   (+97%)
 *   description slots, !needsRetranslation   62,944  →  34,594   (-45%)
 *   description slots, ALL                   91,297  →  90,528   (-0.8%)
 *   non-source title slots                   68,587  →  67,987   (-0.9%)
 *
 * The descriptions ratchet had defined its population as the complement of
 * `needsRetranslation` — a PIPELINE QUEUE that sawtooths several times a day as
 * crawlers re-flag and translate-pending drains. Its denominator therefore
 * halved at constant corpus quality, the rate doubled, and the gate reported a
 * quality alarm for a population change. Three CI runs the same morning
 * measured 0.064%, 0.325% and 0.317% on three different sets, and the committed
 * baseline (0.194%) belonged to a fourth.
 *
 * So the two populations are queue-free by construction and their SIZE is now
 * asserted, with its own message. Two defects, two errors:
 *   · `[population-changed]`   — the set moved; the rate is not comparable and
 *                                the baseline must be re-derived.
 *   · `[quality-regression]`   — the set held; the defect density really rose.
 * Both are exercised from synthetic fixtures in
 * `tests/job-locale-population-guard.test.ts`, which needs no dataset.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';
import { titleLooksUntranslated } from '../scripts/lib/job-locale-utils.mjs';
import {
  DESCRIPTION_POPULATION,
  MIN_SERVED_SHARE,
  TITLE_POPULATION,
  assertPopulationUnchanged,
  measureDescriptionLocales,
  measureTitleLocales,
} from '../scripts/lib/job-locale-population.mjs';

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
// an earlier version did.
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
   * DESCRIPTIONS — wrong-language text in a `descriptionByLocale` slot the site
   * serves as a FINISHED translation.
   *
   * MEASURED BASELINE 2026-08-11, on the assembled artefact at both ends of the
   * crawl wave that broke the old gate:
   *   · main @09:52 UTC (0356b30b):  40 / 91,297 slots = 0.044%, 68.9% served
   *   · main @10:59 UTC (efd6faf8): 100 / 90,528 slots = 0.110%, 38.2% served
   * Same cap, two states that previously read 0.064% and 0.325% — the 5x swing
   * was the denominator, not the corpus.
   *
   * POPULATION and DEFECT are deliberately NOT the same set, and that is the
   * fix. The denominator is every description slot in the corpus, queue or no
   * queue, because the corpus is stable (-0.8% across the wave). The numerator
   * counts only slots that are NOT queued for retranslation, because a queued
   * slot is expected to hold a source-language fallback until translate-pending
   * processes it — that is pending work, not shipped harm. The queue therefore
   * enters the measurement exactly once, in the only direction where it is
   * meaningful, and can no longer move the normalizer.
   *
   * The rejected alternative, for whoever revisits this: counting queued slots
   * as defects too makes the population identical to the denominator, but the
   * rate then tracks QUEUE DEPTH (0.055% → 1.034% across the same wave, 19x)
   * and the gate goes red every time a crawl lands fresh untranslated jobs.
   * That is a gate that punishes normal operation.
   *
   * HEADROOM — 0.30%, i.e. 0.19pp above the worse of the two measurements:
   *   · counting noise: 100 events, sigma = 10 events = 0.011pp on this
   *     denominator, so the margin is ~17 sigma;
   *   · the binding term is real quality movement — the served defect count
   *     went 40 → 100 in ninety minutes. 0.30% is 272 slots on this population,
   *     i.e. ~2.7x the current count.
   * It can only ever be tightened. Do NOT raise it to absorb a population
   * change: `assertPopulationUnchanged` below exists so that failure arrives
   * under its own name.
   *
   * REPRODUCE (both ratchets, on the population they actually gate):
   *   node scripts/assemble-jobs-dataset.mjs --stats
   *   npx vitest run tests/job-locale-consistency.test.ts
   * The rate, the population size and the served share are printed on PASS as
   * well as on failure. That is what makes the next recalibration possible
   * without needing a red run first.
   *
   * Repairing the offenders is NOT this gate's job: `mark-mistranslated-jobs.mjs`
   * only queues them for the production translate-pending cascade.
   */
  it.skipIf(!hasDataset)(
    'localized descriptions are not stored under the wrong locale',
    { timeout: 180000 },
    () => {
      // 0.30% — measured 0.110% on the ASSEMBLED data/jobs.json, 2026-08-11,
      // on DESCRIPTION_POPULATION (90,900 slots ±15%).
      const MAX_RATE = 0.003;

      const { slots, servedSlots, mismatches } = measureDescriptionLocales(
        jobs!,
        detectLanguageWithConfidence,
        LOCALES,
      );

      const rate = slots > 0 ? mismatches.length / slots : 0;
      const servedShare = slots > 0 ? servedSlots / slots : 0;
      // Printed on PASS too, on purpose. The defect this gate was born with was
      // a baseline nobody could re-derive without making the gate red first;
      // the defect it acquired next was a population nobody could see move.
      console.log(
        `[ratchet] ${DESCRIPTION_POPULATION.id} ${mismatches.length}/${slots} = `
          + `${(rate * 100).toFixed(3)}% (max ${(MAX_RATE * 100).toFixed(3)}%) `
          + `population=assembled data/jobs.json, expected ${DESCRIPTION_POPULATION.expectedSlots} `
          + `±${(DESCRIPTION_POPULATION.tolerance * 100).toFixed(0)}%, `
          + `served ${servedSlots}/${slots} = ${(servedShare * 100).toFixed(1)}% (min ${(MIN_SERVED_SHARE * 100).toFixed(0)}%)`
      );

      // 1. Is this the set the baseline was derived on? Distinct failure.
      assertPopulationUnchanged(DESCRIPTION_POPULATION, slots);

      // 2. Can this gate still see anything? Moving the denominator off the
      //    queue removes the instability but would let a corpus-wide queue
      //    drive the defect count to zero. Distinct failure.
      expect(
        servedShare,
        `[gate-blind] ${DESCRIPTION_POPULATION.id}: only ${servedSlots}/${slots} = `
          + `${(servedShare * 100).toFixed(1)}% of description slots are served as finished translations `
          + `(min ${(MIN_SERVED_SHARE * 100).toFixed(0)}%).\n`
          + 'This is NOT a quality regression either: the defect count below is measured on that shrinking '
          + 'served slice, so a green rate here would be vacuous.\n'
          + 'Cause: needsRetranslation has swallowed the corpus — the translate-pending cascade is not draining. '
          + 'Check .github/workflows/translate-pending.yml and the relocalize queue (RELOCALIZE_MAX_JOBS) '
          + 'before touching this test.'
      ).toBeGreaterThanOrEqual(MIN_SERVED_SHARE);

      // 3. Only now is the rate comparable with its baseline.
      expect(
        rate,
        `[quality-regression] Descriptions served under the wrong locale: ${mismatches.length}/${slots} = `
          + `${(rate * 100).toFixed(3)}% (max ${(MAX_RATE * 100).toFixed(3)}%)\n`
          + `Population held at ${slots} slots, so this IS a quality movement, not a denominator artefact.\n`
          + 'Repair: node scripts/mark-mistranslated-jobs.mjs --dry-run\n'
          + `${mismatches.slice(0, 20).join('\n')}`
      ).toBeLessThanOrEqual(MAX_RATE);
    }
  );

  /**
   * TITLES — a non-source `titleByLocale` slot that still reads as another
   * language once the employer/location names are stripped.
   *
   * MEASURED BASELINE 2026-08-11, on the assembled artefact:
   *   · main @09:52 UTC (0356b30b): 17,473 / 68,587 = 25.48%
   *   · main @10:59 UTC (efd6faf8): 19,843 / 67,987 = 29.19%
   * (CI the same day: 68,306 and 67,844 slots — a 1.1% spread over the day.)
   *
   * RE-MEASURED 2026-08-12 (issue #5653 item 3), same procedure, three points
   * across ~24h to bound composition drift instead of a single 90-minute pair:
   *   · main @2026-08-11 01:19 UTC (27735292): 22,220 / 68,488 = 32.44%
   *   · main @2026-08-11 23:41 UTC (3a73cb00): 20,247 / 68,046 = 29.75%
   *   · main @2026-08-12 01:37 UTC (abf514e9, HEAD here): 20,065 / 68,121 = 29.45%
   * Worst point over the window is 2.99pp above the current reading — smaller
   * than the 3.71pp/90min swing the original 35.50% cap was sized on, but this
   * window is 16x longer, so it is the more representative figure. The audit's
   * `topEvidence` leaderboard (checked by hand: `von`, `im`, `der`, `Metzger`,
   * the binnen-i families) was re-inspected for detector-lexicon false
   * positives of the "des"/"installateur"/"sous" kind and none were found —
   * every high-count marker traces to a genuinely partial machine translation
   * (source-language words left standing next to translated ones, e.g.
   * "Gestalten von Einkaufserlebnissen" inside an otherwise-Italian title).
   * The lexicon needed no further cleanup this round; only the cap moves.
   *
   * POPULATION — this ratchet was ALREADY queue-free, deliberately: it does not
   * exclude `needsRetranslation` from either side of the ratio, because the site
   * serves those titles regardless, so merge order cannot move the number on its
   * own. That choice is why its denominator survived the crawl wave that halved
   * its sibling's (-0.9% against -45%), and it is the choice the descriptions
   * ratchet above has now adopted.
   *
   * It still needed the SIZE guard, and that is the point of touching it here:
   * being stable today is not the same as being pinned. The identical failure
   * one dataset refresh later is exactly how the sibling died — and this gate's
   * own first calibration was taken on the SLICES (79,796 slots, +17% over this
   * population), which is the same swap. `assertPopulationUnchanged` now makes
   * that arrive as `[population-changed]` instead of as a 2.41pp quality shift
   * nobody can explain.
   *
   * DETECTOR CONTEXT — unchanged: the baseline is taken with
   * `titleLooksUntranslated()` as shipped by PR #5570, so it already reflects
   * the fixed detector.
   *
   * A "meaningful" threshold — anywhere near the ~3% one would want — would be
   * red on day one for a defect that predates this test by months, which is a
   * broken gate, not a gate. This LOCKED IN THE STATUS QUO at 35.50% on
   * 2026-08-11 and is now TIGHTENED to 33.00% on 2026-08-12 (issue #5653 item
   * 3), 3.55pp over the current measurement:
   *   · counting noise is the SMALL term — sigma on the count is
   *     sqrt(68121 * 0.2945 * 0.7055) = 119 slots = 0.17pp, so 3 sigma is
   *     0.52pp;
   *   · composition drift is the binding one — 2.99pp, the worst of three
   *     points spanning ~24h (see MEASURED BASELINE above), not the 90-minute
   *     pair the original cap used. The 24h window is the more representative
   *     figure because it actually contains a full daily dedicated-crawler
   *     wave rather than half of one.
   * 33.00% leaves 0.56pp above the worst point measured, i.e. the same
   * "worst-observed-drift plus a noise cushion" method as before, re-run with
   * a longer and therefore more trustworthy window. The margin is sized to
   * measured movement, not to a round number, and can only ever be tightened.
   *
   * Tightening is tracked work, not a TODO to forget: the alert threshold in
   * `.github/workflows/job-title-locale-audit.yml` is 20%, and every weekly run
   * publishes the current rate into the tracking issue. Lower this constant as
   * the repair path (`scripts/mark-mistranslated-jobs.mjs` in
   * translate-pending.yml) drains the backlog.
   *
   * NOTE for whoever tightens it next: part of the rate is DETECTOR noise, not
   * broken pages — the audit's `topEvidence` table isolates it, and that is
   * where the "des"/"installateur"/"sous" homographs were found and removed
   * from `scripts/lib/job-locale-utils.mjs` on 2026-08-10. Re-checked on
   * 2026-08-12: every current top-evidence marker (`von`, `im`, `der`,
   * `Metzger`, the `binnen-i` families) was sampled by hand against its source
   * title and traces to a genuinely partial machine translation, not a
   * lexicon false positive — so this round tightened the cap without further
   * lexicon changes. Re-run `npm run audit:job-title-locale` and sample
   * `topEvidence` again before assuming the same is still true; a single token
   * dominating one locale is the tell.
   */
  it.skipIf(!hasDataset)(
    'non-source job titles are not left in the source language',
    { timeout: 180000 },
    () => {
      // 33.00% — measured 29.45% on the ASSEMBLED data/jobs.json, 2026-08-12,
      // on TITLE_POPULATION (68,200 slots ±15%). See the docstring above for
      // the margin derivation.
      const MAX_RATE = 0.33;

      const { slots, flagged, offenders } = measureTitleLocales(
        jobs!,
        titleLooksUntranslated,
        LOCALES,
      );

      const rate = slots > 0 ? flagged / slots : 0;
      // See the sibling assertion: printed on PASS too, so the next person to
      // tighten this has the current number without needing a red run.
      console.log(
        `[ratchet] ${TITLE_POPULATION.id} ${flagged}/${slots} = `
          + `${(rate * 100).toFixed(2)}% (max ${(MAX_RATE * 100).toFixed(2)}%) `
          + `population=assembled data/jobs.json, expected ${TITLE_POPULATION.expectedSlots} `
          + `±${(TITLE_POPULATION.tolerance * 100).toFixed(0)}%`
      );

      assertPopulationUnchanged(TITLE_POPULATION, slots);

      expect(
        rate,
        `[quality-regression] Non-source titles still in a foreign language: ${flagged}/${slots} = `
          + `${(rate * 100).toFixed(2)}% (max ${(MAX_RATE * 100).toFixed(2)}%)\n`
          + `Population held at ${slots} slots, so this IS a quality movement, not a denominator artefact.\n`
          + 'Repair: node scripts/mark-mistranslated-jobs.mjs --dry-run\n'
          + 'Detail: npm run audit:job-title-locale\n'
          + `${offenders.join('\n')}`
      ).toBeLessThanOrEqual(MAX_RATE);
    }
  );
});
