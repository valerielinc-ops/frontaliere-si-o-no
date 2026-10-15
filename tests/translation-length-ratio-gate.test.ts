import { describe, it, expect } from 'vitest';
import {
  isAcceptableTranslation,
  MIN_TRANSLATION_RATIO,
  MIN_TRANSLATION_CHARS,
  translationRejectionReason,
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
    expect(isAcceptableTranslation(source, null)).toBe(false);
    expect(isAcceptableTranslation(source, undefined)).toBe(false);
  });

  it('applies only the char floor when the source length is unknown', () => {
    // Empty source disables the ratio check; a >= floor candidate passes.
    expect(isAcceptableTranslation('', 'b'.repeat(MIN_TRANSLATION_CHARS))).toBe(true);
    expect(isAcceptableTranslation('', 'b'.repeat(MIN_TRANSLATION_CHARS - 1))).toBe(false);
  });
});

// The 2e diagnostic names the rule that refused a translation. On run
// 38609788214 every refusal was logged as «truncated» at 87–119% of the source
// length, i.e. by a rule other than the length ratio.
describe('translationRejectionReason', () => {
  const source = 'a'.repeat(300);
  const listSource = ['Ihre Aufgaben:', '- Pflege der Bewohnerinnen und Bewohner im Alltag', '- Dokumentation der Pflegeleistungen im System', '- Zusammenarbeit mit Ärzten und Angehörigen'].join('\n');
  const flattened = 'Le sue mansioni: cura dei residenti nella vita quotidiana, documentazione delle prestazioni infermieristiche nel sistema, collaborazione con medici e familiari.';

  it('is null exactly when isAcceptableTranslation accepts', () => {
    for (const candidate of ['b'.repeat(290), 'b'.repeat(181), 'b'.repeat(179), 'b'.repeat(50), flattened]) {
      for (const src of [source, listSource]) {
        expect(translationRejectionReason(src, candidate) === null).toBe(isAcceptableTranslation(src, candidate));
      }
    }
  });

  it('names the length rules', () => {
    expect(translationRejectionReason(source, 'b'.repeat(50))).toBe('too-short');
    expect(translationRejectionReason(source, 'b'.repeat(179))).toBe('below-source-ratio');
    expect(translationRejectionReason(source, 42 as unknown as string)).toBe('not-text');
  });

  it('names a refusal for lost list items, at any length ratio', () => {
    expect(flattened.length / listSource.length).toBeGreaterThan(MIN_TRANSLATION_RATIO);
    expect(translationRejectionReason(listSource, flattened)).toBe('lost-list-items');
  });
});
