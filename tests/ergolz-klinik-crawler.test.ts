import { describe, it, expect } from 'vitest';
import {
  ERGOLZ_KLINIK_KEY,
  ERGOLZ_KLINIK_COMPANY_NAME,
  ERGOLZ_KLINIK_CAREERS_URL,
  isErgolzKlinikJob,
  isTrustedDomain,
  parseListing,
  cleanErgolzKlinikTitle,
  buildErgolzKlinikDescription,
} from '../scripts/lib/ergolz-klinik-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<div class="page">
  <header><h1>Karriere bei der Ergolz Klinik</h1></header>
  <div class="elementor-element">
    <h4>Herztherapeut/in, 40 - 60%</h4>
    <p>Veröffentlicht vor 2 Tagen</p>
    <a class="elementor-button" href="https://ergolz.cardiance.com/wp-content/uploads/sites/4/2026/04/260211_Stellenausschreibung-Physiotherapie_TM.pdf">
      <span>Mehr Informationen</span>
    </a>
  </div>
  <div class="elementor-element">
    <h4>Dipl. Pflegefachperson Anästhesie 60% - 80%</h4>
    <p>Veröffentlicht vor 2 Wochen</p>
    <a class="elementor-button" href="https://ergolz.cardiance.com/wp-content/uploads/sites/4/2026/04/Inserat-Anasthesie-Pflege-60-80.pdf">
      <span>Mehr Informationen</span>
    </a>
  </div>
</div>
`;

describe('Ergolz Klinik crawler parser', () => {
  it('exports valid constants', () => {
    expect(ERGOLZ_KLINIK_KEY).toBe('ergolz-klinik');
    expect(ERGOLZ_KLINIK_COMPANY_NAME).toBe('Ergolz Klinik');
    expect(ERGOLZ_KLINIK_CAREERS_URL).toMatch(/^https:\/\/ergolz\.cardiance\.com\//);
  });

  describe('isErgolzKlinikJob', () => {
    it('matches by companyKey', () => {
      expect(isErgolzKlinikJob({ companyKey: 'ergolz-klinik' })).toBe(true);
    });
    it('matches by company name', () => {
      expect(isErgolzKlinikJob({ company: 'Ergolz Klinik' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isErgolzKlinikJob({ url: 'https://ergolz.cardiance.com/wp-content/x.pdf' })).toBe(
        true
      );
    });
    it('rejects unrelated jobs', () => {
      expect(isErgolzKlinikJob({ companyKey: 'other', url: 'https://other.com' })).toBe(false);
    });
    it('handles null', () => {
      expect(isErgolzKlinikJob(null)).toBe(false);
      expect(isErgolzKlinikJob({})).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts primary subdomain', () => {
      expect(isTrustedDomain('https://ergolz.cardiance.com/x.pdf')).toBe(true);
    });
    it('rejects parent cardiance.com (different tenant)', () => {
      expect(isTrustedDomain('https://cardiance.com/job/x')).toBe(false);
    });
    it('rejects unrelated domain', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('cleanErgolzKlinikTitle', () => {
    it('strips html and collapses whitespace', () => {
      expect(cleanErgolzKlinikTitle('  <b>Herztherapeut/in,   40 - 60%</b>  ')).toBe(
        'Herztherapeut/in, 40 - 60%'
      );
    });
    it('strips (m/w/d) suffix', () => {
      expect(cleanErgolzKlinikTitle('Pflegefachperson (m/w/d)')).toBe('Pflegefachperson');
    });
    it('returns empty string for blank input', () => {
      expect(cleanErgolzKlinikTitle('')).toBe('');
    });
  });

  describe('parseListing', () => {
    it('extracts both PDF postings with the H4 heading as title', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows.length).toBe(2);
      expect(rows[0].title).toBe('Herztherapeut/in, 40 - 60%');
      expect(rows[1].title).toBe('Dipl. Pflegefachperson Anästhesie 60% - 80%');
      expect(rows[0].pdfUrl).toMatch(/Physiotherapie_TM\.pdf$/);
      expect(rows[1].pdfUrl).toMatch(/Anasthesie-Pflege/);
    });
    it('produces an identifier from the PDF filename', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows[0].identifier).toBe('260211_Stellenausschreibung-Physiotherapie_TM');
    });
    it('dedupes identical PDF URLs', () => {
      const html =
        '<div><h4>Same Job</h4><a href="https://ergolz.cardiance.com/wp/x.pdf">PDF</a></div>' +
        '<div><h4>Other Job</h4><a href="https://ergolz.cardiance.com/wp/x.pdf">PDF</a></div>';
      const rows = parseListing(html);
      expect(rows.length).toBe(1);
    });
    it('falls back to filename if no preceding heading exists', () => {
      const html = '<div><a href="https://ergolz.cardiance.com/wp/Bare_File.pdf">PDF</a></div>';
      const rows = parseListing(html);
      expect(rows.length).toBe(1);
      expect(rows[0].title.toLowerCase()).toContain('bare');
    });
    it('does not pick up the page H1 as a job title', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) {
        expect(row.title.toLowerCase()).not.toMatch(/karriere bei der ergolz/);
      }
    });
    it('returns empty array on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('buildErgolzKlinikDescription', () => {
    const realPdfBody =
      'Wir suchen für unser Team. '.repeat(20) +
      'Ihre Aufgaben: Patientenbetreuung, Therapie, Dokumentation. ' +
      'Ihre Anforderungen: Diplom HF / FH, Berufserfahrung.';

    it('embeds intro + PDF text + footer when PDF is rich enough', () => {
      const out = buildErgolzKlinikDescription({
        title: 'Herztherapeut/in 40-60%',
        pdfText: realPdfBody,
        pdfUrl: 'https://ergolz.cardiance.com/wp/x.pdf',
      });
      expect(out).toContain('Ergolz Klinik');
      expect(out).toContain('Herztherapeut');
      expect(out).toContain('Ihre Aufgaben');
      expect(out).toContain('https://ergolz.cardiance.com/wp/x.pdf');
      expect(out.length).toBeGreaterThan(400);
    });
    it('falls back gracefully when PDF text is empty', () => {
      const out = buildErgolzKlinikDescription({
        title: 'Test Position',
        pdfText: '',
        pdfUrl: 'https://ergolz.cardiance.com/wp/empty.pdf',
      });
      expect(out).toContain('Ergolz Klinik');
      expect(out).toContain('Test Position');
    });
    it('caps output length below 7000 chars', () => {
      const huge = 'A'.repeat(20000);
      const out = buildErgolzKlinikDescription({
        title: 'Long Position',
        pdfText: huge,
        pdfUrl: 'https://ergolz.cardiance.com/wp/long.pdf',
      });
      expect(out.length).toBeLessThanOrEqual(7000);
    });
  });

  describe('slugify', () => {
    it('handles diacritics + slash + percent', () => {
      expect(slugify('Dipl. Pflegefachperson Anästhesie 60% - 80%')).toBe(
        'dipl-pflegefachperson-anasthesie-60-80'
      );
    });
    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });
});
