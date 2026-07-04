/**
 * #3509 — cross-locale NEAR-duplicate title detector.
 *
 * A partial/failed AI translation can keep the source-language title almost
 * verbatim in another locale (observed live: FR job page with a 90%-Italian
 * title next to a fully-French description+slug). The exact-equality
 * cross-locale duplicate check in writeJobsCrawlerSlice missed it; the
 * near-duplicate detector flags it for retranslation.
 */
import { describe, it, expect } from 'vitest';
import { isNearDuplicateLocalizedTitle } from '../scripts/assemble-jobs-dataset.mjs';

// The real titles from the audited USI job (issue #3509).
const IT_TITLE =
  'Posizione post-dottorato sulla resistenza ai radioligando e alla radioterapia nel cancro alla prostata nel Functional Cancer Genomics Lab';
const BAD_FR_TITLE =
  'Posizione post-dottorato sulla resistenza ai radioligando e alla radioterapia nel cancro alla prostata nel Laboratoire de génomique du cancer fonctionnel';
const GOOD_DE_TITLE =
  'Postdoktorand zur Resistenz gegen Radioligand und Strahlentherapie bei Prostatakrebs im Functional Cancer Genomics Lab';
const GOOD_EN_TITLE =
  'Postdoctoral position on radioligating resistance and radiotherapy in prostate cancer in the Functional Cancer Genomics Lab';

describe('isNearDuplicateLocalizedTitle (#3509)', () => {
  it('flags the audited partially-translated FR title (mostly Italian)', () => {
    expect(isNearDuplicateLocalizedTitle(BAD_FR_TITLE, IT_TITLE)).toBe(true);
  });

  it('does not flag properly translated DE/EN titles of the same job', () => {
    expect(isNearDuplicateLocalizedTitle(GOOD_DE_TITLE, IT_TITLE)).toBe(false);
    expect(isNearDuplicateLocalizedTitle(GOOD_EN_TITLE, IT_TITLE)).toBe(false);
  });

  it('ignores short titles (proper-noun/brand dominated, legitimately untranslated)', () => {
    // < 5 significant tokens → out of scope for the heuristic (the
    // exact-equality rule already covers byte-identical titles).
    expect(isNearDuplicateLocalizedTitle('Software Engineer Lugano', 'Software Engineer Lugano')).toBe(false);
    expect(isNearDuplicateLocalizedTitle('Polymechaniker EFZ 100%', 'Polymechaniker EFZ 100%')).toBe(false);
  });

  it('does not flag a legitimate translation that shares only brand/place tokens', () => {
    expect(
      isNearDuplicateLocalizedTitle(
        'Conseiller clientèle privée Banque Raiffeisen Lugano-Nord',
        'Consulente clientela privata Banca Raiffeisen Lugano-Nord',
      ),
    ).toBe(false);
  });

  it('is accent-insensitive when matching tokens', () => {
    // Same tokens modulo accents → still counted as shared (untranslated).
    expect(
      isNearDuplicateLocalizedTitle(
        'Responsabile qualità laboratorio chimico produzione Lugano',
        'Responsabile qualita laboratorio chimico produzione Lugano',
      ),
    ).toBe(true);
  });

  it('handles empty/nullish input without throwing', () => {
    expect(isNearDuplicateLocalizedTitle('', IT_TITLE)).toBe(false);
    expect(isNearDuplicateLocalizedTitle(IT_TITLE, '')).toBe(false);
    expect(isNearDuplicateLocalizedTitle(undefined as unknown as string, null as unknown as string)).toBe(false);
  });
});
