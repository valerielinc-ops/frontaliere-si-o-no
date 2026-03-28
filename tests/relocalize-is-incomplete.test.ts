import { describe, expect, it } from 'vitest';
import { isIncomplete } from '../scripts/relocalize-pending-jobs.mjs';

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

describe('isIncomplete – false positive guard for multilingual titles', () => {
  it('returns false when title is already in English and other locales are translated', () => {
    // Title is "Front Desk & Office Support" (English phrase), source is 'it'.
    // EN locale title matches source title — but DE and FR have different translations,
    // proving the content is genuinely translated. Should NOT be flagged as incomplete.
    const job = makeJob();
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
