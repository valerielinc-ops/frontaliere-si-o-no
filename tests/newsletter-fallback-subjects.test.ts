import { describe, expect, it } from 'vitest';

const { FALLBACK_SUBJECT } = await import('@/services/newsletter-content.mjs');

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('FALLBACK_SUBJECT', () => {
  it('defines a fallback for every supported locale', () => {
    for (const loc of LOCALES) {
      expect(FALLBACK_SUBJECT[loc], `missing fallback for ${loc}`).toBeDefined();
    }
  });

  for (const loc of LOCALES) {
    describe(`${loc}`, () => {
      const subject: string = FALLBACK_SUBJECT[loc];

      it('passes inline-QA length bounds (10..60)', () => {
        expect(subject.length).toBeGreaterThanOrEqual(10);
        expect(subject.length).toBeLessThanOrEqual(60);
      });

      it('does not look truncated', () => {
        expect(subject.endsWith('...')).toBe(false);
        expect(subject.endsWith('\u2026')).toBe(false);
      });

      it('contains real word content (not emoji-only)', () => {
        expect(/[\p{L}]{3,}/u.test(subject)).toBe(true);
      });
    });
  }
});
