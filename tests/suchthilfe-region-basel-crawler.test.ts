import { describe, it, expect } from 'vitest';
import {
  SUCHTHILFE_REGION_BASEL_KEY,
  SUCHTHILFE_REGION_BASEL_COMPANY_NAME,
  SUCHTHILFE_REGION_BASEL_CAREERS_URL,
  isSuchthilfeRegionBaselJob,
  isTrustedDomain,
  parseListing,
  cleanSuchthilfeRegionBaselTitle,
  buildSuchthilfeRegionBaselDescription,
  inferLocationForPosting,
} from '../scripts/lib/suchthilfe-region-basel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<div class="button-set">
<div class="row">
    <div class="col-12 col-md-6 col-lg-4">
        <a href="https://www.suchthilfe.ch/wp-content/uploads/2026/05/PflegeHF_ESTA_2026.pdf" target="_blank" class="button-arrow">
            <span>Pflegefachperson HF/FH 70-90%</span>
        </a>
    </div>
    <div class="col-12 col-md-6 col-lg-4">
        <a href="https://www.suchthilfe.ch/wp-content/uploads/2026/04/Stelleninserat-Psychologie-08-2026.pdf" target="_blank" class="button-arrow">
            <span>Psycholog*in 60-70% im Beratungszentrum</span>
        </a>
    </div>
    <div class="col-12 col-md-6 col-lg-4">
        <a href="https://www.suchthilfe.ch/wp-content/uploads/2020/09/Gastfamilien_2020.pdf" target="_blank" class="button-arrow">
            <span>Gastfamilien für SPEKTRUM - Therapie in Gastfamilien</span>
        </a>
    </div>
