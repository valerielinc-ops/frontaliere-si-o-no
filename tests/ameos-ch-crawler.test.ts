import { describe, it, expect } from 'vitest';
import {
  AMEOS_CH_KEY,
  AMEOS_CH_COMPANY_NAME,
  AMEOS_CH_CAREERS_URL,
  isAmeosChJob,
  isTrustedDomain,
  parseListing,
  filterChJobs,
  resolveAmeosChSite,
  parseDetail,
  AMEOS_CH_SITES,
  CH_SEARCH_TERMS,
} from '../scripts/lib/ameos-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<div class="results">
  <a href="/offene-stellen/stelle/889-oberarzt-psychiatrie-und-psychotherapie-in-brunnen">Oberarzt</a>
  <a href="/offene-stellen/stelle/586-lernende-als-kauffrau-kaufmann-gesundheit-efz-in-brunnen">Lernende</a>
  <a href="/offene-stellen/stelle/4006-corporate-accountant-in-z%C3%BCrich">Corporate Accountant</a>
  <a href="/offene-stellen/stelle/3449-ausbildungsplatz-als-rettungssanit%C3%A4ter-in-einsiedeln">Rettungssanitäter</a>
  <a href="/offene-stellen/stelle/220-assistenzarzt-in-weiterbildung-zum-facharzt-fuer-psychiatrie-und-psychotherapie">Assistenzarzt (no city in slug)</a>
  <a href="/offene-stellen/stelle/4339-altenpfleger-in-oberhausen">Altenpfleger Oberhausen (DE)</a>
</div>
`;

const FIXTURE_DETAIL_HTML = `
<html><body>
<header><nav>top</nav></header>
<main>
  <h1>Oberarzt Psychiatrie und Psychotherapie (m/w/d)</h1>
  <div id="c12345" class="frame frame-default frame-type-ameosjobs_jobshow">
    <style>main h1 { color:red; }</style>
    Oberarzt Psychiatrie und Psychotherapie (m/w/d)
    <p>Für unser AMEOS Seeklinikum Brunnen suchen wir per sofort einen Oberarzt mit Schwerpunkt Sucht.</p>
    <h2>Ihre Aufgaben</h2>
    <ul><li>Diagnostik</li><li>Therapie</li></ul>
    <h2>Ihre Vorteile</h2>
    <p>Attraktive Anstellung, Weiterbildung.</p>
  </div>
  <div class="frame-type-text">
    <p>Back-link section (must NOT be in body)</p>
  </div>
