/**
 * job-locale-population — the POPULATION half of the two job-locale ratchets.
 *
 * WHY THIS FILE EXISTS. `tests/job-locale-consistency.test.ts` ratchets on a
 * rate, and a rate is only comparable with its baseline when both are measured
 * on the SAME set. Until 2026-08-11 that set was named in a docstring
 * ("A baseline that does not name its population is not a baseline") and
 * nowhere else — so nothing could check it, and the descriptions ratchet went
 * red on a set it had never been calibrated against.
 *
 * MEASURED, 2026-08-11, on the ASSEMBLED `data/jobs.json` at two states of
 * `main` ninety minutes apart (0356b30b @09:52 UTC → efd6faf8 @10:59 UTC,
 * i.e. across the daily dedicated-crawler wave that rewrote 468 slices):
 *
 *   jobs                                    22,864  →  22,690   (-0.8%)
 *   needsRetranslation (the pipeline queue)  7,126  →  14,041   (+97%)
 *   description slots, ALL                  91,297  →  90,528   (-0.8%)  ← stable
 *   description slots, !needsRetranslation  62,944  →  34,594   (-45%)   ← NOT a population
 *   non-source title slots                  68,587  →  67,987   (-0.9%)  ← stable
 *
 * The corpus did not move. The QUEUE did — the crawl-time quality gate in
 * `writeJobsCrawlerSlice()` re-flags jobs on every slice rewrite, and
 * translate-pending drains them back out, so `needsRetranslation` sawtooths
 * between ~7k and ~18k jobs several times a day. Any population defined as
 * "the complement of the queue" therefore halves and doubles at a constant
 * corpus quality, and a rate over it is not comparable with itself, let alone
 * with a baseline.
 *
 * So the populations pinned below are QUEUE-FREE by construction: they are
 * properties of the corpus, not of the pipeline's to-do list. The queue is
 * still honoured — but in the NUMERATOR, where it belongs: a slot the pipeline
 * has queued for retranslation is not a slot the site serves as a finished
 * translation, so it is not counted as a defect. That is the same choice the
 * titles ratchet already made deliberately ("does NOT exclude
 * `needsRetranslation` from either side of the ratio ... so merge order cannot
 * move the number on its own"); this file extends it to descriptions.
 *
 * Everything here is pure and detector-injected, so `tests/job-locale-population-guard.test.ts`
 * can drive both failure modes from synthetic fixtures with no dataset.
 */
import { normalizeJobLocale } from './job-locale-utils.mjs';

/**
 * @typedef {object} PopulationSpec
 * @property {string} id            Ratchet name, as printed.
 * @property {string} source        Which artefact the slots are read from.
 * @property {string} filter        Which slots are in the population.
 * @property {number} expectedSlots Size measured on `measuredOn`.
 * @property {number} tolerance     Fractional band around `expectedSlots`.
 * @property {string} measuredOn    ISO date of the measurement.
 */

/**
 * The artefact both ratchets read. Named once, here, so the two gates cannot
 * drift onto different sources — which is exactly how the previous calibration
 * went wrong (the committed `data/jobs/by-crawler/*.json` SLICES understated
 * the assembled description population by 3.3x).
 */
export const POPULATION_SOURCE =
  'data/jobs.json AS ASSEMBLED by scripts/assemble-jobs-dataset.mjs (NOT the data/jobs/by-crawler/*.json slices)';

