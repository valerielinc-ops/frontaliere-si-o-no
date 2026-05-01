/**
 * Graubündner Kantonalbank (GKB) — Umantis ATS crawler parser tests
 *
 * Tests parseGkbListingPage(), parseGkbDetailPage(), extractLocation(),
 * parseDate(), isGkbJob(), isTrustedDomain() using HTML fixtures mirroring
 * the real Umantis ATS page structure at tenant 2607.
 */
import { describe, it, expect } from 'vitest';

import {
  GKB_KEY,
  GKB_COMPANY_NAME,
  isGkbJob,
  isTrustedDomain,
  parseGkbListingPage,
  parseGkbDetailPage,
  extractLocation,
  parseDate,
} from '../scripts/lib/gkb-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Fixtures: listing page ──────────────────────────────────────────────

const FIXTURE_LISTING_HTML = `<!DOCTYPE html>
<html class="ger Overview" lang="de">
<head><title>GKB JobService Stellenmarkt</title></head>
<body>
<table>
  <caption class="visually-hidden"></caption>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_text tableaslist_element_1152486">&nbsp;&nbsp;Graub&uuml;ndner Kantonalbank</span>
        <span class="tableaslist_text tableaslist_element_1152487">&nbsp;|&nbsp;Online seit: 10.04.2026<br /> </span>
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/1912/Description/1" class="HSTableLinkSubTitle" aria-label="Specialist Payments Services (80-100%)">Specialist Payments Services (80-100%)</a>
        </span>
        <span class="tableaslist_text tableaslist_element_1152489"> </span>
        <span class="tableaslist_subtitle tableaslist_element_1152490">&nbsp;|&nbsp;Stellennummer: 1912</span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492"></span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">&nbsp;|&nbsp;Einstieg als: Fachspezialist:in</span>
        <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Unternehmensbereich:  Banking Services &amp; Operations / LDSE</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Hauptsitz Chur</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;Digital Banking &amp; Services</span>
        <span class="tableaslist_subtitle tableaslist_element_1152497"></span>
        <span class="tableaslist_text tableaslist_element_1152500"><a href="/Vacancies/1912/Application/CheckLogin/1" class="HSTableLink">Jetzt bewerben</a></span><br />
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow2">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_text tableaslist_element_1152486">&nbsp;&nbsp;Graub&uuml;ndner Kantonalbank</span>
        <span class="tableaslist_text tableaslist_element_1152487">&nbsp;|&nbsp;Online seit: 09.04.2026<br /> </span>
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/1898/Description/1" class="HSTableLinkSubTitle" aria-label="Berater:in Privatkunden  (60%)">Berater:in Privatkunden  (60%)</a>
        </span>
        <span class="tableaslist_text tableaslist_element_1152489"> </span>
        <span class="tableaslist_subtitle tableaslist_element_1152490">&nbsp;|&nbsp;Stellennummer: 1898</span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492"></span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">&nbsp;|&nbsp;Einstieg als: Assistent:in, Kundenberater:in</span>
        <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Unternehmensbereich:  Region Thusis / RTHU</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Region Thusis</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;M&auml;rkte</span>
        <span class="tableaslist_subtitle tableaslist_element_1152497"></span>
        <span class="tableaslist_text tableaslist_element_1152500"><a href="/Vacancies/1898/Application/CheckLogin/1" class="HSTableLink">Jetzt bewerben</a></span><br />
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_text tableaslist_element_1152486">&nbsp;&nbsp;Graub&uuml;ndner Kantonalbank</span>
        <span class="tableaslist_text tableaslist_element_1152487">&nbsp;|&nbsp;Online seit: 20.01.2026<br /> </span>
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/1879/Description/1" class="HSTableLinkSubTitle" aria-label="Teilzeitstudent:in Externe Verm&ouml;gensverwalter, Chur (60%) ">Teilzeitstudent:in Externe Verm&ouml;gensverwalter, Chur (60%) </a>
        </span>
        <span class="tableaslist_text tableaslist_element_1152489"> </span>
        <span class="tableaslist_subtitle tableaslist_element_1152490">&nbsp;|&nbsp;Stellennummer: 1879</span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Teilzeit 60%</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492"></span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">&nbsp;|&nbsp;Einstieg als: Kundenberater:in</span>
        <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Unternehmensbereich:  Private Banking / MIVV</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Hauptsitz Chur</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;M&auml;rkte</span>
        <span class="tableaslist_subtitle tableaslist_element_1152497"></span>
        <span class="tableaslist_text tableaslist_element_1152500"><a href="/Vacancies/1879/Application/CheckLogin/1" class="HSTableLink">Jetzt bewerben</a></span><br />
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;

// ─── Fixture: detail page ─────────────────────────────────────────────────

const FIXTURE_DETAIL_PAGE = `<!DOCTYPE html>
<html class="ger" lang="de">
<head>
  <meta name="keywords" content="Abacus-Umantis, human resources, hr solutions, Umantis">
  <title>Specialist Payments Services (80-100%)  | GKB JobService</title>
