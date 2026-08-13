// #5536 — the saved-jobs digest card was a 14-line function rendering only
// title, company, canton and a CTA. The rewrite (renderJobCard) adds four
// fields measured as recoverable on real inventory (2.548-job sample,
// #5536 comment 2026-08-11): logo (72.9%), location (100%/99.96%),
// postedDate (98.67%) and sector/category (88.30%/100%). Every one of them
// must be independently conditional — a card with a hole for a missing
// field is worse than a card without that field (the issue's own wording).
//
// These tests are the regression guard: reverting renderJobCard to the old
// title/company/canton/CTA shape should turn every "field present" test red.
import { describe, expect, it } from 'vitest';
import { renderJobCard, formatPostedDate, getStrings } from '../scripts/send-saved-jobs-digest.mjs';

const s = getStrings('it');

// Real manifest entry (data/company-logos-manifest.json) so the logo path
// exercises the actual companyKey → CDN URL join instead of a mock.
const KNOWN_LOGO_COMPANY_KEY = 'abb-svizzera-sede-ticino';

function fullEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    title: 'Infermiere/a',
    company: 'ABB Svizzera (sede Ticino)',
    canton: 'TI',
    location: 'Lugano',
    postedDate: '2026-08-10',
    sector: 'Sanità',
    category: 'healthcare',
    companyKey: KNOWN_LOGO_COMPANY_KEY,
    url: 'https://frontaliereticino.ch/lavoro-ticino-infermiere/foo/',
    ...overrides,
  };
}

describe('saved-jobs digest — renderJobCard (#5536)', () => {
  it('renders all 8 fields when every data point is present: title, company, CTA, logo, location, date, sector (+ canton available)', () => {
    const html = renderJobCard(fullEntry(), 'it', s, { expired: false });
    // Original 4
    expect(html).toContain('Infermiere/a'); // title
    expect(html).toContain('ABB Svizzera (sede Ticino)'); // company
    expect(html).toContain('Vedi annuncio'); // CTA
    // New 4
    expect(html).toMatch(/<img src="https:\/\/cdn\.frontaliereticino\.ch\/images\/brands\/abb-svizzera-sede-ticino\.png"/); // logo
    expect(html).toContain('Lugano'); // location
    expect(html).toContain('Pubblicato il'); // date label
    expect(html).toContain('Sanità'); // sector
  });

  it('logo: falls back to a coloured initial-letter avatar when companyKey has no manifest hit — never a broken/blank image', () => {
    const html = renderJobCard(fullEntry({ companyKey: 'no-such-company-xyz' }), 'it', s, { expired: false });
    expect(html).not.toContain('<img');
    expect(html).toMatch(/>A<\/div>/); // initial of "ABB Svizzera…"
  });

  it('logo: falls back to initial when companyKey itself is missing', () => {
    const html = renderJobCard(fullEntry({ companyKey: null }), 'it', s, { expired: false });
    expect(html).not.toContain('<img');
  });

  it('location: falls back to canton when location is absent, instead of dropping the line', () => {
    const html = renderJobCard(fullEntry({ location: null }), 'it', s, { expired: false });
    expect(html).toContain('TI');
  });

  it('location: omits the separator entirely when both location and canton are absent (no dangling " · ")', () => {
    const html = renderJobCard(fullEntry({ location: null, canton: null }), 'it', s, { expired: false });
    expect(html).not.toMatch(/presso ABB Svizzera \(sede Ticino\)\s*·/);
  });

  it('date: omits the date tag entirely when postedDate is absent (no synthetic date invented)', () => {
    const html = renderJobCard(fullEntry({ postedDate: null }), 'it', s, { expired: false });
    expect(html).not.toContain('Pubblicato il');
  });

  it('date: omits the tag when postedDate is unparseable rather than rendering "Invalid Date"', () => {
    const html = renderJobCard(fullEntry({ postedDate: 'not-a-date' }), 'it', s, { expired: false });
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain('Pubblicato il');
  });

  it('sector: falls back to category when sector is absent, so the tag is present whenever ANY classification exists', () => {
    const html = renderJobCard(fullEntry({ sector: null, category: 'healthcare' }), 'it', s, { expired: false });
    expect(html).toContain('healthcare');
  });

  it('sector: omits the tag when neither sector nor category exist (never a 0%-coverage field)', () => {
    const html = renderJobCard(fullEntry({ sector: null, category: null }), 'it', s, { expired: false });
    expect(html).not.toContain('healthcare');
    expect(html).not.toContain('Sanità');
  });

  it('expired jobs render without logo/location/date but keep the persisted category as sector', () => {
    const html = renderJobCard(
      { id: 'job-2', title: 'Old listing', company: 'Some Co', canton: 'TI', sector: 'finance' },
      'it',
      s,
      { expired: true },
    );
    expect(html).toContain('Annuncio scaduto');
    expect(html).not.toContain('<img');
    expect(html).toContain('finance'); // sector carried from the persisted entry.category
    expect(html).not.toContain('Pubblicato il'); // no live postedDate for an expired job
  });

  it('every locale renders its own "posted on" label', () => {
    const en = renderJobCard(fullEntry(), 'en', getStrings('en'), { expired: false });
    const de = renderJobCard(fullEntry(), 'de', getStrings('de'), { expired: false });
    const fr = renderJobCard(fullEntry(), 'fr', getStrings('fr'), { expired: false });
    expect(en).toContain('Posted on');
    expect(de).toContain('Veröffentlicht am');
    expect(fr).toContain('Publié le');
  });
});

describe('saved-jobs digest — formatPostedDate (#5536)', () => {
  it('formats a plain ISO date', () => {
    expect(formatPostedDate('2026-08-10', 'it')).not.toBe('');
  });

  it('returns "" for empty/missing input (caller must omit the field, not render nothing useful)', () => {
    expect(formatPostedDate(null, 'it')).toBe('');
    expect(formatPostedDate('', 'it')).toBe('');
    expect(formatPostedDate(undefined, 'it')).toBe('');
  });

  it('returns "" for unparseable input rather than "Invalid Date"', () => {
    expect(formatPostedDate('not-a-date', 'it')).toBe('');
  });

  it('parses ambiguous DD/MM/YY via the shared #2630-safe parser, not native Date', () => {
    // 05/06/26 is 5 June 2026 in DD/MM — native `new Date('05/06/26')` would
    // misread it as 6 May (US MM/DD). formatPostedDate must go through
    // parseDateField, so the day should stay 5 and the month June.
    const label = formatPostedDate('05/06/26', 'it');
    expect(label).not.toBe('');
    expect(label.toLowerCase()).toContain('giu'); // "giu" (giugno) not "mag" (maggio)
  });
});