/**
 * DESCRIPTIONS population: every `descriptionByLocale[locale]` slot holding at
 * least 120 trimmed characters, across all four locales, for every job —
 * INDEPENDENT of `needsRetranslation`.
 *
 * `expectedSlots` is the mean of the two 2026-08-11 measurements (91,297 and
 * 90,528), which sit 0.8% apart across a full crawl wave.
 *
 * RE-DERIVED 2026-09-29 (issue #9102): the assembled corpus measured 115,907
 * slots. The served wrong-locale rate was 36 / 115,907 = 0.031%; the 0.30%
 * quality cap remains unchanged, so this is a denominator re-baseline and not
 * a loosened gate.
 *
 * TOLERANCE 15%. Sized to make the historical failure impossible rather than
 * to a round number: the old assembled baseline's slice reading was 107,808
 * slots (+18.6% over 90,900), so the slice/assembled swap that caused this
 * gate's first red had its own population-change message instead of a fake
 * quality regression. After the 2026-09-29 re-baseline that historical figure
 * is inside the new band; `tests/job-locale-population-guard.test.ts` therefore
 * keeps the same +18.6% swap as an explicit synthetic out-of-band fixture.
 * Daily drift is 0.8%, so the band is ~19x observed movement and will not
 * flicker. When genuine corpus growth crosses it the gate says so in one line
 * and asks for a deliberate re-derivation — which is the intended cost, not a
 * defect.
 * @type {PopulationSpec}
 */
export const DESCRIPTION_POPULATION = {
  id: 'descriptions-wrong-locale',
  source: POPULATION_SOURCE,
  filter: 'descriptionByLocale[it|en|de|fr] with >= 120 trimmed chars, for every job, independent of needsRetranslation',
  expectedSlots: 115907,
  tolerance: 0.15,
  measuredOn: '2026-09-29',
};

/**
 * TITLES population: every non-source `titleByLocale[locale]` slot that is not
 * empty (an empty slot is a completeness defect, gated elsewhere).
 *
 * `expectedSlots` was originally the mean of four 2026-08-11 measurements on
 * the assembled artefact — 68,587 / 68,306 / 67,987 / 67,844 — a 1.1% spread
 * across the day.
 *
 * RE-DERIVED 2026-09-30 (issue #9102): organic corpus growth (more jobs
 * crawled, not a regression) moved the population past the ±15% band again.
 * The assembled artefact measured 90,712 slots, so `expectedSlots` is
 * re-pinned to that measured denominator; `tolerance` is UNCHANGED at 0.15 —
 * this re-bases a measured denominator, it does not loosen the gate.
 *
 * TOLERANCE 15%, same construction: the same population read from the SLICES
 * is 80,978 slots (+18.7%), and the docstring's own historical slice figure was
 * 79,796 (+17.0%) — both now caught. This ratchet has never gone red for a
 * population change, which is precisely why it needed the guard: its sibling's
 * failure was the same defect with the same shape, one dataset refresh later.
 * @type {PopulationSpec}
 */
export const TITLE_POPULATION = {
  id: 'titles-wrong-locale',
  source: POPULATION_SOURCE,
  filter: 'non-empty titleByLocale[locale] for every locale !== sourceLang, for every job, independent of needsRetranslation',
  expectedSlots: 90712,
  tolerance: 0.15,
  measuredOn: '2026-09-30',
};

/**
 * Floor on the share of the description population the site serves as FINISHED
 * (i.e. not queued for retranslation).
 *
 * Moving the descriptions denominator off the queue removes the instability but
 * opens one blind spot in its place: if the queue ever swallowed the corpus the
 * defect count would go to zero and the gate would pass vacuously. This floor
 * closes it. Measured 2026-08-11: 68.9% before the crawl wave, 38.2% after —
 * one wave costs ~31pp, so 20% sits ~0.6 of a wave below the observed trough:
 * low enough never to flicker, high enough that "the gate went blind" cannot be
 * mistaken for "the gate is green". It is a catastrophe guard, not a
 * sensitivity guarantee — the served share is printed on every run so the
 * erosion is visible long before the floor is reached.
 */
export const MIN_SERVED_SHARE = 0.2;