</main>
</body></html>
`;

describe('AMEOS Schweiz crawler parser', () => {
  it('exports valid constants', () => {
    expect(AMEOS_CH_KEY).toBe('ameos-ch');
    expect(AMEOS_CH_COMPANY_NAME).toBe('AMEOS Schweiz');
    expect(AMEOS_CH_CAREERS_URL).toMatch(/^https:\/\/karriere\.ameos\.eu\/offene-stellen/);
    expect(CH_SEARCH_TERMS).toContain('Brunnen');
    expect(CH_SEARCH_TERMS).toContain('Einsiedeln');
    expect(CH_SEARCH_TERMS).toContain('Zürich');
  });

  describe('isAmeosChJob', () => {
    it('matches by companyKey', () => {
      expect(isAmeosChJob({ companyKey: 'ameos-ch' })).toBe(true);
    });
    it('matches by company "AMEOS …" substring', () => {
      expect(isAmeosChJob({ company: 'AMEOS Seeklinikum Brunnen' })).toBe(true);
    });
    it('matches by karriere.ameos.eu URL', () => {
      expect(isAmeosChJob({ url: 'https://karriere.ameos.eu/offene-stellen/stelle/889-x' })).toBe(
        true
      );
    });
    it('rejects null and unrelated', () => {
      expect(isAmeosChJob(null)).toBe(false);
      expect(isAmeosChJob({ companyKey: 'other' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts karriere.ameos.eu', () => {
      expect(isTrustedDomain('https://karriere.ameos.eu/offene-stellen/x')).toBe(true);
    });
    it('trusts ameos.eu subdomains', () => {
      expect(isTrustedDomain('https://www.ameos.eu/x')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('resolveAmeosChSite', () => {
    it('matches Brunnen slug', () => {
      const out = resolveAmeosChSite('oberarzt-psychiatrie-und-psychotherapie-in-brunnen');
      expect(out?.city).toBe('Brunnen');
      expect(out?.canton).toBe('SZ');
      expect(out?.postalCode).toBe('6440');
    });
    it('matches Einsiedeln slug', () => {
      expect(resolveAmeosChSite('rettungssanitaeter-in-einsiedeln')?.city).toBe('Einsiedeln');
    });
    it('matches Zürich slug (url-encoded ü)', () => {
      const out = resolveAmeosChSite('corporate-accountant-in-z%C3%BCrich');
      expect(out?.city).toBe('Zürich');
      expect(out?.canton).toBe('ZH');
    });
    it('returns null for non-CH slugs', () => {
      expect(resolveAmeosChSite('pflegefachkraft-in-oberhausen')).toBeNull();
      expect(resolveAmeosChSite('assistenzarzt-in-weiterbildung')).toBeNull();
    });
    it('site list covers the 3 known CH sites', () => {
      const cities = AMEOS_CH_SITES.map((s) => s.city);
      for (const c of ['Brunnen', 'Einsiedeln', 'Zürich']) {
        expect(cities).toContain(c);
      }
    });
  });

  describe('parseListing', () => {
    it('extracts /stelle/{id}-{slug} rows with jobId', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      expect(rows.length).toBe(6);
      expect(rows.map((r) => r.jobId)).toEqual([
        '889', '586', '4006', '3449', '220', '4339',
      ]);
    });
    it('makes URLs absolute', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.url).toMatch(/^https:\/\/karriere\.ameos\.eu\//);
    });
    it('dedupes identical job IDs', () => {
      const html =
        '<a href="/offene-stellen/stelle/889-x">L1</a><a href="/offene-stellen/stelle/889-x">L2</a>';
      expect(parseListing(html).length).toBe(1);
    });
    it('returns empty on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('filterChJobs', () => {
    it('keeps only rows whose slug matches a CH site', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      const ch = filterChJobs(rows);
      expect(ch.length).toBe(4); // Brunnen×2 + Zürich + Einsiedeln
      const ids = ch.map((r) => r.jobId).sort();
      expect(ids).toEqual(['3449', '4006', '586', '889']);
    });
    it('drops German Oberhausen + generic Assistenzarzt rows', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      const ch = filterChJobs(rows);
      for (const row of ch) {
        expect(row.slug).not.toMatch(/-oberhausen$/);
        expect(row.slug).not.toBe('assistenzarzt-in-weiterbildung-zum-facharzt-fuer-psychiatrie-und-psychotherapie');
      }
    });
  });

  describe('parseDetail', () => {
    it('extracts H1 title', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.title).toMatch(/Oberarzt Psychiatrie und Psychotherapie/);
    });
    it('extracts body from frame-type-ameosjobs* container until next frame', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.body).toContain('Ihre Aufgaben');
      expect(d.body).toContain('Diagnostik');
      expect(d.body).toContain('Brunnen');
      expect(d.body).not.toContain('Back-link section');
    });
    it('strips inline <style> blocks from the body', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.body).not.toContain('color:red');
    });
    it('handles empty input safely', () => {
      const d = parseDetail('');
      expect(d.title).toBe('');
      expect(d.body).toBe('');
    });
  });

  describe('slugify', () => {
    it('handles German umlauts + parentheses', () => {
      expect(slugify('Oberarzt Psychiatrie und Psychotherapie (m/w/d)')).toBe(
        'oberarzt-psychiatrie-und-psychotherapie-m-w-d'
      );
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
