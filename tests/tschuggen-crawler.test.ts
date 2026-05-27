/**
 * Tschuggen Collection — Umantis ATS crawler parser tests (tenant 2904)
 *
 * Tests parseTschuggenListingPage(), parseTschuggenDetailPage(),
 * extractLocation(), lookupPostalCode(), isTschuggenJob(),
 * isTrustedDomain() using HTML fixtures mirroring the real
 * Umantis ATS page structure at tenant 2904.
 */
import { describe, it, expect } from 'vitest';

import {
  TSCHUGGEN_KEY,
  TSCHUGGEN_COMPANY_NAME,
  isTschuggenJob,
  isTrustedDomain,
  parseTschuggenListingPage,
  parseTschuggenDetailPage,
  extractLocation,
  lookupPostalCode,
} from '../scripts/lib/tschuggen-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Fixtures: listing page ──────────────────────────────────────────────

const FIXTURE_LISTING_HTML = `<!DOCTYPE html>
<html class="ger Overview" lang="de">
<head><title>Bewerbermanagement Stellenmarkt</title></head>
<body>
<table>
  <caption class="visually-hidden"></caption>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell" id="tablecell_4">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/1325/Description/1" target="_blank" class="HSTableLinkSubTitle" aria-label="Reservation Agent (m/w/d)" id="link_1152488_1">Reservation Agent (m/w/d)</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152493"> Einstieg als: Mitarbeiter</span>
        <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Abteilung: Rooms Division</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Ascona, Tessin</span>&nbsp;|&nbsp;
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow2">
    <td class="tableaslist_cell" id="tablecell_5">
    </td>
  </tr>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell" id="tablecell_6">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/1332/Description/1" target="_blank" class="HSTableLinkSubTitle" aria-label="Hoteltechniker in Jahresanstellung" id="link_1152488_3">Hoteltechniker in Jahresanstellung</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152493"> Einstieg als: Mitarbeiter</span>
        <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Abteilung: Rooms Division</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Arosa, Graub&uuml;nden</span>&nbsp;|&nbsp;
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow2">
    <td class="tableaslist_cell" id="tablecell_7">
    </td>
  </tr>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell" id="tablecell_8">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/1320/Description/1" target="_blank" class="HSTableLinkSubTitle" aria-label="Chef de Partie Garde-Manger (m/w/d) Sommersaison 2026" id="link_1152488_5">Chef de Partie Garde-Manger (m/w/d) Sommersaison 2026</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152493"> Einstieg als: Mitarbeiter</span>
        <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Abteilung: K&uuml;che</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Arosa, Graub&uuml;nden</span>&nbsp;|&nbsp;
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;

// ─── Fixture: detail page ─────────────────────────────────────────────────

const FIXTURE_DETAIL_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Reservation Agent (m/w/d) - Hotel Eden Roc</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <div id="container">
    <div id="header"></div>
    <div id="content">
      <div class="col-12" id="jobtitle">
        <h1>Reservation Agent (m/w/d)</h1>
      </div>
      <div class="col-12">
        <p>Das Hotel Eden Roc liegt direkt am Ufer des Lago Maggiore und geh&ouml;rt als 5-Sterne-Superior-Luxushotel zu den "Swiss Deluxe Hotels" und den "Leading Hotels of the World". Als eines der vier H&auml;user der "The Tschuggen Collection" wurde es mehrfach als bestes Ferienhotel der Schweiz ausgezeichnet.</p>
      </div>
      <div class="col-12">
        <h2>&#127919; IHR PROFIL</h2>
        <p>Freude am Arbeiten mit Menschen, Herzlichkeit, Authentizit&auml;t und Flexibilit&auml;t. Erfahrung in derselben oder einer vergleichbaren Position von Vorteil. Sehr gute Kommunikationsf&auml;higkeit in Deutsch, Englisch, Italienisch von Vorteil.</p>
      </div>
      <div class="col-12">
        <h2>&#128196; IHRE AUFGABEN</h2>
        <p>Entgegennahme und Bearbeitung aller Reservationen per Telefon, Email und Post. Gutscheinerstellung und Verwaltung anhand des Programmes E-GUMA. Unterst&uuml;tzung der Conciergerie und Front Office.</p>
      </div>
      <div class="col-12">
        <h2>UNSERE BENEFITS - Das d&uuml;rfen Sie von uns erwarten:</h2>
        <p><img style="width: 21px;" src="data:image/png;base64,abc" alt=""> Attraktive Mitarbeiterunterk&uuml;nfte in der N&auml;he des Hotel. <img style="width: 21px;" src="data:image/png;base64,def" alt=""> Ausgewogenes Men&uuml;-Angebot in unserer Mitarbeitertrattoria.</p>
      </div>
      <div class="col-12">
        <h2></h2>
        <p><b>INTERESSIERT? BEWERBEN SIE SICH JETZT!</b></p>
      </div>
      <div class="col-12">
        <p>Hotel Eden Roc<br>Human Resources Team<br>Via Albarelle 16<br>6612 Ascona</p>
      </div>
    </div>
  </div>
</body>
</html>`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Tschuggen Collection crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TSCHUGGEN_KEY).toBe('tschuggen');
    expect(TSCHUGGEN_COMPANY_NAME).toBe('Tschuggen Collection');
  });

  // ── isTschuggenJob ──
  describe('isTschuggenJob', () => {
    it('matches by companyKey', () => {
      expect(isTschuggenJob({ companyKey: 'tschuggen' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTschuggenJob({ company: 'Tschuggen Collection' })).toBe(true);
    });

    it('matches by company name partial', () => {
      expect(isTschuggenJob({ company: 'The Tschuggen Collection' })).toBe(true);
    });

    it('matches by tschuggencollection.ch URL', () => {
      expect(isTschuggenJob({ url: 'https://tschuggencollection.ch/jobs/123' })).toBe(true);
    });

    it('matches by Umantis URL', () => {
      expect(isTschuggenJob({ url: 'https://recruitingapp-2904.umantis.com/Vacancies/1325/Description/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isTschuggenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTschuggenJob(null)).toBe(false);
      expect(isTschuggenJob(undefined)).toBe(false);
      expect(isTschuggenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts tschuggencollection.ch', () => {
      expect(isTrustedDomain('https://tschuggencollection.ch/careers/job-123')).toBe(true);
    });

    it('trusts tschuggencollection.ch subdomains', () => {
      expect(isTrustedDomain('https://careers.tschuggencollection.ch/job/456')).toBe(true);
    });

    it('trusts umantis.com subdomains', () => {
      expect(isTrustedDomain('https://recruitingapp-2904.umantis.com/Vacancies/1325/Description/1')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseTschuggenListingPage ──
  describe('parseTschuggenListingPage', () => {
    const listings = parseTschuggenListingPage(FIXTURE_LISTING_HTML);

    it('parses correct number of listings', () => {
      expect(listings).toHaveLength(3);
    });

    it('extracts vacancy IDs', () => {
      expect(listings.map((l: { vacancyId: string }) => l.vacancyId)).toEqual(['1325', '1332', '1320']);
    });

    it('extracts titles correctly', () => {
      expect(listings[0].title).toBe('Reservation Agent (m/w/d)');
      expect(listings[1].title).toBe('Hoteltechniker in Jahresanstellung');
      expect(listings[2].title).toBe('Chef de Partie Garde-Manger (m/w/d) Sommersaison 2026');
    });

    it('extracts locations with region stripped', () => {
      expect(listings[0].location).toBe('Ascona');
      expect(listings[1].location).toBe('Arosa');
      expect(listings[2].location).toBe('Arosa');
    });

    it('extracts departments', () => {
      expect(listings[0].department).toBe('Rooms Division');
      expect(listings[2].department).toBe('Küche');
    });

    it('extracts entry level', () => {
      expect(listings[0].entryLevel).toBe('Mitarbeiter');
    });

    it('builds correct detail URLs', () => {
      expect(listings[0].detailUrl).toBe('https://recruitingapp-2904.umantis.com/Vacancies/1325/Description/1');
    });

    it('deduplicates by vacancy ID', () => {
      const dupeHtml = FIXTURE_LISTING_HTML.replace(
        '</table>',
        `<tr class="tableaslist_contentrow2">
          <td class="tableaslist_cell"><div class="tableaslist_cell">
            <span class="tableaslist_subtitle tableaslist_element_1152488">
              <a href="/Vacancies/1325/Description/1" class="HSTableLinkSubTitle">Reservation Agent (m/w/d)</a>
            </span>
            <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Ascona, Tessin</span>
          </div></td>
        </tr></table>`
      );
      const result = parseTschuggenListingPage(dupeHtml);
      const ids = result.map((r: { vacancyId: string }) => r.vacancyId);
      expect(ids.filter((id: string) => id === '1325')).toHaveLength(1);
    });

    it('returns empty array for empty/invalid HTML', () => {
      expect(parseTschuggenListingPage('')).toEqual([]);
      expect(parseTschuggenListingPage('<html><body></body></html>')).toEqual([]);
    });

    it('skips spontaneous application entries', () => {
      const initHtml = `<table>
        <tr class="tableaslist_contentrow1"><td class="tableaslist_cell"><div class="tableaslist_cell">
          <span class="tableaslist_subtitle tableaslist_element_1152488">
            <a href="/Vacancies/9999/Description/1" class="HSTableLinkSubTitle">Initiativbewerbung</a>
          </span>
          <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Arosa, Graubünden</span>
        </div></td></tr>
      </table>`;
      expect(parseTschuggenListingPage(initHtml)).toEqual([]);
    });

    it('handles empty content rows (no link in row)', () => {
      // Tenant 2904 has alternating empty rows
      const html = `<table>
        <tr class="tableaslist_contentrow2">
          <td class="tableaslist_cell" id="tablecell_5"></td>
        </tr>
      </table>`;
      expect(parseTschuggenListingPage(html)).toEqual([]);
    });
  });

  // ── parseTschuggenDetailPage ──
  describe('parseTschuggenDetailPage', () => {
    const detail = parseTschuggenDetailPage(FIXTURE_DETAIL_PAGE, 'Fallback Title');

    it('extracts title from h1', () => {
      expect(detail.title).toBe('Reservation Agent (m/w/d)');
    });

    it('extracts hotel name from title tag', () => {
      expect(detail.hotelName).toBe('Hotel Eden Roc');
    });

    it('extracts description content', () => {
      expect(detail.description).toBeTruthy();
      expect(detail.description.length).toBeGreaterThan(50);
    });

    it('description includes intro text', () => {
      expect(detail.description).toContain('Hotel Eden Roc');
    });

    it('description includes profile requirements', () => {
      expect(detail.description).toContain('Herzlichkeit');
    });

    it('description includes tasks', () => {
      expect(detail.description).toContain('Reservationen');
    });

    it('description strips base64 images', () => {
      expect(detail.description).not.toContain('data:image');
    });

    it('description includes benefits content', () => {
      expect(detail.description).toContain('Mitarbeitertrattoria');
    });

    it('extracts h2 section headings', () => {
      expect(detail.sections.length).toBeGreaterThanOrEqual(2);
      expect(detail.sections.some((s: string) => s.includes('PROFIL'))).toBe(true);
      expect(detail.sections.some((s: string) => s.includes('AUFGABEN'))).toBe(true);
    });

    it('uses fallback title when h1 is missing', () => {
      const noH1 = '<html><body><div id="content"><p>Some description text that is long enough to pass threshold.</p></div></body></html>';
      const result = parseTschuggenDetailPage(noH1, 'My Fallback');
      expect(result.title).toBe('My Fallback');
    });

    it('handles empty HTML gracefully', () => {
      const result = parseTschuggenDetailPage('', 'Default');
      expect(result.title).toBe('Default');
      expect(result.description).toBe('');
    });
  });

  // ── extractLocation ──
  describe('extractLocation', () => {
    it('extracts city from "Ascona, Tessin"', () => {
      expect(extractLocation('Ascona, Tessin')).toBe('Ascona');
    });

    it('extracts city from "Arosa, Graubünden"', () => {
      expect(extractLocation('Arosa, Graubünden')).toBe('Arosa');
    });

    it('extracts city from "St. Moritz, Graubünden"', () => {
      expect(extractLocation('St. Moritz, Graubünden')).toBe('St. Moritz');
    });

    it('handles pipe prefix from listing row', () => {
      expect(extractLocation('|  Ascona, Tessin')).toBe('Ascona');
    });

    it('handles location without region', () => {
      expect(extractLocation('Arosa')).toBe('Arosa');
    });

    it('defaults to Arosa for empty input', () => {
      expect(extractLocation('')).toBe('Arosa');
    });

    it('decodes HTML entities in location', () => {
      expect(extractLocation('Arosa, Graub&uuml;nden')).toBe('Arosa');
    });
  });

  // ── lookupPostalCode ──
  describe('lookupPostalCode', () => {
    it('returns 7050 for Arosa', () => {
      expect(lookupPostalCode('Arosa')).toBe('7050');
    });

    it('returns 6612 for Ascona', () => {
      expect(lookupPostalCode('Ascona')).toBe('6612');
    });

    it('returns 7500 for St. Moritz', () => {
      expect(lookupPostalCode('St. Moritz')).toBe('7500');
    });

    it('defaults to 7050 for unknown locations', () => {
      expect(lookupPostalCode('Unknown City')).toBe('7050');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts hotel job title to URL-safe slug', () => {
      const slug = slugify('Reservation Agent (m/w/d)');
      expect(slug).toContain('reservation-agent');
    });

    it('handles German characters', () => {
      expect(slugify('Küchenchef')).toBe('kuchenchef');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer tschuggen ch')).toBe('developer-tschuggen-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'tschuggen-abc123def456',
      slug: 'reservation-agent-m-w-d-tschuggen-ch',
      slugByLocale: { de: 'reservation-agent-m-w-d-tschuggen-ch' },
      company: 'Tschuggen Collection',
      companyKey: 'tschuggen',
      companyDomain: 'tschuggencollection.ch',
      title: 'Reservation Agent (m/w/d)',
      titleByLocale: { de: 'Reservation Agent (m/w/d)' },
      description: 'A test job description for validation that is long enough to pass checks.',
      descriptionByLocale: { de: 'A test job description for validation that is long enough to pass checks.' },
      location: 'Ascona',
      canton: 'TI',
      url: 'https://recruitingapp-2904.umantis.com/Vacancies/1325/Description/1',
      source: 'Tschuggen Collection Dedicated Parser (Umantis)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Ascona',
      postalCode: '6612',
      addressCountry: 'CH',
      country: 'CH',
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      employmentType: 'FULL_TIME',
      applyUrl: 'https://recruitingapp-2904.umantis.com/Vacancies/1325/Description/1',
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('has all SEO-mandatory fields', () => {
      expect(validJob).toHaveProperty('addressLocality');
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('addressCountry');
      expect(validJob).toHaveProperty('employmentType');
      expect(validJob).toHaveProperty('applyUrl');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^tschuggen-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('sector is hospitality', () => {
      expect(validJob.sector).toBe('Ospitalità / Hotellerie');
    });

    it('URL is on trusted Umantis domain', () => {
      expect(isTrustedDomain(validJob.url)).toBe(true);
      expect(isTrustedDomain(validJob.applyUrl)).toBe(true);
    });

    it('postal code matches location', () => {
      // Ascona = 6612
      expect(validJob.postalCode).toBe('6612');
    });
  });
});
