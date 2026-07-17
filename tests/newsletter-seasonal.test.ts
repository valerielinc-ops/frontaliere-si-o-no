import { describe, it, expect } from 'vitest';
import { getSeasonalUtilityContent } from '../services/newsletter-seasonal.mjs';

// One representative month per two-month bucket, per services/newsletter-seasonal.mjs's
// calendar doc comment.
const BUCKET_MONTHS = [
  { month: 0, label: 'Jan-Feb (TFR)', urlFragment: 'tfr' },
  { month: 2, label: 'Mar-Apr (Italian tax return)', urlFragment: 'dichiarazione-redditi-italia' },
  { month: 4, label: 'May-Jun (salary calculator)', urlFragment: 'calcola-stipendio' },
  { month: 6, label: 'Jul-Aug (permit quiz)', urlFragment: 'quiz-permesso' },
  { month: 8, label: 'Sep-Oct (3rd pillar)', urlFragment: 'terzo-pilastro' },
  { month: 10, label: 'Nov-Dec (tredicesima)', urlFragment: 'tredicesima' },
];

describe('getSeasonalUtilityContent', () => {
  it('returns a title/excerpt/url object for every month of the year', () => {
    for (let m = 0; m < 12; m++) {
      const result = getSeasonalUtilityContent(new Date(2026, m, 15), 'it');
      expect(typeof result.title).toBe('string');
      expect(result.title.length).toBeGreaterThan(0);
      expect(typeof result.excerpt).toBe('string');
      expect(result.excerpt.length).toBeGreaterThan(0);
      expect(typeof result.url).toBe('string');
    }
  });

  it('picks the expected real slug per seasonal bucket (Italian default)', () => {
    for (const { month, urlFragment } of BUCKET_MONTHS) {
      const result = getSeasonalUtilityContent(new Date(2026, month, 1), 'it');
      expect(result.url).toContain(urlFragment);
    }
  });

  it('always returns a trailing-slash URL', () => {
    for (let m = 0; m < 12; m++) {
      const result = getSeasonalUtilityContent(new Date(2026, m, 1), 'it');
      expect(result.url.endsWith('/')).toBe(true);
    }
  });

  it('groups consecutive months into the same 2-month bucket', () => {
    const jan = getSeasonalUtilityContent(new Date(2026, 0, 1), 'it');
    const feb = getSeasonalUtilityContent(new Date(2026, 1, 28), 'it');
    expect(jan.url).toBe(feb.url);
    expect(jan.title).toBe(feb.title);
  });

  it('changes content across bucket boundaries', () => {
    const feb = getSeasonalUtilityContent(new Date(2026, 1, 1), 'it');
    const mar = getSeasonalUtilityContent(new Date(2026, 2, 1), 'it');
    expect(feb.url).not.toBe(mar.url);
  });

  it('wraps December back into the Nov-Dec bucket (year-boundary safe)', () => {
    const dec = getSeasonalUtilityContent(new Date(2026, 11, 31), 'it');
    const nov = getSeasonalUtilityContent(new Date(2026, 10, 1), 'it');
    expect(dec.url).toBe(nov.url);
  });

  it('produces locale-prefixed URLs for en/de/fr and no prefix for it', () => {
    const it = getSeasonalUtilityContent(new Date(2026, 0, 1), 'it');
    const en = getSeasonalUtilityContent(new Date(2026, 0, 1), 'en');
    const de = getSeasonalUtilityContent(new Date(2026, 0, 1), 'de');
    const fr = getSeasonalUtilityContent(new Date(2026, 0, 1), 'fr');
    expect(it.url.startsWith('/en/')).toBe(false);
    expect(it.url.startsWith('/de/')).toBe(false);
    expect(it.url.startsWith('/fr/')).toBe(false);
    expect(en.url.startsWith('/en/')).toBe(true);
    expect(de.url.startsWith('/de/')).toBe(true);
    expect(fr.url.startsWith('/fr/')).toBe(true);
  });

  it('gives every locale distinct copy for the same month (no untranslated leakage)', () => {
    const results = ['it', 'en', 'de', 'fr'].map((l) => getSeasonalUtilityContent(new Date(2026, 3, 1), l));
    const titles = new Set(results.map((r) => r.title));
    const urls = new Set(results.map((r) => r.url));
    expect(titles.size).toBe(4);
    expect(urls.size).toBe(4);
  });

  it('falls back to Italian for an unknown/unsupported locale', () => {
    const it = getSeasonalUtilityContent(new Date(2026, 5, 1), 'it');
    const unknown = getSeasonalUtilityContent(new Date(2026, 5, 1), 'xx');
    expect(unknown.title).toBe(it.title);
    expect(unknown.url).toBe(it.url);
  });

  it('defaults to the current date and Italian locale when called with no args', () => {
    const result = getSeasonalUtilityContent();
    expect(typeof result.title).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
  });

  it('nests the spring tax-return link under the fisco hub, matching router.ts', () => {
    const result = getSeasonalUtilityContent(new Date(2026, 2, 1), 'it');
    expect(result.url).toBe('/tasse-e-pensione/dichiarazione-redditi-italia/');
  });
});
