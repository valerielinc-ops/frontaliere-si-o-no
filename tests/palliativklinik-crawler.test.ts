import { describe, it, expect } from 'vitest';
import {
  PALLIATIVKLINIK_KEY,
  PALLIATIVKLINIK_COMPANY_NAME,
  PALLIATIVKLINIK_CAREERS_URL,
  isPalliativklinikJob,
  isTrustedDomain,
  parseListing,
  cleanPalliativklinikTitle,
  buildPalliativklinikDescription,
} from '../scripts/lib/palliativklinik-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<div id="article">
  <p><strong><span style="color: #808080;"><a href="https://asafafuc.myhostpoint.ch/wp-content/uploads/2016/01/offene-stellen_2016.jpg"><img src="banner.jpg"/></a></span></strong></p>
  <p>&nbsp;</p>
  <p><span style="color: #808080;"><br /><strong><strong class="">Wir suchen per sofort oder nach Vereinbarung SPITALÄRZTIN/SPITALARZT/ 40 – 80%<br /><a href="http://palliativklinik.ch/wordpress/wp-content/uploads/2025/12/PKiP_AerztIn_Dez25.pdf" target="_blank" rel="noopener noreferrer"><span class="">Mehr Information siehe PDF</span></a></strong></strong></span></p>
  <p><span style="color: #808080;"><strong><strong class="">Wir suchen wir ab sofort oder nach Vereinbarung für unseren Ärzte-Pool Spitalärztin/Spitalarzt Palliative Care<br /><a href="http://palliativklinik.ch/wordpress/wp-content/uploads/2026/04/PKiP_Spitalarzt_April-26.pdf" target="_blank" rel="noopener noreferrer"><span class="">Mehr Information siehe PDF</span></a></strong></strong></span></p>
  <p><span style="color: #808080;"><strong><strong class="">Wir suchen per sofort oder nach Vereinbarung DIPL. PFLEGEFACHPERSON HF, 80 – 100%<br /></strong></strong><strong><strong class=""><a href="http://palliativklinik.ch/wordpress/wp-content/uploads/2025/11/PKiP_Pflegefach_Nov25-1.pdf" target="_blank" rel="noopener noreferrer"><span class="">Mehr Information siehe PDF</span></a></strong></strong><br /></span></p>
  <p><span style="color: #808080;"><strong><strong class="">Wir suchen per sofort oder nach Vereinbarung DIPL. PFLEGEFACHPERSONEN HF oder FACHPERSONEN GESUNDHEIT (FAGE) als Pool Mitarbeiter:innen</strong><br /></strong></span><span style="color: #808080;"><strong><a href="http://palliativklinik.ch/wordpress/wp-content/uploads/2025/11/PKiP_Pflege_FAGE-fach_Nov25.pdf" target="_blank" rel="noopener noreferrer"><span class="">Mehr Information siehe PDF</span></a></strong></span></p>
  <p><span style="color: #808080;"><strong><strong class="">Wir bieten ab 2026 MEDIZINSTUDENT:INNEN UNTERASSISTENZSTELLEN, 100% <br /></strong></strong><strong><strong class=""><a href="http://palliativklinik.ch/wordpress/wp-content/uploads/2025/12/PKiP_Medizinstudenten_Dez25.pdf" target="_blank" rel="noopener noreferrer"><span class="">Mehr Information siehe PDF</span></a></strong></strong><br /></span></p>