/**
 * Assert that the measured population is the one the rate baseline was derived
 * on.
 *
 * Throws with a DISTINCT, self-describing message. "The population moved" and
 * "the quality regressed" are two different defects with two different repairs,
 * and conflating them is what made this gate uninterpretable: a denominator
 * that halves doubles the rate at constant quality, and the reader sees a
 * quality alarm.
 *
 * @param {PopulationSpec} spec
 * @param {number} slots Measured population size.
 * @returns {void}
 * @throws {Error} tagged `[population-changed]` when outside the declared band.
 */
export function assertPopulationUnchanged(spec, slots) {
  const lo = Math.round(spec.expectedSlots * (1 - spec.tolerance));
  const hi = Math.round(spec.expectedSlots * (1 + spec.tolerance));
  if (slots >= lo && slots <= hi) return;
  const drift = (slots / spec.expectedSlots - 1) * 100;
  throw new Error(
    `[population-changed] ${spec.id}: the gated population moved from ${spec.expectedSlots} to ${slots} slots `
      + `(${drift > 0 ? '+' : ''}${drift.toFixed(1)}%, declared tolerance ±${(spec.tolerance * 100).toFixed(0)}% → [${lo}, ${hi}]).\n`
      + 'This is NOT a quality regression. The rate this gate computes is measured on a different set than the '
      + 'baseline was, so it is not comparable with it and can neither pass nor fail meaningfully.\n'
      + `POPULATION: ${spec.source}\n`
      + `            ${spec.filter}\n`
      + `            baseline size ${spec.expectedSlots}, measured ${spec.measuredOn}\n`
      + 'FIX (in this order, in one commit):\n'
      + '  1. node scripts/assemble-jobs-dataset.mjs --stats   # rebuild the artefact this gate reads\n'
      + '  2. npx vitest run tests/job-locale-consistency.test.ts   # the rate is printed on PASS too\n'
      + `  3. in scripts/lib/job-locale-population.mjs set expectedSlots: ${slots} for ${spec.id}, and re-derive `
      + 'the rate baseline in the SAME commit — a population change invalidates the rate baseline with it.\n'
      + 'Do NOT widen the tolerance to make this pass: the band is sized to catch the slice/assembled swap '
      + '(+18%) that produced this gate\'s first red.',
  );
}

/**
 * Count wrong-language description slots.
 *
 * POPULATION (denominator): every description slot, queue or no queue.
 * DEFECT (numerator): a slot the site serves as a FINISHED translation
 * (`!needsRetranslation`) whose text is confidently detected as another
 * language. Queued slots are expected to hold source-language fallbacks until
 * translate-pending processes them, so they are not defects — but they are
 * still part of the corpus, so they stay in the denominator.
 *
 * The detector runs on served slots only: same cost as before this split.
 *
 * @param {Array<object>} jobs
 * @param {(text: string, locale: string) => { lang: string, confidence: number }} detect
 * @param {readonly string[]} locales
 * @param {number} [minConfidence]
 * @returns {{ slots: number, servedSlots: number, mismatches: string[] }}
 */
export function measureDescriptionLocales(jobs, detect, locales, minConfidence = 0.65) {
  let slots = 0;
  let servedSlots = 0;
  const mismatches = [];
  for (const job of jobs) {
    const queued = Boolean(job?.needsRetranslation);
    for (const locale of locales) {
      const description = String(job?.descriptionByLocale?.[locale] || '').trim();
      if (description.length < 120) continue;
      slots += 1;
      if (queued) continue;
      servedSlots += 1;
      const detected = detect(description, locale);
      if (detected.confidence >= minConfidence && detected.lang !== locale) {
        mismatches.push(
          `${job?.company || '?'}/${job?.slug || '?'} [${locale}] => ${detected.lang} (${detected.confidence.toFixed(2)})`,
        );
      }
    }
  }
  return { slots, servedSlots, mismatches };
}