</head>
<body>
  <h1 class="contenttitle" id="contenttitle_3570">Specialist Payments Services (80-100%)</h1>
  <div class="container_content_NoAB">
    <div class="show_column_fullwidth">
      <div class="showblock_boundary">
        <div class="showblock" id="datablock_67071">
          <div class="showblock_textblock" id="datablockelement_67071">
            <div class="tooltip_hover_area">
              <div class="customdatablock" id="customdatablock_26525">Graub&uuml;ndner Kantonalbank&nbsp;|&nbsp;online seit: 10.04.2026&nbsp;</div>
            </div>
          </div>
        </div>
      </div>
      <div class="showblock_boundary">
        <div class="showblock" id="datablock_67074">
          <div class="showblock_textblock" id="datablockelement_67074">
            <div class="tooltip_hover_area">
              <div class="customdatablock" id="customdatablock_3574"></div>
              <div class="customdatablock" id="customdatablock_3575">"Wie auch immer deine Zukunft aussehen wird. Wir bei der Graub&uuml;ndner Kantonalbank sorgen daf&uuml;r, dass es nicht irgendeine Zukunft wird, sondern die beste Zukunft aller Zeiten."<br><br>Du bist motiviert, im Thema Payments Zeichen zu setzen und unsere Kunden mit deiner Dienstleistungsbereitschaft und deinem Engagement zu begeistern? Dann werde Teil unseres Teams und hilf mit, das Thema Payments weiterzuentwickeln.<br></div>
            </div>
          </div>
        </div>
      </div>
      <div class="showblock_boundary">
        <div class="showblock" id="datablock_67075">
          <div class="showblock_textblock" id="datablockelement_67075">
            <div class="tooltip_hover_area">
              <div class="customdatablock" id="customdatablock_3577"></div>
              <div class="customdatablock" id="customdatablock_3578"><ul>  <li>Sicherstellung des reibungslosen Betriebes und der kontinuierliche Optimierung unserer Payment-Prozesse</li>  <li>Bearbeitung elektronischer und physischer Zahlungsauftr&auml;ge</li>  <li>Unterst&uuml;tzung der Berater:innen und Kund:innen bei allen Fragen rund um das Thema Payments</li></ul></div>
            </div>
          </div>
        </div>
      </div>
      <div class="showblock_boundary">
        <div class="showblock" id="datablock_67076">
          <div class="showblock_textblock" id="datablockelement_67076">
            <div class="tooltip_hover_area">
              <div class="customdatablock" id="customdatablock_3580"></div>
              <div class="customdatablock" id="customdatablock_3581"><ul>  <li>Erfahrungen im Payments und Motivation, deine Fachkompetenz im Payments weiter auszubauen</li>  <li>Selbst&auml;ndige, qualit&auml;tsbewusste und serviceorientierte Arbeitsweise</li>  <li>Teamplayer mit einer positiven Einstellung</li></ul></div>
            </div>
          </div>
        </div>
      </div>
      <div class="showblock_boundary">
        <div class="showblock" id="datablock_67077">
          <div class="showblock_textblock" id="datablockelement_67077">
            <div class="tooltip_hover_area">
              <div class="customdatablock" id="customdatablock_3583"></div>
              <div class="customdatablock" id="customdatablock_3584">Bist du bereit f&uuml;r deine beste Zukunft? Dann bewirb dich jetzt.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Graubündner Kantonalbank crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GKB_KEY).toBe('gkb');
    expect(GKB_COMPANY_NAME).toBe('Graubündner Kantonalbank');
  });

  // ── isGkbJob ──
  describe('isGkbJob', () => {
    it('matches by companyKey', () => {
      expect(isGkbJob({ companyKey: 'gkb' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGkbJob({ company: 'Graubündner Kantonalbank' })).toBe(true);
    });

    it('matches by company name without diacritics', () => {
      expect(isGkbJob({ company: 'Graubundner Kantonalbank' })).toBe(true);
    });

    it('matches by gkb.ch URL', () => {
      expect(isGkbJob({ url: 'https://gkb.ch/jobs/123' })).toBe(true);
    });

    it('matches by Umantis URL', () => {
      expect(isGkbJob({ url: 'https://recruitingapp-2607.umantis.com/Vacancies/1912/Description/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGkbJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGkbJob(null)).toBe(false);
      expect(isGkbJob(undefined)).toBe(false);
      expect(isGkbJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts gkb.ch', () => {
      expect(isTrustedDomain('https://gkb.ch/careers/job-123')).toBe(true);
    });

    it('trusts gkb.ch subdomains', () => {
      expect(isTrustedDomain('https://careers.gkb.ch/job/456')).toBe(true);
    });

    it('trusts umantis.com subdomains', () => {
      expect(isTrustedDomain('https://recruitingapp-2607.umantis.com/Vacancies/1912/Description/1')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseGkbListingPage ──
  describe('parseGkbListingPage', () => {
    const listings = parseGkbListingPage(FIXTURE_LISTING_HTML);

    it('parses correct number of listings', () => {
      expect(listings).toHaveLength(3);
    });

    it('extracts vacancy IDs', () => {
      expect(listings.map((l) => l.vacancyId)).toEqual(['1912', '1898', '1879']);
    });

    it('extracts titles correctly', () => {
      expect(listings[0].title).toBe('Specialist Payments Services (80-100%)');
      expect(listings[1].title).toBe('Berater:in Privatkunden (60%)');
      expect(listings[2].title).toContain('Teilzeitstudent:in Externe Vermögensverwalter');
    });

    it('extracts locations', () => {
      expect(listings[0].location).toBe('Chur');
      expect(listings[1].location).toBe('Thusis');
      expect(listings[2].location).toBe('Chur');
    });

    it('extracts departments', () => {
      expect(listings[0].department).toContain('Banking Services');
      expect(listings[1].department).toContain('Region Thusis');
    });

    it('extracts division', () => {
      expect(listings[0].division).toContain('Digital Banking');
      expect(listings[1].division).toBe('Märkte');
    });

    it('extracts employment type text', () => {
      expect(listings[0].artText).toBe('Vollzeit');
      expect(listings[2].artText).toContain('Teilzeit');
    });

    it('extracts posted dates in ISO format', () => {
      expect(listings[0].postedDate).toBe('2026-04-10');
      expect(listings[1].postedDate).toBe('2026-04-09');
      expect(listings[2].postedDate).toBe('2026-01-20');
    });

    it('builds correct detail URLs', () => {
      expect(listings[0].detailUrl).toBe('https://recruitingapp-2607.umantis.com/Vacancies/1912/Description/1');
    });

    it('builds /Default fetch URLs for parseable detail pages', () => {
      // /Description/1 serves a custom Foundation template (no customdatablock)
      // for Lehrstellen; /Default forces the standard ATS template.
      expect(listings[0].fetchUrl).toBe('https://recruitingapp-2607.umantis.com/Vacancies/1912/Description/1/Default');
    });

    it('builds correct apply URLs', () => {
      expect(listings[0].applyUrl).toBe('https://recruitingapp-2607.umantis.com/Vacancies/1912/Application/CheckLogin/1');
    });

    it('deduplicates by vacancy ID', () => {
      // Duplicate the first row
      const dupeHtml = FIXTURE_LISTING_HTML.replace(
        '</table>',
        `<tr class="tableaslist_contentrow2">
          <td class="tableaslist_cell"><div class="tableaslist_cell">
            <span class="tableaslist_subtitle tableaslist_element_1152488">
              <a href="/Vacancies/1912/Description/1" class="HSTableLinkSubTitle">Specialist Payments Services (80-100%)</a>
            </span>
            <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Hauptsitz Chur</span>
            <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
          </div></td>
        </tr></table>`
      );
      const result = parseGkbListingPage(dupeHtml);
      const ids = result.map((r) => r.vacancyId);
      expect(ids.filter((id) => id === '1912')).toHaveLength(1);
    });

    it('returns empty array for empty/invalid HTML', () => {
      expect(parseGkbListingPage('')).toEqual([]);
      expect(parseGkbListingPage('<html><body></body></html>')).toEqual([]);
    });

    it('skips initiative application entries', () => {
      const initHtml = `<table>
        <tr class="tableaslist_contentrow1"><td class="tableaslist_cell"><div class="tableaslist_cell">
          <span class="tableaslist_subtitle tableaslist_element_1152488">
            <a href="/Vacancies/9999/Description/1" class="HSTableLinkSubTitle">Initiativbewerbung</a>
          </span>
          <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Hauptsitz Chur</span>
          <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        </div></td></tr>
      </table>`;
      expect(parseGkbListingPage(initHtml)).toEqual([]);
    });
  });

  // ── parseGkbDetailPage ──
  describe('parseGkbDetailPage', () => {
    const detail = parseGkbDetailPage(FIXTURE_DETAIL_PAGE, 'Fallback Title');

    it('extracts title from h1', () => {
      expect(detail.title).toBe('Specialist Payments Services (80-100%)');
    });

    it('extracts description content', () => {
      expect(detail.description).toBeTruthy();
      expect(detail.description.length).toBeGreaterThan(100);
    });

    it('description includes intro text', () => {
      expect(detail.description).toContain('Zukunft');
    });

    it('description includes tasks', () => {
      expect(detail.description).toContain('Payment-Prozesse');
    });

    it('description includes requirements', () => {
      expect(detail.description).toContain('Erfahrungen im Payments');
    });

    it('description includes closing text', () => {
      expect(detail.description).toContain('bewirb dich jetzt');
    });

    it('uses fallback title when h1 is missing', () => {
      const noH1 = '<html><body><div class="customdatablock" title="">Some description text that is long enough</div></body></html>';
      const result = parseGkbDetailPage(noH1, 'My Fallback');
      expect(result.title).toBe('My Fallback');
    });

    it('handles empty HTML gracefully', () => {
      const result = parseGkbDetailPage('', 'Default');
      expect(result.title).toBe('Default');
      expect(result.description).toBe('');
    });

    it('returns empty description for the Foundation/Lehrstelle template', () => {
      // /Vacancies/{ID}/Description/1 (without /Default) serves a stripped
      // GKB-themed Foundation template with no customdatablock markers — this
      // is exactly why fetchUrl must use /Default.
      const foundationHtml = `<!doctype html><html><body>
        <div class="large-8 medium-7 columns">
          <p>Intro text from Lehrstelle template.</p>
          <p><h1>Mediamatiker:in in Chur (Lehrbeginn 2027)</h1></p>
          <p><strong>Deine Aufgaben.</strong><br/>Apprenticeship body.</p>
        </div></body></html>`;
      const result = parseGkbDetailPage(foundationHtml, 'Mediamatiker:in');
      expect(result.description).toBe('');
    });
  });

  // ── extractLocation ──
  describe('extractLocation', () => {
    it('extracts city from "Hauptsitz Chur"', () => {
      expect(extractLocation('Hauptsitz Chur')).toBe('Chur');
    });

    it('extracts city from "Region Thusis"', () => {
      expect(extractLocation('Region Thusis')).toBe('Thusis');
    });

    it('extracts city from "Region Arosa"', () => {
      expect(extractLocation('Region Arosa')).toBe('Arosa');
    });

    it('extracts city from "Filiale Davos"', () => {
      expect(extractLocation('Filiale Davos')).toBe('Davos');
    });

    it('defaults to Chur for empty input', () => {
      expect(extractLocation('')).toBe('Chur');
    });

    it('handles pipe prefix from listing', () => {
      expect(extractLocation('|  Hauptsitz Chur')).toBe('Chur');
    });
  });

  // ── parseDate ──
  describe('parseDate', () => {
    it('converts DD.MM.YYYY to YYYY-MM-DD', () => {
      expect(parseDate('10.04.2026')).toBe('2026-04-10');
    });

    it('handles date in surrounding text', () => {
      expect(parseDate('Online seit: 09.04.2026')).toBe('2026-04-09');
    });

    it('returns empty string for invalid input', () => {
      expect(parseDate('')).toBe('');
      expect(parseDate('invalid')).toBe('');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Specialist Payments Services (80-100%)');
      expect(slug).toContain('specialist-payments-services');
    });

    it('strips diacritics', () => {
      expect(slugify('Vermögensverwalter')).toBe('vermogensverwalter');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer gkb ch')).toBe('developer-gkb-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'gkb-abc123def456',
      slug: 'specialist-payments-services-80-100-gkb-ch',
      slugByLocale: { de: 'specialist-payments-services-80-100-gkb-ch' },
      company: 'Graubündner Kantonalbank',
      companyKey: 'gkb',
      companyDomain: 'gkb.ch',
      title: 'Specialist Payments Services (80-100%)',
      titleByLocale: { de: 'Specialist Payments Services (80-100%)' },
      description: 'A test job description for validation that is long enough.',
      descriptionByLocale: { de: 'A test job description for validation that is long enough.' },
      location: 'Chur',
      canton: 'GR',
      url: 'https://recruitingapp-2607.umantis.com/Vacancies/1912/Description/1',
      source: 'Graubündner Kantonalbank Dedicated Parser (Umantis)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Chur',
      postalCode: '7000',
      addressCountry: 'CH',
      country: 'CH',
      sector: 'Finanza / Banca',
      currency: 'CHF',
      employmentType: 'FULL_TIME',
      applyUrl: 'https://recruitingapp-2607.umantis.com/Vacancies/1912/Application/CheckLogin/1',
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
      expect(validJob.id).toMatch(/^gkb-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is GR', () => {
      expect(validJob.canton).toBe('GR');
    });

    it('sector is banking', () => {
      expect(validJob.sector).toBe('Finanza / Banca');
    });

    it('URL is on trusted Umantis domain', () => {
      expect(isTrustedDomain(validJob.url)).toBe(true);
      expect(isTrustedDomain(validJob.applyUrl)).toBe(true);
    });
  });
});
