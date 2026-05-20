import { describe, it, expect } from 'vitest';
import {
  ENTERO_KEY,
  ENTERO_COMPANY_NAME,
  ENTERO_CAREERS_URL,
  isEnteroJob,
  isTrustedDomain,
  parseListing,
  parseDetail,
  resolveSite,
  ENTERO_SITES,
} from '../scripts/lib/entero-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<section>
  <h2>Offene Stellen</h2>
  <div>
    <h3>Dipl. Pflegfachperson HF Psychiatrie (w/m/d) Schwerpunkt Sucht (60–80%)</h3>
    <a href="/de/karriere/dipl-pflegfachperson-hf-psychiatrie-w-m-d-schwerpunkt-sucht-6080">Details</a>
  </div>
  <div>
    <h3>Agogische Mitarbeiterin/Mitarbeiter mit Flair für Reinigung und Hotellerie (80 – 100%)</h3>
    <a href="/de/karriere/agogische-mitarbeiterin-mitarbeiter-mit-flair-fuer-reinigung-und-hotellerie-80-100">Details</a>
  </div>
  <div>
    <h3>Leiter/in Finanz- und Rechnungswesen (60 – 80%)</h3>
    <a href="/de/karriere/leiter-in-finanz-und-rechnungswesen-mitglied-der-geschaeftsleitung-60-80">Details</a>
  </div>
  <!-- Menu link to the careers page itself — must NOT be picked as a job -->
  <a href="/de/karriere">Karriere</a>
</section>
`;

const FIXTURE_DETAIL_HTML = `
<html><body>
<header><nav>Top menu</nav></header>
<main>
  <h1>Dipl. Pflegfachperson HF Psychiatrie (w/m/d) Schwerpunkt Sucht (60–80%)</h1>
  <p>Unsere Klinik ist spezialisiert auf die Langzeittherapie von Suchterkrankungen.</p>
  <p>Arbeitsort: Entwöhnung Egliswil</p>
  <h2>Deine Aufgaben</h2>
  <ul>
    <li>Betreuung von Suchtpatienten im psychiatrischen Setting</li>
    <li>Begleitung von Patientinnen und Patienten im Therapieprozess (4–6 Monate)</li>
  </ul>
  <h2>Anforderungsprofil</h2>
  <ul>
    <li>Abgeschlossene Ausbildung als Dipl. Pflegefachfrau/mann HF</li>
    <li>Berufserfahrung in der Psychiatrie</li>
  </ul>
  <h2>Fragen zur Bewerbung</h2>
  <p>Kontakt: Franziska Krauss — apply form scaffolding…</p>
</main>
<footer>Footer block</footer>
</body></html>
`;

describe('entero crawler parser', () => {
  it('exports valid constants', () => {
    expect(ENTERO_KEY).toBe('entero');
    expect(ENTERO_COMPANY_NAME).toBe('entero');
    expect(ENTERO_CAREERS_URL).toMatch(/^https:\/\/www\.entero\.ch\/de\/karriere/);
  });

  describe('isEnteroJob', () => {
    it('matches by companyKey', () => {
      expect(isEnteroJob({ companyKey: 'entero' })).toBe(true);
    });
    it('matches by company name "Stiftung entero …"', () => {
      expect(isEnteroJob({ company: 'Stiftung entero' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isEnteroJob({ url: 'https://www.entero.ch/de/karriere/x' })).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isEnteroJob({ companyKey: 'other' })).toBe(false);
      expect(isEnteroJob(null)).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts entero.ch', () => {
      expect(isTrustedDomain('https://www.entero.ch/de/karriere/x')).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
    });
  });

  describe('resolveSite', () => {
    it('routes Egliswil text to PC 5704', () => {
      expect(resolveSite('Arbeitsort: Entwöhnung Egliswil').postalCode).toBe('5704');
    });
    it('routes Niederlenz to 5702', () => {
      expect(resolveSite('Standort Entwöhnung Niederlenz').postalCode).toBe('5702');
    });
    it('routes Neuenhof to 5432', () => {
      expect(resolveSite('Entzug Neuenhof').postalCode).toBe('5432');
    });
    it('falls back to Egliswil when no site matches', () => {
      const out = resolveSite('no city mentioned here');
      expect(out.city).toBe('Egliswil');
      expect(out.postalCode).toBe('5704');
    });
    it('site list covers the 3 known entero sites', () => {
      const cities = ENTERO_SITES.map((s) => s.city);
      for (const c of ['Egliswil', 'Niederlenz', 'Neuenhof']) {
        expect(cities).toContain(c);
      }
    });
  });

  describe('parseListing', () => {
    it('extracts 3 job postings with title from preceding <h3>', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows.length).toBe(3);
      expect(rows[0].title).toMatch(/Dipl\. Pflegfachperson HF Psychiatrie/);
      expect(rows[0].slug).toBe(
        'dipl-pflegfachperson-hf-psychiatrie-w-m-d-schwerpunkt-sucht-6080'
      );
    });
    it('does NOT pick the menu anchor /de/karriere itself', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.url).not.toBe('https://www.entero.ch/de/karriere');
    });
    it('dedupes identical slugs', () => {
      const html =
        '<h3>A</h3><a href="/de/karriere/x">L1</a><h3>B</h3><a href="/de/karriere/x">L2</a>';
      expect(parseListing(html).length).toBe(1);
    });
    it('returns empty on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('parseDetail', () => {
    it('extracts title from <h1>', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.title).toMatch(/Dipl\. Pflegfachperson HF Psychiatrie/);
    });
    it('extracts main body and trims after "Fragen zur Bewerbung"', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.body).toContain('Deine Aufgaben');
      expect(d.body).toContain('Anforderungsprofil');
      expect(d.body).not.toContain('Kontakt: Franziska');
      expect(d.body).not.toContain('Footer block');
    });
    it('reads the Arbeitsort marker into siteText', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.siteText.toLowerCase()).toContain('egliswil');
    });
    it('handles empty input safely', () => {
      const d = parseDetail('');
      expect(d.title).toBe('');
      expect(d.body).toBe('');
    });
  });

  describe('slugify', () => {
    it('handles German diacritics + percent + parentheses', () => {
      expect(slugify('Dipl. Pflegfachperson HF (60-80%)')).toBe(
        'dipl-pflegfachperson-hf-60-80'
      );
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
