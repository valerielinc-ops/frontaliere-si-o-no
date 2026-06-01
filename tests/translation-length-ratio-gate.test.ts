import { describe, it, expect } from 'vitest';
import {
  isAcceptableTranslation,
  MIN_TRANSLATION_RATIO,
  MIN_TRANSLATION_CHARS,
} from '../scripts/lib/translation-quality.mjs';

// Guards the source-length-ratio gate shared by the three writers of
// descriptionByLocale on indexed job pages: fix-untranslated-descriptions,
// localize-vf-existing-jobs and re-localize-jobs. A clipped / truncated
// translation (>= the char floor but well below the source length) must be
// rejected before it can reach the indexed dataset.
describe('isAcceptableTranslation length-ratio gate', () => {
  const source = 'a'.repeat(300); // ratio threshold = 300 * 0.6 = 180 chars

  it('exposes the gate constants used across the writers', () => {
    expect(MIN_TRANSLATION_RATIO).toBe(0.6);
    expect(MIN_TRANSLATION_CHARS).toBe(100);
  });

  it('accepts a full-length translation', () => {
    expect(isAcceptableTranslation(source, 'b'.repeat(290))).toBe(true);
  });

  it('rejects a clipped translation (>= char floor but < 60% of source)', () => {
    const clipped = 'b'.repeat(130); // 130/300 = 0.43 < 0.6
    expect(clipped.length).toBeGreaterThanOrEqual(MIN_TRANSLATION_CHARS);
    expect(isAcceptableTranslation(source, clipped)).toBe(false);
  });

  it('rejects a translation just below the ratio band', () => {
    expect(isAcceptableTranslation(source, 'b'.repeat(179))).toBe(false); // 0.597
  });

  it('accepts a translation at the ratio band', () => {
    expect(isAcceptableTranslation(source, 'b'.repeat(181))).toBe(true); // 0.603
  });

  it('rejects a too-short translation (< char floor)', () => {
    expect(isAcceptableTranslation(source, 'b'.repeat(50))).toBe(false);
  });

  it('rejects empty / whitespace / nullish translations', () => {
    expect(isAcceptableTranslation(source, '')).toBe(false);
    expect(isAcceptableTranslation(source, '   ')).toBe(false);
    // @ts-expect-error runtime guard for nullish input
    expect(isAcceptableTranslation(source, null)).toBe(false);
    // @ts-expect-error runtime guard for undefined input
    expect(isAcceptableTranslation(source, undefined)).toBe(false);
  });

  it('applies only the char floor when the source length is unknown', () => {
    // Empty source disables the ratio check; a >= floor candidate passes.
    expect(isAcceptableTranslation('', 'b'.repeat(MIN_TRANSLATION_CHARS))).toBe(true);
    expect(isAcceptableTranslation('', 'b'.repeat(MIN_TRANSLATION_CHARS - 1))).toBe(false);
  });
});
