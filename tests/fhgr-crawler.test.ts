/**
 * Fachhochschule Graubünden (FHGR) — Umantis ATS crawler parser tests
 *
 * Tests parseFhgrListingPage(), parseFhgrDetailPage(), extractLocation(),
 * isFhgrJob(), isTrustedDomain() using HTML fixtures mirroring
 * the real Umantis ATS page structure at tenant 2865.
 */
import { describe, it, expect } from 'vitest';

import {
  FHGR_KEY,
  FHGR_COMPANY_NAME,
  isFhgrJob,
  isTrustedDomain,
  parseFhgrListingPage,
  parseFhgrDetailPage,
  extractLocation,
} from '../scripts/lib/fhgr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Fixtures: listing page ──────────────────────────────────────────────

const FIXTURE_LISTING_HTML = `<!DOCTYPE html>
<html class="ger Overview" lang="de">
<head><title>Bewerbermanagement Stellenmarkt</title></head>
<body>
<table>
  <caption class="visually-hidden"></caption>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/774/Description/1" class="HSTableLinkSubTitle" aria-label="Studienleiter/-in &laquo;Business Administration Studienrichtung New Business&raquo;">Studienleiter/-in &laquo;Business Administration Studienrichtung New Business&raquo;</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492">&nbsp;|&nbsp;Befristung: Unbefristet</span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">&nbsp;|&nbsp;Einstieg als: Dozent/in, Kader</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Chur</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;Abteilung/Institut:  Schweizerisches Institut f&uuml;r Entrepreneurship (SIFE)</span>
        <span class="tableaslist_text tableaslist_element_1152498">Sie &uuml;bernehmen die Gesamtverantwortung f&uuml;r den Studiengang.</span>
        <br />
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow2">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/735/Description/1" class="HSTableLinkSubTitle" aria-label="Instandhaltungsfachperson (100 %)">Instandhaltungsfachperson (100 %)</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492">&nbsp;|&nbsp;Befristung: Unbefristet</span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Chur</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;Abteilung/Institut:  Services</span>
        <span class="tableaslist_text tableaslist_element_1152498">In dieser vielseitigen Funktion stellen Sie den reibungslosen Betrieb sicher.</span>
        <br />
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow1">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/749/Description/1" class="HSTableLinkSubTitle" aria-label="Bauingenieur:in">Bauingenieur:in</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492">&nbsp;|&nbsp;Befristung: Befristet</span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">&nbsp;|&nbsp;Einstieg als: Wissenschaftliche/r Mitarbeiter/in</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Chur</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;Abteilung/Institut:  Institut f&uuml;r Bauen im alpinen Raum (IBAR)</span>
        <span class="tableaslist_text tableaslist_element_1152498">In dieser Funktion haben Sie die Gelegenheit bei verschiedenen Projekten mitzuwirken.</span>
        <br />
      </div>
    </td>
  </tr>
  <tr class="tableaslist_contentrow2">
    <td class="tableaslist_cell">
      <div class="tableaslist_cell">
        <span class="tableaslist_subtitle tableaslist_element_1152488">
          <a href="/Vacancies/739/Description/1" class="HSTableLinkSubTitle" aria-label="Lehrstelle Architekturmodellbauer:in EFZ">Lehrstelle Architekturmodellbauer:in EFZ</a>
        </span>
        <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        <span class="tableaslist_subtitle tableaslist_element_1152492">&nbsp;|&nbsp;Befristung: Befristet</span>
        <span class="tableaslist_subtitle tableaslist_element_1152493">&nbsp;|&nbsp;Einstieg als: Lernende/r</span>
        <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Chur</span>
        <span class="tableaslist_subtitle tableaslist_element_1152496">&nbsp;|&nbsp;Abteilung/Institut: Zentrale Dienste</span>
        <span class="tableaslist_text tableaslist_element_1152498">W&auml;hrend deiner Lehre stellst du massstabs- und naturgetreue Modelle her.</span>
        <br />
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
  <meta name="ATS" content="Abacus-Umantis">
  <title>Studienleiter/-in «Business Administration Studienrichtung New Business»</title>
</head>
<body>
  <div class="puptitel1">
    <h1><b>Studienleiter/-in &laquo;Business Administration Studienrichtung New Business&raquo;</b></h1>
  </div>
  <div class="einleitung" id="einschub">
    Als Hochschule setzt die FH Graub&uuml;nden auf dynamisches Denken und proaktives Handeln. Unsere &uuml;ber 2400 Studierenden in Aus- und Weiterbildung entwickeln wir zu verantwortungsvollen Pers&ouml;nlichkeiten. F&uuml;r unser Schweizerisches Institut f&uuml;r Entrepreneurship (SIFE) suchen wir ab sofort eine engagierte Pers&ouml;nlichkeit als
  </div>
  <div class="pub2_untertitel" id="einschub">
    Studienleiter/-in
  </div>
  <div class="text" id="einschub">
    Sie &uuml;bernehmen die Gesamtverantwortung f&uuml;r den Studiengang Master of Science in Business Administration mit der Studienrichtung New Business und gestalten dessen strategische und inhaltliche Weiterentwicklung aktiv und zukunftsorientiert mit. Dabei f&uuml;hren Sie den Studiengang operativ, stellen eine hohe Qualit&auml;t sicher und tragen die personelle, organisatorische und finanzielle Verantwortung.
  </div>
  <div class="text" id="einschub">
    <b>Ihr Profil</b><br><ul><li>Konsekutives Masterstudium in Betriebswirtschaftslehre</li><li>Nachgewiesene F&uuml;hrungserfahrung und Budgetverantwortung</li><li>Forschungserfahrung und Praxisexpertise in Business und Supply Chain Transformation</li><li>Sehr gute Deutsch und Englischkenntnisse</li></ul>
  </div>
  <div class="text" id="einschub">
    <b>Wir begeistern Sie mit</b><br><ul><li>unserem dynamischen Teamspirit und unserer pers&ouml;nlichen Atmosph&auml;re</li><li>innovativen Forschungsprojekten</li><li>modernen Anstellungsbedingungen</li></ul>
  </div>
  <div class="kontakt">
    F&uuml;r weitere Ausk&uuml;nfte steht Ihnen Dr. Lukas Peter gerne zur Verf&uuml;gung.
  </div>
  <div class="gruen">
    <div class="bewerbung">
      <a href="https://jobs.fhgr.ch/Vacancies/774/Application/CheckLogin/1" target="_blank">Online bewerben</a>
    </div>
  </div>
</body>
</html>`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Fachhochschule Graubünden crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FHGR_KEY).toBe('fhgr');
    expect(FHGR_COMPANY_NAME).toBe('Fachhochschule Graubünden');
  });

  // ── isFhgrJob ──
  describe('isFhgrJob', () => {
    it('matches by companyKey', () => {
      expect(isFhgrJob({ companyKey: 'fhgr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFhgrJob({ company: 'Fachhochschule Graubünden' })).toBe(true);
    });

    it('matches by company name without diacritics', () => {
      expect(isFhgrJob({ company: 'Fachhochschule Graubunden' })).toBe(true);
    });

    it('matches by short name FH Graubünden', () => {
      expect(isFhgrJob({ company: 'FH Graubünden' })).toBe(true);
    });

    it('matches by fhgr.ch URL', () => {
      expect(isFhgrJob({ url: 'https://fhgr.ch/jobs/123' })).toBe(true);
    });

    it('matches by jobs.fhgr.ch URL', () => {
      expect(isFhgrJob({ url: 'https://jobs.fhgr.ch/Vacancies/774/Description/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFhgrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFhgrJob(null)).toBe(false);
      expect(isFhgrJob(undefined)).toBe(false);
      expect(isFhgrJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts fhgr.ch', () => {
      expect(isTrustedDomain('https://fhgr.ch/careers/job-123')).toBe(true);
    });

    it('trusts fhgr.ch subdomains', () => {
      expect(isTrustedDomain('https://jobs.fhgr.ch/Vacancies/774/Description/1')).toBe(true);
    });

    it('trusts umantis.com subdomains', () => {
      expect(isTrustedDomain('https://recruitingapp-2865.umantis.com/Vacancies/774/Description/1')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseFhgrListingPage ──
  describe('parseFhgrListingPage', () => {
    const listings = parseFhgrListingPage(FIXTURE_LISTING_HTML);

    it('parses correct number of listings', () => {
      expect(listings).toHaveLength(4);
    });

    it('extracts vacancy IDs', () => {
      expect(listings.map((l) => l.vacancyId)).toEqual(['774', '735', '749', '739']);
    });

    it('extracts titles correctly', () => {
      expect(listings[0].title).toContain('Studienleiter/-in');
      expect(listings[0].title).toContain('Business Administration');
      expect(listings[1].title).toBe('Instandhaltungsfachperson (100 %)');
      expect(listings[2].title).toBe('Bauingenieur:in');
      expect(listings[3].title).toBe('Lehrstelle Architekturmodellbauer:in EFZ');
    });

    it('extracts locations', () => {
      expect(listings[0].location).toBe('Chur');
      expect(listings[1].location).toBe('Chur');
      expect(listings[2].location).toBe('Chur');
    });

    it('extracts departments', () => {
      expect(listings[0].department).toContain('Schweizerisches Institut für Entrepreneurship');
      expect(listings[1].department).toBe('Services');
      expect(listings[2].department).toContain('Institut für Bauen im alpinen Raum');
      expect(listings[3].department).toBe('Zentrale Dienste');
    });

    it('extracts employment type text', () => {
      expect(listings[0].artText).toBe('Vollzeit');
      expect(listings[1].artText).toBe('Vollzeit');
    });

    it('extracts befristung (contract duration)', () => {
      expect(listings[0].befristung).toBe('Unbefristet');
      expect(listings[2].befristung).toBe('Befristet');
    });

    it('extracts entry level', () => {
      expect(listings[0].entryLevel).toContain('Dozent/in');
      expect(listings[0].entryLevel).toContain('Kader');
      expect(listings[2].entryLevel).toContain('Wissenschaftliche/r Mitarbeiter/in');
      expect(listings[3].entryLevel).toContain('Lernende/r');
    });

    it('extracts snippet text', () => {
      expect(listings[0].snippet).toContain('Gesamtverantwortung');
      expect(listings[1].snippet).toContain('reibungslosen Betrieb');
    });

    it('builds correct detail URLs', () => {
      expect(listings[0].detailUrl).toBe('https://jobs.fhgr.ch/Vacancies/774/Description/1');
      expect(listings[1].detailUrl).toBe('https://jobs.fhgr.ch/Vacancies/735/Description/1');
    });

    it('builds correct apply URLs', () => {
      expect(listings[0].applyUrl).toBe('https://jobs.fhgr.ch/Vacancies/774/Application/CheckLogin/1');
    });

    it('deduplicates by vacancy ID', () => {
      const dupeHtml = FIXTURE_LISTING_HTML.replace(
        '</table>',
        `<tr class="tableaslist_contentrow2">
          <td class="tableaslist_cell"><div class="tableaslist_cell">
            <span class="tableaslist_subtitle tableaslist_element_1152488">
              <a href="/Vacancies/774/Description/1" class="HSTableLinkSubTitle">Studienleiter/-in Duplicate</a>
            </span>
            <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Chur</span>
            <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
          </div></td>
        </tr></table>`
      );
      const result = parseFhgrListingPage(dupeHtml);
      const ids = result.map((r) => r.vacancyId);
      expect(ids.filter((id) => id === '774')).toHaveLength(1);
    });

    it('returns empty array for empty/invalid HTML', () => {
      expect(parseFhgrListingPage('')).toEqual([]);
      expect(parseFhgrListingPage('<html><body></body></html>')).toEqual([]);
    });

    it('skips initiative application entries', () => {
      const initHtml = `<table>
        <tr class="tableaslist_contentrow1"><td class="tableaslist_cell"><div class="tableaslist_cell">
          <span class="tableaslist_subtitle tableaslist_element_1152488">
            <a href="/Vacancies/9999/Description/1" class="HSTableLinkSubTitle">Initiativbewerbung</a>
          </span>
          <span class="tableaslist_subtitle tableaslist_element_1152495">&nbsp;|&nbsp;Chur</span>
          <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
        </div></td></tr>
      </table>`;
      expect(parseFhgrListingPage(initHtml)).toEqual([]);
    });

    it('handles empty entry level gracefully', () => {
      // Listing #1 (Instandhaltungsfachperson) has empty entryLevel
      expect(listings[1].entryLevel).toBe('');
    });
  });

  // ── parseFhgrDetailPage ──
  describe('parseFhgrDetailPage', () => {
    const detail = parseFhgrDetailPage(FIXTURE_DETAIL_PAGE, 'Fallback Title');

    it('extracts title from h1', () => {
      expect(detail.title).toContain('Studienleiter/-in');
      expect(detail.title).toContain('Business Administration');
    });

    it('extracts description content', () => {
      expect(detail.description).toBeTruthy();
      expect(detail.description.length).toBeGreaterThan(100);
    });

    it('description includes intro text', () => {
      expect(detail.description).toContain('dynamisches Denken');
    });

    it('description includes tasks/responsibilities', () => {
      expect(detail.description).toContain('Gesamtverantwortung');
    });

    it('description includes profile requirements', () => {
      expect(detail.description).toContain('Masterstudium');
    });

    it('description includes benefits', () => {
      expect(detail.description).toContain('Teamspirit');
    });

    it('uses fallback title when h1 is missing', () => {
      const noH1 = '<html><body><div class="text" id="einschub">Some description text that is long enough to pass</div></body></html>';
      const result = parseFhgrDetailPage(noH1, 'My Fallback');
      expect(result.title).toBe('My Fallback');
    });

    it('falls back to title tag when h1 is missing', () => {
      const titleOnly = '<html><head><title>Job From Title Tag</title></head><body><div class="text" id="einschub">Description content here that is long enough.</div></body></html>';
      const result = parseFhgrDetailPage(titleOnly, 'My Fallback');
      expect(result.title).toBe('Job From Title Tag');
    });

    it('handles empty HTML gracefully', () => {
      const result = parseFhgrDetailPage('', 'Default');
      expect(result.title).toBe('Default');
      expect(result.description).toBe('');
    });
  });

  // ── extractLocation ──
  describe('extractLocation', () => {
    it('extracts plain city name', () => {
      expect(extractLocation('Chur')).toBe('Chur');
    });

    it('strips "Hauptsitz" prefix', () => {
      expect(extractLocation('Hauptsitz Chur')).toBe('Chur');
    });

    it('strips "Campus" prefix', () => {
      expect(extractLocation('Campus Chur')).toBe('Chur');
    });

    it('strips "Standort" prefix', () => {
      expect(extractLocation('Standort Chur')).toBe('Chur');
    });

    it('defaults to Chur for empty input', () => {
      expect(extractLocation('')).toBe('Chur');
    });

    it('handles pipe prefix from listing', () => {
      expect(extractLocation('|  Chur')).toBe('Chur');
    });

    it('handles nbsp entities', () => {
      expect(extractLocation('&nbsp;|&nbsp;Chur')).toBe('Chur');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Studienleiter/-in Business Administration');
      expect(slug).toContain('studienleiter');
      expect(slug).toContain('business-administration');
    });

    it('strips diacritics', () => {
      expect(slugify('Institutsführung')).toBe('institutsfuhrung');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer fhgr ch')).toBe('developer-fhgr-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'fhgr-abc123def456',
      slug: 'studienleiter-in-business-administration-fhgr-ch',
      slugByLocale: { de: 'studienleiter-in-business-administration-fhgr-ch' },
      company: 'Fachhochschule Graubünden',
      companyKey: 'fhgr',
      companyDomain: 'fhgr.ch',
      title: 'Studienleiter/-in «Business Administration»',
      titleByLocale: { de: 'Studienleiter/-in «Business Administration»' },
      description: 'A test job description for validation that is long enough to meet requirements.',
      descriptionByLocale: { de: 'A test job description for validation that is long enough to meet requirements.' },
      location: 'Chur',
      canton: 'GR',
      url: 'https://jobs.fhgr.ch/Vacancies/774/Description/1',
      source: 'Fachhochschule Graubünden Dedicated Parser (Umantis)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Chur',
      postalCode: '7000',
      addressCountry: 'CH',
      country: 'CH',
      sector: 'Formazione / Ricerca',
      currency: 'CHF',
      employmentType: 'FULL_TIME',
      applyUrl: 'https://jobs.fhgr.ch/Vacancies/774/Application/CheckLogin/1',
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
      expect(validJob.id).toMatch(/^fhgr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is GR', () => {
      expect(validJob.canton).toBe('GR');
    });

    it('sector is education/research', () => {
      expect(validJob.sector).toBe('Formazione / Ricerca');
    });

    it('URL is on trusted domain', () => {
      expect(isTrustedDomain(validJob.url)).toBe(true);
      expect(isTrustedDomain(validJob.applyUrl)).toBe(true);
    });
  });
});
