/**
 * job-locale-population-guard — proves the two job-locale ratchets fail
 * DIFFERENTLY for the two different defects they can now tell apart.
 *
 * This is the assertion the previous design could not make. Until 2026-08-11
 * `tests/job-locale-consistency.test.ts` had exactly one failure mode, and a
 * denominator that halved (the `needsRetranslation` queue sawtooth: 7,126 →
 * 14,041 flagged jobs in ninety minutes) surfaced as a quality alarm. Seven
 * unrelated PRs were red on it.
 *
 * Everything here runs on synthetic fixtures — no `data/jobs.json`, so it is
 * exercised in every environment including a sparse worktree, unlike the
 * ratchets themselves which skip without the assembled artefact. That is
 * deliberate: the guard that distinguishes the two failures must not depend on
 * the artefact whose absence is one of the things it guards against.
 */
import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_POPULATION,
  MIN_SERVED_SHARE,
  TITLE_POPULATION,
  assertPopulationUnchanged,
  measureDescriptionLocales,
  measureTitleLocales,
} from '../scripts/lib/job-locale-population.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/** 120+ chars, so every generated slot clears the description length floor. */
const filler = (word: string) => `${word} `.repeat(40).trim();

interface FixtureJob {
  company: string;
  slug: string;
  sourceLang: string;
  needsRetranslation?: boolean;
  titleByLocale: Record<string, string>;
  descriptionByLocale: Record<string, string>;
}

/**
 * n jobs with all four description slots populated and all three non-source
 * title slots populated. `wrong` marks how many of them carry German text in
 * every description slot; `queued` how many carry `needsRetranslation`.
 *
 * A "wrong" job yields THREE mismatches, not four: its `de` slot holding German
 * is correct, so only it/en/fr are defects. Kept that way on purpose — a
 * fixture where every slot of a broken job is a defect would not catch a
 * detector that ignores the target locale.
 */
function makeJobs(n: number, opts: { wrong?: number; queued?: number } = {}): FixtureJob[] {
  const wrong = opts.wrong ?? 0;
  const queued = opts.queued ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const isWrong = i < wrong;
    const body = isWrong ? filler('Mitarbeiter') : filler('collaboratore');
    return {
      company: 'acme',
      slug: `job-${i}`,
      sourceLang: 'it',
      ...(i < queued ? { needsRetranslation: true } : {}),
      titleByLocale: { it: 'Impiegato', en: 'Clerk', de: 'Angestellter', fr: 'Employé' },
      descriptionByLocale: { it: body, en: body, de: body, fr: body },
    };
  });
}

/** Deterministic stand-in for detectLanguageWithConfidence. */
const detect = (text: string, locale: string) =>
  text.includes('Mitarbeiter')
    ? { lang: 'de', confidence: 0.9 }
    : { lang: locale, confidence: 0.9 };

/** Deterministic stand-in for titleLooksUntranslated. */
const looksUntranslated = ({ title }: { title: string }) =>
  title === 'Impiegato'
    ? { untranslated: true, reason: 'source-language', evidence: 'it' }
    : { untranslated: false };

