/**
 * hasConcatenatedWords() — regression.
 *
 * Root cause (15-day git-history audit of Denner's dedicated-crawler
 * output): job denner-682a9b6d22ad had titleByLocale.it stuck at
 * "Direttoredifiliale" (should be "Direttore di filiale") across 7
 * retranslation passes. No heuristic in translation-quality.mjs or the
 * title-quality checks in shared-jobs-crawler.mjs / dedicated-crawler-common.mjs
 * caught a title where source words were glued together with no spaces —
 * the exact-copy-of-source check and the wrong-language check both see a
 * non-empty, non-source-copy title as "already translated", so a garbled
 * title never gets re-flagged for retranslation.
 */
import { describe, it, expect } from 'vitest';
import { hasConcatenatedWords } from '../../scripts/lib/translation-quality.mjs';

describe('hasConcatenatedWords()', () => {
  it('flags the observed Denner incident title', () => {
    expect(hasConcatenatedWords('Direttoredifiliale', 'it')).toBe(true);
  });

  it('does not flag a properly spaced Italian title', () => {
    expect(hasConcatenatedWords('Direttore di filiale', 'it')).toBe(false);
  });

  it('flags glued words for fr/en locales too', () => {
    expect(hasConcatenatedWords('Responsableduservice', 'fr')).toBe(true);
    expect(hasConcatenatedWords('BranchManagerPosition', 'en')).toBe(true);
  });

  it('does not flag German titles even with long compound words', () => {
    // Legitimate long German compounds (no reliable length/charset split
    // from a glued-word defect) — 'de' is intentionally excluded.
    expect(hasConcatenatedWords('Geschäftsführerin', 'de')).toBe(false);
    expect(hasConcatenatedWords('Sachbearbeiterin Buchhaltung', 'de')).toBe(false);
  });

  it('does not flag a single short legitimate word', () => {
    expect(hasConcatenatedWords('Praticante', 'it')).toBe(false);
  });

  it('handles empty/non-string input safely', () => {
    expect(hasConcatenatedWords('', 'it')).toBe(false);
    // @ts-expect-error intentional non-string input
    expect(hasConcatenatedWords(undefined, 'it')).toBe(false);
  });

  it('does not flag when locale has no configured threshold', () => {
    expect(hasConcatenatedWords('Direttoredifiliale', 'unknown-locale')).toBe(false);
  });
});