</div>
`;

describe('Palliativklinik im Park crawler parser', () => {
  it('exports valid constants', () => {
    expect(PALLIATIVKLINIK_KEY).toBe('palliativklinik');
    expect(PALLIATIVKLINIK_COMPANY_NAME).toBe('Palliativklinik im Park');
    expect(PALLIATIVKLINIK_CAREERS_URL).toMatch(/^https:\/\/palliativklinik\.ch\//);
  });

  describe('isPalliativklinikJob', () => {
    it('matches by companyKey', () => {
      expect(isPalliativklinikJob({ companyKey: 'palliativklinik' })).toBe(true);
    });
    it('matches by company name', () => {
      expect(isPalliativklinikJob({ company: 'Palliativklinik im Park' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isPalliativklinikJob({ url: 'https://palliativklinik.ch/foo' })).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isPalliativklinikJob({ companyKey: 'other', url: 'https://x.ch' })).toBe(false);
    });
    it('handles null', () => {
      expect(isPalliativklinikJob(null)).toBe(false);
      expect(isPalliativklinikJob({})).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://palliativklinik.ch/job/1')).toBe(true);
    });
    it('trusts legacy hostpoint mirror', () => {
      expect(isTrustedDomain('https://asafafuc.myhostpoint.ch/x.pdf')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('cleanPalliativklinikTitle', () => {
    it('drops "Wir suchen per sofort" preamble', () => {
      const out = cleanPalliativklinikTitle(
        'Wir suchen per sofort oder nach Vereinbarung SPITALÄRZTIN/SPITALARZT/ 40 – 80%'
      );
      expect(out.toLowerCase()).toContain('spitalärztin');
      expect(out.toLowerCase()).not.toMatch(/wir suchen/);
      expect(out).toContain('40 – 80%');
    });
    it('handles "Wir bieten ab 2026" preamble', () => {
      const out = cleanPalliativklinikTitle(
        'Wir bieten ab 2026 MEDIZINSTUDENT:INNEN UNTERASSISTENZSTELLEN, 100%'
      );
      expect(out.toLowerCase()).toContain('medizinstudent');
      expect(out.toLowerCase()).not.toMatch(/wir bieten/);
    });
    it('strips "Wir suchen wir ab sofort … für unseren Ärzte-Pool" multi-clause preamble', () => {
      const out = cleanPalliativklinikTitle(
        'Wir suchen wir ab sofort oder nach Vereinbarung für unseren Ärzte-Pool Spitalärztin/Spitalarzt Palliative Care'
      );
      expect(out.toLowerCase()).toMatch(/spitalärztin/);
      expect(out.toLowerCase()).not.toMatch(/wir suchen/);
      expect(out.toLowerCase()).not.toMatch(/ärzte-pool/);
      expect(out.toLowerCase()).not.toMatch(/^für/);
    });
    it('preserves known acronyms (HF, FAGE)', () => {
      const out = cleanPalliativklinikTitle(
        'Wir suchen DIPL. PFLEGEFACHPERSON HF, 80 – 100%'
      );
      expect(out).toMatch(/HF/);
    });
    it('returns empty for blank input', () => {
      expect(cleanPalliativklinikTitle('')).toBe('');
      expect(cleanPalliativklinikTitle('   ')).toBe('');
    });
  });

  describe('parseListing', () => {
    it('extracts every PKiP PDF posting from the offene-stellen HTML', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows.length).toBe(5);
      const identifiers = rows.map((r) => r.identifier).sort();
      expect(identifiers).toEqual(
        [
          'PKiP_AerztIn_Dez25',
          'PKiP_Medizinstudenten_Dez25',
          'PKiP_Pflege_FAGE-fach_Nov25',
          'PKiP_Pflegefach_Nov25-1',
          'PKiP_Spitalarzt_April-26',
        ].sort()
      );
    });
    it('upgrades http://palliativklinik.ch PDF URLs to https', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.pdfUrl).toMatch(/^https:\/\//);
    });
    it('skips paragraphs without a PKiP PDF link', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      // Banner image and empty <p> must not be picked up
      expect(rows.find((r) => r.pdfUrl.endsWith('.jpg'))).toBeUndefined();
    });
    it('dedupes identical PDF URLs (defensive)', () => {
      const html = `<p>Wir suchen SPITALÄRZTIN 100% <a href="https://palliativklinik.ch/wp/PKiP_x.pdf">PDF</a></p>
                    <p>Wir suchen SPITALÄRZTIN 100% <a href="https://palliativklinik.ch/wp/PKiP_x.pdf">PDF</a></p>`;
      const rows = parseListing(html);
      expect(rows.length).toBe(1);
    });
    it('produces non-empty titles for every row', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.title.length).toBeGreaterThan(3);
    });
    it('returns empty array on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('buildPalliativklinikDescription', () => {
    const realPdfBody =
      'Lorem ipsum dolor sit amet. '.repeat(40) +
      'Ihre Aufgaben: Pflege, Betreuung, Dokumentation. ' +
      'Ihre Anforderungen: Diplom HF, Berufserfahrung. ';

    it('embeds intro + PDF text + footer when PDF is rich enough', () => {
      const out = buildPalliativklinikDescription({
        title: 'Diplomierte Pflegefachperson HF 80–100%',
        pdfText: realPdfBody,
        pdfUrl: 'https://palliativklinik.ch/wp/PKiP_Pflegefach.pdf',
      });
      expect(out).toContain('Palliativklinik im Park');
      expect(out).toContain('Pflegefachperson');
      expect(out).toContain('Ihre Aufgaben');
      expect(out).toContain('PKiP_Pflegefach.pdf');
      expect(out.length).toBeGreaterThan(400);
    });
    it('falls back gracefully when PDF text is empty', () => {
      const out = buildPalliativklinikDescription({
        title: 'Test Position',
        pdfText: '',
        pdfUrl: 'https://palliativklinik.ch/wp/empty.pdf',
      });
      expect(out).toContain('Palliativklinik im Park');
      expect(out).toContain('Test Position');
    });
    it('caps output length below 7000 chars', () => {
      const huge = 'A'.repeat(20000);
      const out = buildPalliativklinikDescription({
        title: 'Long Position',
        pdfText: huge,
        pdfUrl: 'https://palliativklinik.ch/wp/long.pdf',
      });
      expect(out.length).toBeLessThanOrEqual(7000);
    });
  });

  describe('slugify', () => {
    it('strips diacritics + collapses to lowercase', () => {
      expect(slugify('Spitalärztin Palliative Care')).toBe('spitalarztin-palliative-care');
    });
    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });
});