describe('job-locale population identity', () => {
  describe('assertPopulationUnchanged', () => {
    it('accepts a population inside the declared tolerance band', () => {
      const spec = { ...DESCRIPTION_POPULATION, expectedSlots: 1000, tolerance: 0.15 };
      expect(() => assertPopulationUnchanged(spec, 1000)).not.toThrow();
      expect(() => assertPopulationUnchanged(spec, 850)).not.toThrow();
      expect(() => assertPopulationUnchanged(spec, 1150)).not.toThrow();
    });

    it('rejects a halved population with [population-changed], NOT a quality message', () => {
      const spec = { ...DESCRIPTION_POPULATION, expectedSlots: 1000, tolerance: 0.15 };
      // The real shape of the 2026-08-11 failure: 62,944 → 34,594 slots.
      expect(() => assertPopulationUnchanged(spec, 500)).toThrow(/\[population-changed\]/);
      expect(() => assertPopulationUnchanged(spec, 500)).toThrow(/moved from 1000 to 500 slots/);
      expect(() => assertPopulationUnchanged(spec, 500)).toThrow(/-50\.0%/);
      // It must say, in as many words, that the rate cannot be read.
      expect(() => assertPopulationUnchanged(spec, 500)).toThrow(/NOT a quality regression/);
      expect(() => assertPopulationUnchanged(spec, 500)).toThrow(/not comparable/);
      // And it must hand over the number to paste.
      expect(() => assertPopulationUnchanged(spec, 500)).toThrow(/expectedSlots: 500/);
      // The message must NOT read as the other defect.
      expect(() => assertPopulationUnchanged(spec, 500)).not.toThrow(/\[quality-regression\]/);
    });

    it('rejects an inflated population too — the slice/assembled swap', () => {
      // Descriptions: 90,528 assembled vs 107,808 read from the slices (+19%).
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 107808)).toThrow(/\[population-changed\]/);
      // Titles: 78,725 assembled (re-baselined 2026-08-25, issue 6510) vs
      // 92,231 read from the slices, re-measured the same day directly off
      // data/jobs/by-crawler/*.json (+17.2%). The two historical figures this
      // assertion used before the re-baseline (80,978 / 79,796 — the exact
      // number that mis-calibrated this gate the first time, back when
      // expectedSlots was 68,200) now fall INSIDE the new ±15% band by
      // construction of the re-baseline itself, so they stopped proving
      // anything about this failure mode; replaced with a fresh measurement.
      expect(() => assertPopulationUnchanged(TITLE_POPULATION, 92231)).toThrow(/\[population-changed\]/);
    });

    it('holds both shipped populations at their real measured sizes', () => {
      // Descriptions, assembled, 2026-08-11 at both ends of the crawl wave.
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 91297)).not.toThrow();
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 90528)).not.toThrow();
      // Titles, assembled, four measurements the same day.
      for (const n of [68587, 68306, 67987, 67844]) {
        expect(() => assertPopulationUnchanged(TITLE_POPULATION, n)).not.toThrow();
      }
    });
  });

  describe('measureDescriptionLocales — the queue moves the numerator, never the denominator', () => {
    it('counts every description slot regardless of needsRetranslation', () => {
      const none = measureDescriptionLocales(makeJobs(100), detect, LOCALES);
      const half = measureDescriptionLocales(makeJobs(100, { queued: 50 }), detect, LOCALES);
      const all = measureDescriptionLocales(makeJobs(100, { queued: 100 }), detect, LOCALES);

      // THE REGRESSION THIS PR EXISTS FOR: under the old construction these
      // three denominators were 400, 200 and 0 — a 2x swing at identical
      // corpus content, which is what took the gate red.
      expect(none.slots).toBe(400);
      expect(half.slots).toBe(400);
      expect(all.slots).toBe(400);

      // The queue is still honoured, in the served count.
      expect(none.servedSlots).toBe(400);
      expect(half.servedSlots).toBe(200);
      expect(all.servedSlots).toBe(0);
    });

    it('does not count a queued slot as a defect', () => {
      // 10 wrong-language jobs, all of them queued for retranslation.
      const queued = measureDescriptionLocales(makeJobs(100, { wrong: 10, queued: 10 }), detect, LOCALES);
      expect(queued.mismatches).toHaveLength(0);
      expect(queued.slots).toBe(400);

      // Same 10 wrong-language jobs, none queued: now they are shipped harm.
      // 3 defective slots each (the `de` slot is legitimately German).
      const served = measureDescriptionLocales(makeJobs(100, { wrong: 10 }), detect, LOCALES);
      expect(served.mismatches).toHaveLength(30);
      expect(served.slots).toBe(400);
    });

    it('keeps the rate flat when only the queue moves', () => {
      // Identical corpus, identical defects, only the queue depth differs —
      // and the queued jobs are the CLEAN ones, so the served defect count is
      // unchanged. The old gate read 40/400 then 40/240; this one reads
      // 40/400 both times.
      const before = measureDescriptionLocales(makeJobs(100, { wrong: 10 }), detect, LOCALES);
      const jobsAfter = makeJobs(100, { wrong: 10 });
      for (let i = 60; i < 100; i++) jobsAfter[i].needsRetranslation = true;
      const after = measureDescriptionLocales(jobsAfter, detect, LOCALES);

      expect(after.slots).toBe(before.slots);
      expect(after.mismatches.length).toBe(before.mismatches.length);
      expect(after.mismatches.length / after.slots).toBe(before.mismatches.length / before.slots);
      // The old construction would have moved this rate by 67%.
      expect(before.mismatches.length / before.servedSlots).not.toBe(
        after.mismatches.length / after.servedSlots,
      );
    });

    it('ignores slots below the 120-character floor', () => {
      const jobs = makeJobs(1);
      jobs[0].descriptionByLocale.en = 'zu kurz';
      expect(measureDescriptionLocales(jobs, detect, LOCALES).slots).toBe(3);
    });
  });

  describe('measureTitleLocales', () => {
    it('counts non-source title slots only, and ignores empty ones', () => {
      const jobs = makeJobs(10);
      expect(measureTitleLocales(jobs, looksUntranslated, LOCALES).slots).toBe(30);
      jobs[0].titleByLocale.de = '';
      expect(measureTitleLocales(jobs, looksUntranslated, LOCALES).slots).toBe(29);
    });

    it('is unaffected by the queue on both sides of the ratio', () => {
      const plain = measureTitleLocales(makeJobs(10), looksUntranslated, LOCALES);
      const queued = measureTitleLocales(makeJobs(10, { queued: 10 }), looksUntranslated, LOCALES);
      expect(queued.slots).toBe(plain.slots);
      expect(queued.flagged).toBe(plain.flagged);
    });

    it('caps the offender list without capping the count', () => {
      const jobs = makeJobs(40).map((j) => ({ ...j, titleByLocale: { ...j.titleByLocale, en: 'Impiegato' } }));
      const out = measureTitleLocales(jobs, looksUntranslated, LOCALES, 20);
      expect(out.flagged).toBe(40);
      expect(out.offenders).toHaveLength(20);
    });
  });

  describe('the two failure modes are distinguishable end to end', () => {
    /** Mirrors the assertion order inside the descriptions ratchet. */
    function runDescriptionGate(jobs: FixtureJob[], expectedSlots: number, maxRate: number) {
      const spec = { ...DESCRIPTION_POPULATION, expectedSlots, tolerance: 0.15 };
      const { slots, servedSlots, mismatches } = measureDescriptionLocales(jobs, detect, LOCALES);
      assertPopulationUnchanged(spec, slots);
      const servedShare = slots > 0 ? servedSlots / slots : 0;
      if (servedShare < MIN_SERVED_SHARE) {
        throw new Error(`[gate-blind] only ${(servedShare * 100).toFixed(1)}% of slots are served`);
      }
      const rate = mismatches.length / slots;
      if (rate > maxRate) {
        throw new Error(`[quality-regression] ${mismatches.length}/${slots} = ${(rate * 100).toFixed(3)}%`);
      }
      return { slots, servedShare, rate };
    }

    it('passes when the population holds and the quality holds', () => {
      const out = runDescriptionGate(makeJobs(100, { wrong: 1 }), 400, 0.02);
      expect(out.slots).toBe(400);
      expect(out.rate).toBeCloseTo(3 / 400, 10);
    });

    it('SCENARIO A — population out of tolerance → [population-changed]', () => {
      // Corpus halved; quality untouched (zero defects).
      expect(() => runDescriptionGate(makeJobs(50), 400, 0.02)).toThrow(/\[population-changed\]/);
      expect(() => runDescriptionGate(makeJobs(50), 400, 0.02)).not.toThrow(/\[quality-regression\]/);
      expect(() => runDescriptionGate(makeJobs(50), 400, 0.02)).not.toThrow(/\[gate-blind\]/);
    });

    it('SCENARIO B — population stable, rate over cap → [quality-regression]', () => {
      // Corpus identical; 20 of 100 jobs now hold German text in every slot
      // → 60 defective slots of the same 400.
      expect(() => runDescriptionGate(makeJobs(100, { wrong: 20 }), 400, 0.02)).toThrow(/\[quality-regression\]/);
      expect(() => runDescriptionGate(makeJobs(100, { wrong: 20 }), 400, 0.02)).toThrow(/60\/400/);
      expect(() => runDescriptionGate(makeJobs(100, { wrong: 20 }), 400, 0.02)).not.toThrow(/\[population-changed\]/);
    });

    it('SCENARIO C — the queue swallows the corpus → [gate-blind], not a green pass', () => {
      // 90 of 100 jobs queued: the served slice is 10% of the population, so a
      // zero defect count means nothing. The old gate would have reported
      // 0/40 = 0.000% and passed.
      expect(() => runDescriptionGate(makeJobs(100, { queued: 90 }), 400, 0.02)).toThrow(/\[gate-blind\]/);
      expect(() => runDescriptionGate(makeJobs(100, { queued: 90 }), 400, 0.02)).not.toThrow(/\[population-changed\]/);
      expect(() => runDescriptionGate(makeJobs(100, { queued: 90 }), 400, 0.02)).not.toThrow(/\[quality-regression\]/);
    });

    it('SCENARIO D — the real 2026-08-11 numbers do not trip the population guard', () => {
      // 62,944 → 34,594 served slots was the old denominator. On the new
      // population the same two states are 91,297 and 90,528, both inside the
      // band — so the gate stays on the quality question, which is the point.
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 91297)).not.toThrow();
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 90528)).not.toThrow();
      // ...while the old denominators would both have been flagged as what they
      // were: a different set.
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 62944)).toThrow(/\[population-changed\]/);
      expect(() => assertPopulationUnchanged(DESCRIPTION_POPULATION, 34594)).toThrow(/\[population-changed\]/);
    });
  });
});
