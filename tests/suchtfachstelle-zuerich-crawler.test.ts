import { describe, it, expect } from 'vitest';
import {
  SUCHTFACHSTELLE_ZUERICH_KEY,
  SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME,
  SUCHTFACHSTELLE_ZUERICH_CAREERS_URL,
  isSuchtfachstelleZuerichJob,
  isTrustedDomain,
  parseListing,
  parseDetail,
  cleanSfsTitle,
} from '../scripts/lib/suchtfachstelle-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<section>
  <h1>Offene Stellen</h1>
  <p>Wir freuen uns über Ihre Bewerbung.</p>
  <a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-fachperson-fuer-psychosoziale-suchtberatung-70">
    Stellenausschreibung: Fachperson für psychosoziale Suchtberatung 70 %
  </a>
  <a href="https://www.suchtfachstelle.zuerich/ueber-uns/team">Team</a>
  <a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-psychotherapeut-in-50">
    Stellenausschreibung: Psychotherapeut:in 50 %
  </a>
</section>
`;

const FIXTURE_DETAIL_HTML = `
<html><head>
  <title>Stellenausschreibung: Fachperson für psychosoziale Suchtberatung 70 %</title>
</head><body>
<header><nav>Top menu</nav></header>
<section>
<h2>Die Suchtfachstelle Zürich als Arbeitgeberin</h2>
<p>Beratung und Begleitung von Menschen mit risikoreichem Substanzkonsum oder einer Verhaltensabhängigkeit.</p>
<h3>Ihre Aufgaben</h3>
<ul>
  <li>Abklärung, psychosoziale Beratung und Krisenintervention</li>
  <li>Beratung von Angehörigen, Paaren und Familien</li>
</ul>
<h3>Ihr Profil</h3>
<p>Grundausbildung in Sozialer Arbeit und idealerweise eine beraterische Weiterbildung.</p>
<h3>Unser Angebot</h3>
<p>Attraktive Anstellungsbedingungen, Arbeitsort Josefstrasse 91, 8005 Zürich.</p>
<h3>Online-Bewerbung</h3>
<form>application form goes here</form>
</section>
<footer>Footer block</footer>
</body></html>
`;

describe('Suchtfachstelle Zürich crawler parser', () => {
  it('exports valid constants', () => {
    expect(SUCHTFACHSTELLE_ZUERICH_KEY).toBe('suchtfachstelle-zuerich');
    expect(SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME).toBe('Suchtfachstelle Zürich');
    expect(SUCHTFACHSTELLE_ZUERICH_CAREERS_URL).toMatch(
      /^https:\/\/www\.suchtfachstelle\.zuerich\/ueber-uns\/offene-stellen/
    );
  });

  describe('isSuchtfachstelleZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isSuchtfachstelleZuerichJob({ companyKey: 'suchtfachstelle-zuerich' })).toBe(true);
    });
    it('matches by company name', () => {
      expect(isSuchtfachstelleZuerichJob({ company: 'Suchtfachstelle Zürich' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(
        isSuchtfachstelleZuerichJob({ url: 'https://www.suchtfachstelle.zuerich/stelle-x' })
      ).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isSuchtfachstelleZuerichJob(null)).toBe(false);
      expect(isSuchtfachstelleZuerichJob({ companyKey: 'other' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts suchtfachstelle.zuerich (.zuerich TLD)', () => {
      expect(isTrustedDomain('https://www.suchtfachstelle.zuerich/x')).toBe(true);
    });
    it('rejects suchtfachstelle.ch / .com (different domain)', () => {
      expect(isTrustedDomain('https://www.suchtfachstelle.ch/x')).toBe(false);
    });
    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('cleanSfsTitle', () => {
    it('strips "Stellenausschreibung:" prefix', () => {
      expect(
        cleanSfsTitle('Stellenausschreibung: Fachperson für psychosoziale Suchtberatung 70 %')
      ).toBe('Fachperson für psychosoziale Suchtberatung 70 %');
    });
    it('strips HTML and collapses whitespace', () => {
      expect(cleanSfsTitle('  <b>Fachperson  Suchtberatung</b> ')).toBe(
        'Fachperson Suchtberatung'
      );
    });
    it('returns empty for blank', () => {
      expect(cleanSfsTitle('')).toBe('');
    });
  });

  describe('parseListing', () => {
    it('extracts /stellenausschreibung-* anchors', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows.length).toBe(2);
      expect(rows[0].slug).toBe('fachperson-fuer-psychosoziale-suchtberatung-70');
      expect(rows[1].slug).toBe('psychotherapeut-in-50');
    });
    it('does NOT pick non-job anchors (team, etc.)', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.url).toContain('/stellenausschreibung-');
    });
    it('dedupes identical slugs', () => {
      const html =
        '<a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-x">x1</a>' +
        '<a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-x">x2</a>';
      expect(parseListing(html).length).toBe(1);
    });
    it('returns empty on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('parseDetail', () => {
    it('extracts title from <title> + strips prefix', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.title).toBe('Fachperson für psychosoziale Suchtberatung 70 %');
    });
    it('extracts body from H1 to Online-Bewerbung marker', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.body).toContain('Ihre Aufgaben');
      expect(d.body).toContain('Ihr Profil');
      expect(d.body).toContain('Josefstrasse 91');
      expect(d.body).not.toContain('application form');
      expect(d.body).not.toContain('Footer block');
    });
    it('handles empty input safely', () => {
      const d = parseDetail('');
      expect(d.title).toBe('');
      expect(d.body).toBe('');
    });
  });

  describe('slugify', () => {
    it('handles diacritics, %, and colon', () => {
      expect(slugify('Fachperson für psychosoziale Suchtberatung 70 %')).toBe(
        'fachperson-fur-psychosoziale-suchtberatung-70'
      );
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
