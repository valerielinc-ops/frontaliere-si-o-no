import { describe, expect, it } from 'vitest';
import { isIncomplete, reconcileRetranslationState } from '../scripts/relocalize-pending-jobs.mjs';

const MIN_DESC = 'x'.repeat(120);

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Front Desk & Office Support',
    description: 'Italian source description that is long enough to pass the minimum check.',
    sourceLang: 'it',
    titleByLocale: {
      it: 'Front Desk & Office Support',
      en: 'Front Desk & Office Support',
      de: 'Front Desk & Office Support Übersetzt',
      fr: 'Front Desk & Office Support Traduit',
    },
    descriptionByLocale: {
      it: MIN_DESC,
      en: MIN_DESC + ' en',
      de: MIN_DESC + ' de',
      fr: MIN_DESC + ' fr',
    },
    ...overrides,
  };
}

describe('isIncomplete – per-slot title verdict (S3: no cross-locale escape hatch)', () => {
  it('flags a source-copy slot even when the other non-source locales differ', () => {
    // This test used to assert the OPPOSITE, and it encoded the defect.
    // The old rule: "the EN slot equals the source title, but DE and FR differ,
    // therefore the job was translated and this slot is an international title —
    // don't flag it." That is the cross-locale escape hatch, and it is exactly
    // what suppressed the reported bug: a DE-source job whose EN and FR slots
    // translated and whose IT slot stayed German had the IT check waved through
    // ON THE EVIDENCE OF EN AND FR.
    //
    // Whether the EN slot has been translated is a property of the EN slot. The
    // verdict is now per slot, so the neighbouring locales cannot excuse it.
    // The cost of the residual false positive (a genuinely international title
    // that no translator can improve) is bounded, not unbounded — see the
    // give-up test below.
    const job = makeJob();
    expect(isIncomplete(job)).toBe(true);
  });

  it('bounds the cost of a title no translator can improve (give-up after 3 attempts)', () => {
    // The counterpart to the test above. An international title stays
    // isIncomplete() forever, so removing the hatch would be a queue leak if
    // nothing absorbed it. MAX_RETRANSLATION_ATTEMPTS does: after three runs in
    // which the job was actually ATTEMPTED and still failed, it is suppressed
    // and leaves the work pool (needsTranslation() returns false for it), until
    // a re-crawl rewrites its source content.
    const job: Record<string, unknown> = { ...makeJob(), needsRetranslation: true };
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('counted');
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('counted');
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('gaveup');
    expect(job.localeMismatchSuppressed).toBe(true);
    expect(job.needsRetranslation).toBeUndefined();
  });

  it('does not flag a correctly translated slot as a source copy', () => {
    // The other half of "per slot": the verdict must stay quiet on real
    // translations, with no help from the neighbours either.
    const job = makeJob({
      titleByLocale: {
        it: 'Front Desk & Office Support',
        en: 'Front Desk Assistant',
        de: 'Empfang und Bueroassistenz',
        fr: 'Assistant accueil et bureau',
      },
    });
    expect(isIncomplete(job)).toBe(false);
  });

  it('returns true when all non-IT locales have the same title as source (genuinely untranslated)', () => {
    const job = makeJob({
      titleByLocale: {
        it: 'Front Desk & Office Support',
        en: 'Front Desk & Office Support',
        de: 'Front Desk & Office Support',
        fr: 'Front Desk & Office Support',
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });

  it('returns true when a locale has a too-short title', () => {
    const job = makeJob({
      titleByLocale: {
        it: 'Front Desk & Office Support',
        en: 'Front Desk & Office Support',
        de: 'X', // too short
        fr: 'Front Desk & Office Support Traduit',
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });

  it('returns true when a locale has a too-short description', () => {
    const job = makeJob({
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC,
        de: 'Too short', // < 120 chars
        fr: MIN_DESC + ' fr',
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });

  it('returns false for a fully translated job with normal Italian title', () => {
    const job = {
      title: 'Ingegnere Software',
      description: MIN_DESC,
      sourceLang: 'it',
      titleByLocale: {
        it: 'Ingegnere Software',
        en: 'Software Engineer',
        de: 'Software-Ingenieur',
        fr: 'Ingénieur Logiciel',
      },
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC + ' en',
        de: MIN_DESC + ' de',
        fr: MIN_DESC + ' fr',
      },
    };
    expect(isIncomplete(job)).toBe(false);
  });

  it('returns true when description matches source across all locales (genuinely untranslated)', () => {
    // All locale descriptions are identical to the source — not translated at all.
    const job = makeJob({
      description: MIN_DESC, // source matches what's in all locale slots
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC,
        de: MIN_DESC,
        fr: MIN_DESC,
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });
});
