/**
 * Regression test for issue #5479 (CTR sotto soglia: template Articoli blog).
 *
 * Root cause: `applySerpTitleDescriptionVariant` (services/seoService.ts)
 * ran the SERP title/description A/B experiment on every section (Remote
 * Config target `*`), but `getSerpIntentLabel`'s vocabulary is
 * calculator-shaped ("oltre 20km", "cambio CHF EUR", "pensione
 * frontalieri"). Any path outside that set — blog articles, guides,
 * listings — used to fall back to a generic "simulazione"/"simulation"
 * label, appending a content-mismatched suffix like
 * " 2026 | simulazione" to editorial titles that already have their own
 * intent. `getSerpIntentLabel` now returns `null` for non-matching paths so
 * the experiment is skipped instead of tagging unrelated content.
 */
import { describe, it, expect, vi } from 'vitest';

const { getSerpIntentLabel } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');

describe('getSerpIntentLabel — calculator-only vocabulary (issue #5479)', () => {
  it('returns null for a blog article path (no generic fallback)', () => {
    expect(getSerpIntentLabel('/articoli-frontaliere/qualche-articolo/', 'it')).toBeNull();
    expect(getSerpIntentLabel('/en/articoli-frontaliere/qualche-articolo/', 'en')).toBeNull();
  });

  it('returns null for guide/listing paths with no calculator match', () => {
    expect(getSerpIntentLabel('/guida-frontaliere/permessi-di-lavoro/', 'it')).toBeNull();
    expect(getSerpIntentLabel('/cerca-lavoro-ticino/', 'it')).toBeNull();
  });

  it('still returns the real intent label for calculator paths, per locale', () => {
    expect(getSerpIntentLabel('/simulatore/oltre-20km/', 'it')).toBe('oltre 20km');
    expect(getSerpIntentLabel('/simulatore/entro-20km/', 'it')).toBe('entro 20km');
    expect(getSerpIntentLabel('/cambio-franco-euro/', 'it')).toBe('cambio CHF EUR');
    expect(getSerpIntentLabel('/calcola-previdenza/', 'it')).toBe('pensione frontalieri');
    expect(getSerpIntentLabel('/tasse-e-pensione/', 'it')).toBe('pensione frontalieri');

    expect(getSerpIntentLabel('/en/simulatore/oltre-20km/', 'en')).toBe('over 20km');
    expect(getSerpIntentLabel('/de/simulatore/oltre-20km/', 'de')).toBe('ueber 20km');
    expect(getSerpIntentLabel('/fr/simulatore/oltre-20km/', 'fr')).toBe('au-dela de 20km');
  });
});