</div>
</div>
`;

describe('Suchthilfe Region Basel crawler parser', () => {
  it('exports valid constants', () => {
    expect(SUCHTHILFE_REGION_BASEL_KEY).toBe('suchthilfe-region-basel');
    expect(SUCHTHILFE_REGION_BASEL_COMPANY_NAME).toBe('Suchthilfe Region Basel');
    expect(SUCHTHILFE_REGION_BASEL_CAREERS_URL).toMatch(/^https:\/\/www\.suchthilfe\.ch\/jobs\//);
  });

  describe('isSuchthilfeRegionBaselJob', () => {
    it('matches by companyKey', () => {
      expect(isSuchthilfeRegionBaselJob({ companyKey: 'suchthilfe-region-basel' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isSuchthilfeRegionBaselJob({ url: 'https://www.suchthilfe.ch/wp/x.pdf' })).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isSuchthilfeRegionBaselJob({ companyKey: 'other' })).toBe(false);
      expect(isSuchthilfeRegionBaselJob(null)).toBe(false);
      expect(isSuchthilfeRegionBaselJob({})).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts suchthilfe.ch', () => {
      expect(isTrustedDomain('https://www.suchthilfe.ch/wp/x.pdf')).toBe(true);
      expect(isTrustedDomain('https://suchthilfe.ch/jobs/')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('cleanSuchthilfeRegionBaselTitle', () => {
    it('strips html and collapses whitespace', () => {
      expect(cleanSuchthilfeRegionBaselTitle('  <b>Pflegefachperson  HF/FH  70-90%</b>')).toBe(
        'Pflegefachperson HF/FH 70-90%'
      );
    });
    it('strips (m/w/d) suffix', () => {
      expect(cleanSuchthilfeRegionBaselTitle('Sozialarbeiter (m/w/d)')).toBe('Sozialarbeiter');
    });
    it('returns empty for blank', () => {
      expect(cleanSuchthilfeRegionBaselTitle('')).toBe('');
    });
  });

  describe('inferLocationForPosting', () => {
    it('routes clinical Pflege roles to ESTA Reinach BL', () => {
      const loc = inferLocationForPosting({
        identifier: 'PflegeHF_ESTA_2026',
        title: 'Pflegefachperson HF/FH 70-90%',
      });
      expect(loc.city).toBe('Reinach');
      expect(loc.canton).toBe('BL');
    });
    it('routes administration/klinik roles to Reinach BL', () => {
      const loc = inferLocationForPosting({
        identifier: 'Stellenausschreibung_Kliniksekretariat',
        title: 'Mitarbeiter*in Klinikadministration 80-100%',
      });
      expect(loc.canton).toBe('BL');
    });
    it('routes Beratungszentrum / SPEKTRUM roles to Basel BS', () => {
      expect(
        inferLocationForPosting({
          identifier: 'Stelleninserat-Psychologie',
          title: 'Psycholog*in 60-70% im Beratungszentrum',
        }).canton
      ).toBe('BS');
      expect(
        inferLocationForPosting({
          identifier: 'Gastfamilien_2020',
          title: 'Gastfamilien für SPEKTRUM',
        }).canton
      ).toBe('BS');
    });
  });

  describe('parseListing', () => {
    it('extracts every button-arrow PDF posting with its span title', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows.length).toBe(3);
      expect(rows[0].title).toBe('Pflegefachperson HF/FH 70-90%');
      expect(rows[1].title).toBe('Psycholog*in 60-70% im Beratungszentrum');
      expect(rows[2].title).toBe('Gastfamilien für SPEKTRUM - Therapie in Gastfamilien');
    });
    it('decodes the PDF identifier from the URL filename', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows[0].identifier).toBe('PflegeHF_ESTA_2026');
    });
    it('dedupes identical PDF URLs', () => {
      const html =
        '<a href="https://www.suchthilfe.ch/wp/x.pdf" class="button-arrow"><span>Pflege 80%</span></a>' +
        '<a href="https://www.suchthilfe.ch/wp/x.pdf" class="button-arrow"><span>Pflege 80%</span></a>';
      const rows = parseListing(html);
      expect(rows.length).toBe(1);
    });
    it('ignores anchors that are not button-arrow', () => {
      const html =
        '<a href="https://www.suchthilfe.ch/wp/x.pdf" class="menu-link"><span>Junk</span></a>';
      expect(parseListing(html)).toEqual([]);
    });
    it('returns empty on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('buildSuchthilfeRegionBaselDescription', () => {
    const body =
      'Aufgaben: Pflege, Therapie, Dokumentation. '.repeat(15) +
      'Wir bieten ein engagiertes Team.';

    it('embeds intro + PDF text + footer when PDF rich enough', () => {
      const out = buildSuchthilfeRegionBaselDescription({
        title: 'Pflegefachperson HF/FH 70-90%',
        pdfText: body,
        pdfUrl: 'https://www.suchthilfe.ch/wp/x.pdf',
        location: { city: 'Reinach', canton: 'BL' },
      });
      expect(out).toContain('Suchthilfe Region Basel');
      expect(out).toContain('Pflegefachperson');
      expect(out).toContain('Reinach');
      expect(out).toContain('https://www.suchthilfe.ch/wp/x.pdf');
      expect(out.length).toBeGreaterThan(400);
    });
    it('falls back gracefully when PDF text is empty', () => {
      const out = buildSuchthilfeRegionBaselDescription({
        title: 'Test',
        pdfText: '',
        pdfUrl: 'https://www.suchthilfe.ch/wp/empty.pdf',
        location: { city: 'Basel', canton: 'BS' },
      });
      expect(out).toContain('Suchthilfe Region Basel');
      expect(out).toContain('Test');
    });
    it('caps output length below 7000 chars', () => {
      const out = buildSuchthilfeRegionBaselDescription({
        title: 'X',
        pdfText: 'A'.repeat(20000),
        pdfUrl: 'https://www.suchthilfe.ch/wp/x.pdf',
        location: { city: 'Basel', canton: 'BS' },
      });
      expect(out.length).toBeLessThanOrEqual(7000);
    });
  });

  describe('slugify', () => {
    it('handles asterisk + slash + percent', () => {
      expect(slugify('Psycholog*in 60-70% im Beratungszentrum')).toBe(
        'psycholog-in-60-70-im-beratungszentrum'
      );
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
