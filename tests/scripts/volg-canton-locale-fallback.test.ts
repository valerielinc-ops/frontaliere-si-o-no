/**
 * resolveCantonLocale / locale-aware detail-page parsing — regression.
 *
 * Root cause (evidenced via 15-day git-history audit of data/jobs/by-crawler/volg-fenaco.json):
 * update-volg-jobs.mjs is a CH-wide crawler (all 26 cantons), but buildJob() called
 * detectLang(title, 'de') with a hardcoded German fallback. For short/ambiguous titles
 * from French-speaking cantons (VS/VD/GE/NE/JU/FR), detectLanguageWithConfidence()'s
 * anti-noise safeguard (confidence < 0.15 && text.length < 50) returns the caller's
 * fallback verbatim instead of the (correctly, if noisily, detected) real language —
 * so sourceLang stuck at 'de' regardless of the title's actual language. Because
 * mergeLocaleTextMap() always lets fresh crawl data win the *source*-locale slot,
 * titleByLocale.de flapped between the raw (often French) scrape and a later AI
 * retranslation on every subsequent run (job volg-fenaco-e10e4b6174ca, 88 runs).
 *
 * parseDetailPage() had the same hardcoded-German-only assumption independently:
 * itemprop-based section extraction falls back to a literal label ('Aufgaben'/
 * 'Profil'/'Vorteile') when the itemprop block has no internal <h2-4> heading —
 * confirmed live (jobs.fenaco.com detail pages: 'lang=' URL param is telemetry-only,
 * content is byte-identical across lang values) that this hardcoded label, not the
 * source page, is what injects German section headers into French/Italian-canton
 * job descriptions.
 *
 * Fix: both derive their locale from the job's canton via CANTON_LOCALE_FALLBACK
 * instead of a hardcoded 'de'.
 */
import { describe, it, expect } from 'vitest';

// Mirrors CANTON_LOCALE_FALLBACK / resolveCantonLocale in scripts/update-volg-jobs.mjs.
// Replicated (not imported) because that module runs main() unconditionally at
// top level with no import.meta.url guard — importing it would trigger a live
// crawl. Same convention as the existing tests/volg-crawler.test.ts.
const CANTON_LOCALE_FALLBACK: Record<string, string> = {
  GE: 'fr', VD: 'fr', NE: 'fr', JU: 'fr', VS: 'fr', FR: 'fr',
  TI: 'it',
};

function resolveCantonLocale(canton = ''): string {
  return CANTON_LOCALE_FALLBACK[canton] || 'de';
}

const sectionLabelsByLocale: Record<string, Record<string, string>> = {
  de: { responsibilities: 'Aufgaben', qualifications: 'Profil', incentives: 'Vorteile' },
  fr: { responsibilities: 'Missions', qualifications: 'Profil', incentives: 'Avantages' },
  it: { responsibilities: 'Mansioni', qualifications: 'Profilo', incentives: 'Vantaggi' },
};

function resolveSectionLabels(locale: string) {
  return sectionLabelsByLocale[locale] || sectionLabelsByLocale.de;
}

describe('resolveCantonLocale()', () => {
  it('resolves French for the French-speaking cantons', () => {
    expect(resolveCantonLocale('VS')).toBe('fr');
    expect(resolveCantonLocale('VD')).toBe('fr');
    expect(resolveCantonLocale('GE')).toBe('fr');
    expect(resolveCantonLocale('NE')).toBe('fr');
    expect(resolveCantonLocale('JU')).toBe('fr');
    expect(resolveCantonLocale('FR')).toBe('fr');
  });

  it('resolves Italian for Ticino', () => {
    expect(resolveCantonLocale('TI')).toBe('it');
  });

  it('defaults to German for German-speaking and unknown cantons', () => {
    expect(resolveCantonLocale('ZH')).toBe('de');
    expect(resolveCantonLocale('BE')).toBe('de');
    expect(resolveCantonLocale('')).toBe('de');
    expect(resolveCantonLocale('XX')).toBe('de');
  });
});

describe('parseDetailPage section labels (locale-aware, not hardcoded German)', () => {
  it('uses German labels by default', () => {
    const labels = resolveSectionLabels('de');
    expect(labels.incentives).toBe('Vorteile');
  });

  it('uses French labels for fr locale (not German "Vorteile")', () => {
    const labels = resolveSectionLabels('fr');
    expect(labels.incentives).toBe('Avantages');
    expect(labels.responsibilities).toBe('Missions');
  });

  it('uses Italian labels for it locale', () => {
    const labels = resolveSectionLabels('it');
    expect(labels.incentives).toBe('Vantaggi');
    expect(labels.responsibilities).toBe('Mansioni');
  });
});