/**
 * Count non-source title slots still reading as the source language.
 *
 * POPULATION and DEFECT are both queue-free here, unchanged from the ratchet's
 * original construction: the site serves these titles regardless of
 * `needsRetranslation`, so merge order cannot move the number on its own.
 *
 * @param {Array<object>} jobs
 * @param {(input: object) => { untranslated: boolean, reason?: string, evidence?: string }} looksUntranslated
 * @param {readonly string[]} locales
 * @param {number} [maxOffenders]
 * @returns {{ slots: number, flagged: number, offenders: string[] }}
 */
export function measureTitleLocales(jobs, looksUntranslated, locales, maxOffenders = 20) {
  let slots = 0;
  let flagged = 0;
  const offenders = [];
  for (const job of jobs) {
    const normalizedSourceLang = normalizeJobLocale(job?.sourceLang || 'it');
    const sourceLang = locales.includes(normalizedSourceLang) ? normalizedSourceLang : 'it';
    const titles = job?.titleByLocale || {};
    const sourceTitle = String(titles[sourceLang] || job?.title || '');
    for (const locale of locales) {
      if (locale === sourceLang) continue;
      const title = String(titles[locale] || '').trim();
      if (!title) continue; // empty slot: a completeness defect, gated elsewhere
      slots += 1;
      const verdict = looksUntranslated({
        title,
        sourceTitle,
        sourceLang,
        targetLocale: locale,
        company: job?.company || '',
        location: job?.location || '',
      });
      if (!verdict.untranslated) continue;
      flagged += 1;
      if (offenders.length < maxOffenders) {
        offenders.push(`${job?.company || '?'}/${job?.slug || '?'} [${locale}] ${verdict.reason} (${verdict.evidence}): ${title}`);
      }
    }
  }
  return { slots, flagged, offenders };
}

/**
 * Population slots of a set of jobs under the SAME filters as the two
 * ratchets: the `slots` that measureTitleLocales / measureDescriptionLocales
 * return, without running a detector.
 *
 * WHY. Agency jobs held out of publication until their titles are translated
 * (owner decision 2026-10-03, scripts/lib/translation-publication-hold.mjs)
 * stay in the corpus but are not in the assembled `data/jobs.json` the
 * ratchets read. Both `expectedSlots` were measured when every one of those
 * jobs was published, so a measured population without them is a different
 * set from the baseline. The assembler counts the held jobs' slots with this
 * function and writes them to `data/jobs-meta.json`; the population guard adds
 * them back. The RATE is still measured on what the site serves.
 *
 * @param {Array<object>} jobs
 * @param {readonly string[]} [locales]
 * @returns {{ titles: number, descriptions: number }}
 */
export function countPopulationSlots(jobs, locales = ['it', 'en', 'de', 'fr']) {
  return {
    titles: measureTitleLocales(jobs, () => ({ untranslated: false }), locales, 0).slots,
    descriptions: measureDescriptionLocales(jobs, (_text, locale) => ({ lang: locale, confidence: 0 }), locales).slots,
  };
}

/**
 * Held-for-translation population slots recorded by the assembly that produced
 * the measured `data/jobs.json`, or null when they cannot be trusted: field
 * missing (assembler before the threshold) or invalid, or a meta that is not
 * from the same assembly (`totalJobs` counts the published jobs, so it must
 * equal the length of the measured dataset — a projection that already
 * includes held jobs does not match, and nothing is added twice). Null means
 * the guard compares the measured slots alone, exactly as before.
 *
 * @param {object|null} meta              parsed data/jobs-meta.json
 * @param {number} publishedJobCount      length of the measured data/jobs.json
 * @returns {{ titles: number, descriptions: number } | null}
 */
export function heldPopulationSlots(meta, publishedJobCount) {
  if (!meta || meta.totalJobs !== publishedJobCount) return null;
  const slots = meta.translationHold?.populationSlots;
  const titles = slots?.titles;
  const descriptions = slots?.descriptions;
  if (!Number.isInteger(titles) || titles < 0) return null;
  if (!Number.isInteger(descriptions) || descriptions < 0) return null;
  return { titles, descriptions };
}
