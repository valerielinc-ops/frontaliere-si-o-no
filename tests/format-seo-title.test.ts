/**
 * Unit tests for the Phase 3A SEO title/H1 helpers in
 * `build-plugins/shared/seoContentTokens.ts`.
 *
 * Semrush W2 (issue 102) requires every `<title>` to be ≤60 characters.
 * `formatSeoTitle()` enforces that budget by progressively dropping the
 * optional `qualifier` → `year` → `count` → `location` while always
 * preserving `keyword`. `clampSiteSuffix()` only adds the " | {brand}"
 * suffix when it still fits the budget.
 *
 * Semrush W3 (issue 105) requires the page H1 to differ from the title.
 * `formatSeoH1()` returns a narrative variant that is structurally
 * different from a keyword-first title.
 */
import { describe, it, expect } from 'vitest';
import {
  clampSiteSuffix,
  differentiateH1FromTitle,
  formatSeoH1,
  formatSeoTitle,
} from '@/build-plugins/shared/seoContentTokens';

describe('formatSeoTitle', () => {
  it('returns the bare keyword when nothing else is provided', () => {
    expect(formatSeoTitle({ keyword: 'Lavoro Infermieri' })).toBe('Lavoro Infermieri');
  });

  it('joins keyword + location + year + qualifier when all fit in 60 chars', () => {
    const out = formatSeoTitle({
      keyword: 'Lavoro Educatori',
      location: 'Ticino',
      year: '2026',
      qualifier: '35 offerte',
    });
    expect(out).toBe('Lavoro Educatori Ticino 2026 — 35 offerte');
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('drops the qualifier first when over the budget', () => {
    const out = formatSeoTitle({
      keyword: 'Offerte Lavoro Sanità Privata',
      location: 'Cantone Ticino',
      year: '2026',
      qualifier: 'aggiornate ogni giorno alle 06:00 UTC',
    });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).not.toContain('aggiornate ogni giorno');
    expect(out).toContain('Offerte Lavoro Sanità Privata');
  });

  it('drops the year next when keyword + location + year still overflow', () => {
    const out = formatSeoTitle({
      keyword: 'Offerte di Lavoro per Pflegepersonal Specializzato',
      location: 'Cantone Ticino',
      year: '2026',
    });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain('Pflegepersonal Specializzato');
  });

  it('drops the location last, before truncation', () => {
    const out = formatSeoTitle({
      keyword: 'Offerte di Lavoro per Operatori Socio-Educativi Diplomati',
      location: 'Tutto il Cantone Ticino',
    });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).not.toContain('Cantone Ticino');
  });

  it('returns the bare keyword when even keyword alone is over budget (no truncation)', () => {
    const longKw = 'A'.repeat(80);
    const out = formatSeoTitle({ keyword: longKw, location: 'Ticino' });
    // We never silently truncate the mandatory keyword — return as-is.
    expect(out).toBe(longKw);
  });

  it('strips leading emoji prefixes from the keyword', () => {
    const out = formatSeoTitle({
      keyword: '🔥 Offerte di Lavoro Case Anziani',
      location: 'Ticino',
      year: '2026',
    });
    expect(out.startsWith('🔥')).toBe(false);
    expect(out).toContain('Offerte di Lavoro Case Anziani');
  });

  it('honors a custom maxLength budget', () => {
    const out = formatSeoTitle({
      keyword: 'Offerte Lavoro',
      location: 'Ticino',
      year: '2026',
      qualifier: '990 offerte',
      maxLength: 35,
    });
    expect(out.length).toBeLessThanOrEqual(35);
  });

  it('handles a large numeric count without inflating the title', () => {
    const out = formatSeoTitle({
      keyword: 'Lavoro Case Anziani',
      location: 'Ticino',
      count: 1234567,
      year: '2026',
    });
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('returns empty string for empty keyword input', () => {
    expect(formatSeoTitle({ keyword: '' })).toBe('');
    expect(formatSeoTitle({ keyword: '   ' })).toBe('');
  });
});

describe('clampSiteSuffix', () => {
  it('appends the suffix when the combined string fits the budget', () => {
    expect(clampSiteSuffix('Lavoro Educatori Ticino', 'Frontaliere Ticino')).toBe(
      'Lavoro Educatori Ticino | Frontaliere Ticino',
    );
  });

  it('always appends the suffix verbatim — uniqueness > SERP length budget', () => {
    // Semrush "Duplicate <title>" + "Duplicate H1 and title tags" rules
    // are deploy-blocking; "title too long" is soft. Letting the title
    // overflow the 60-char budget is the lesser evil because truncating
    // the headline risks collapsing distinct pages to the same SERP-
    // clamped title when the unique fragment (city, age, address) lives
    // at the end. The function therefore always returns
    // `${base} | ${suffix}` regardless of the advisory `maxLength`.
    const long = 'Lavoro Case Anziani Ticino 2026 — 990 offerte attive oggi';
    expect(clampSiteSuffix(long, 'Frontaliere Ticino')).toBe(
      `${long} | Frontaliere Ticino`,
    );
  });

  it('returns the base unchanged when the suffix is empty', () => {
    expect(clampSiteSuffix('Test', '')).toBe('Test');
  });

  it('ignores the maxLength parameter (it is now advisory)', () => {
    expect(clampSiteSuffix('Short', 'Frontaliere Ticino', 100)).toBe(
      'Short | Frontaliere Ticino',
    );
    // Even a tiny "budget" still gets the suffix appended — uniqueness wins.
    expect(clampSiteSuffix('Short', 'Frontaliere Ticino', 10)).toBe(
      'Short | Frontaliere Ticino',
    );
  });
});

describe('formatSeoH1', () => {
  it('returns a narrative H1 with count when available (it locale)', () => {
    const out = formatSeoH1({
      locale: 'it',
      keyword: 'Case Anziani',
      location: 'Ticino',
      count: 990,
    });
    expect(out).toBe('990 offerte attive per Case Anziani in Ticino');
  });

  it('returns keyword + location only when no count is given', () => {
    const out = formatSeoH1({
      locale: 'it',
      keyword: 'Case Anziani',
      location: 'Ticino',
    });
    expect(out).toBe('Case Anziani in Ticino');
  });

  it('uses locale-specific narrative templates', () => {
    expect(
      formatSeoH1({ locale: 'en', keyword: 'Nurses', location: 'Ticino', count: 35 }),
    ).toBe('35 active openings for Nurses in Ticino');
    expect(
      formatSeoH1({ locale: 'de', keyword: 'Pflegepersonal', location: 'Tessin', count: 35 }),
    ).toBe('35 aktive Stellen Pflegepersonal in Tessin');
    expect(
      formatSeoH1({
        locale: 'fr',
        keyword: 'Infirmiers',
        location: 'Tessin',
        count: 35,
      }),
    ).toBe('35 offres actives pour Infirmiers au Tessin');
  });

  it('appends a separator+noun when the H1 would otherwise equal the title', () => {
    const out = formatSeoH1({
      locale: 'it',
      keyword: 'Lavoro Educatori',
      title: 'Lavoro Educatori',
    });
    expect(out.toLowerCase()).not.toBe('Lavoro Educatori'.toLowerCase());
    expect(out).toContain('Lavoro Educatori');
  });
});

describe('differentiateH1FromTitle', () => {
  const COSTO = 'Costo della vita Bellinzona 2026: affitti, spesa, trasporti';
  const TITLE_WITH_BRAND = `${COSTO} | Frontaliere Ticino`;

  it('returns the H1 verbatim when it already differs from the title', () => {
    const h1 = 'Quanto costa vivere a Bellinzona';
    expect(differentiateH1FromTitle(h1, TITLE_WITH_BRAND, 'it')).toBe(h1);
  });

  it('appends an IT differentiator when title (after brand-strip) ≡ H1', () => {
    const out = differentiateH1FromTitle(COSTO, TITLE_WITH_BRAND, 'it');
    expect(out).not.toBe(COSTO);
    expect(out.toLowerCase()).not.toBe(COSTO.toLowerCase());
    expect(out).toContain(COSTO);
    expect(out).toMatch(/\(guida frontaliere\)$/);
  });

  it('handles a brand-stripped title (no trailing " | Frontaliere Ticino")', () => {
    // The audit normalises both sides — a title that already lost its brand
    // suffix (because buildTitleWithBrand dropped it) must still be detected.
    const out = differentiateH1FromTitle(COSTO, COSTO, 'it');
    expect(out).not.toBe(COSTO);
    expect(out).toMatch(/\(guida frontaliere\)$/);
  });

  it('uses locale-specific tags for en/de/fr', () => {
    const en = differentiateH1FromTitle('About Us — Frontaliere Ticino: Cross-Border Workers Guide', 'About Us — Frontaliere Ticino: Cross-Border Workers Guide', 'en');
    expect(en).toMatch(/\(cross-border guide\)$/);
    const de = differentiateH1FromTitle('Lebenshaltungskosten Bellinzona 2026', 'Lebenshaltungskosten Bellinzona 2026', 'de');
    expect(de).toMatch(/\(Grenzgänger-Leitfaden\)$/);
    const fr = differentiateH1FromTitle('Coût de la vie à Bellinzona 2026', 'Coût de la vie à Bellinzona 2026', 'fr');
    expect(fr).toMatch(/\(guide frontalier\)$/);
  });

  it('is case + whitespace insensitive when comparing', () => {
    const h1 = '  Costo  della  vita  Bellinzona  2026  ';
    const title = 'COSTO DELLA VITA BELLINZONA 2026';
    const out = differentiateH1FromTitle(h1, title, 'it');
    expect(out).toMatch(/\(guida frontaliere\)$/);
  });

  it('returns the H1 verbatim when either input is empty', () => {
    expect(differentiateH1FromTitle('', 'Some title', 'it')).toBe('');
    expect(differentiateH1FromTitle('Some H1', '', 'it')).toBe('Some H1');
  });
});
