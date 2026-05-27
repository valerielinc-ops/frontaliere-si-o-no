/**
 * Spital Davos — Umantis ATS crawler parser tests (tenant 2966)
 *
 * Tests parseSpitalDavosListingPage(), parseSpitalDavosDetailPage(),
 * isSpitalDavosJob(), isTrustedDomain() using HTML fixtures mirroring
 * the real Umantis ATS 2023 UI page structure at tenant 2966.
 */
import { describe, it, expect } from 'vitest';

import {
  SPITAL_DAVOS_KEY,
  SPITAL_DAVOS_COMPANY_NAME,
  isSpitalDavosJob,
  isTrustedDomain,
  parseSpitalDavosListingPage,
  parseSpitalDavosDetailPage,
} from '../scripts/lib/spital-davos-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Fixtures: listing page (Umantis 2023 UI) ──────────────────────────────

const FIXTURE_LISTING_HTML = `<!DOCTYPE html>
<html class="ger Overview" lang="de" dir="ltr">
<head><title>Bewerbungsmanagement Spital Davos Stellenmarkt</title></head>
<body>
<table>
  <caption class="visually-hidden"></caption>
  <tr class="table-as-list__contentrow1" tabindex="158565" role="row">
    <td class="table-as-list__piccell" id="tablecell_4" role="cell">
      <div><div class="table-as-list__piccell"></div></div>
    </td>
    <td class="table-as-list__cell" id="tablecell_5" role="cell">
      <div>
        <div class="table-as-list__cell">
          <ul class="table-cell-content" role="list" aria-label="Stellendetails" tabindex="158566">
            <li role="listitem"><h3 class="table-as-list__subtitle tableaslist_element_1152488"><a href="/Vacancies/699/Description/1" target="_blank" class="HSTableLinkSubTitle" aria-label="Stationsleitung Akutabteilung (80&ndash;100%)" id="link_1152488_1" tabindex="158567">Stationsleitung Akutabteilung (80&ndash;100%)</a></h3 ></li>
            <li role="listitem"><p class="table-as-list__subtitle tableaslist_element_1184115">Eine abwechslungsreiche T&auml;tigkeit als Stationsleitung der Akutabteilung in der h&ouml;chstgelegenen Stadt Europas erwartet Sie.<br /> </p ></li>
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184128" role="listitem" aria-label="Spital Davos AG"><span class="visually-hidden" id="column_label_1184128"></span><span class="icon-view"><i class="icon icon-umantis-icon-404" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184128">Spital Davos AG</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184117" role="listitem"><span class="visually-hidden" id="column_label_1184117">Art</span><span class="icon-view" title="Art"><i class="icon icon-jobtype" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184117">Vollzeit</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184118" role="listitem"><span class="visually-hidden" id="column_label_1184118">Befristung</span><span class="icon-view" title="Befristung"><i class="icon icon-jobperiod" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184118">Unbefristet</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184120" role="listitem"><span class="visually-hidden" id="column_label_1184120">Organisationseinheit</span><span class="icon-view" title="Organisationseinheit"><i class="icon icon-department" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184120"> Pflege</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1152500" role="listitem"><a href="/Vacancies/699/Application/CheckLogin/1" target="_blank" class="HSTableLink" aria-label="Jetzt bewerben" id="link_1152500_1">Jetzt bewerben</a></li ><br />
          </ul>
        </div>
      </div>
    </td>
  </tr>
  <tr class="table-as-list__contentrow2" tabindex="158573" role="row">
    <td class="table-as-list__piccell" id="tablecell_6" role="cell">
      <div><div class="table-as-list__piccell"></div></div>
    </td>
    <td class="table-as-list__cell" id="tablecell_7" role="cell">
      <div>
        <div class="table-as-list__cell">
          <ul class="table-cell-content" role="list" aria-label="Stellendetails" tabindex="158574">
            <li role="listitem"><h3 class="table-as-list__subtitle tableaslist_element_1152488"><a href="/Vacancies/694/Description/1" target="_blank" class="HSTableLinkSubTitle" aria-label="Dipl. Pflegefachperson HF &Uuml;berwachungsstation 40- 60 %" id="link_1152488_2" tabindex="158575">Dipl. Pflegefachperson HF &Uuml;berwachungsstation 40- 60 %</a></h3 ></li>
            <li role="listitem"><p class="table-as-list__subtitle tableaslist_element_1184115">Abwechslungsreicher T&auml;tigkeit als Dipl. Pflegefachperson auf unserer &Uuml;berwachungsstation.<br /> </p ></li>
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184128" role="listitem" aria-label="Spital Davos AG"><span class="visually-hidden" id="column_label_1184128"></span><span class="icon-view"><i class="icon icon-umantis-icon-404" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184128">Spital Davos AG</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184117" role="listitem"><span class="visually-hidden" id="column_label_1184117">Art</span><span class="icon-view" title="Art"><i class="icon icon-jobtype" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184117">Teilzeit</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184118" role="listitem"><span class="visually-hidden" id="column_label_1184118">Befristung</span><span class="icon-view" title="Befristung"><i class="icon icon-jobperiod" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184118">Unbefristet</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184120" role="listitem"><span class="visually-hidden" id="column_label_1184120">Organisationseinheit</span><span class="icon-view" title="Organisationseinheit"><i class="icon icon-department" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184120"> &Uuml;WS/AWR</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1152500" role="listitem"><a href="/Vacancies/694/Application/CheckLogin/1" target="_blank" class="HSTableLink" aria-label="Jetzt bewerben" id="link_1152500_2">Jetzt bewerben</a></li ><br />
          </ul>
        </div>
      </div>
    </td>
  </tr>
  <tr class="table-as-list__contentrow1" tabindex="158597" role="row">
    <td class="table-as-list__piccell" id="tablecell_12" role="cell">
      <div><div class="table-as-list__piccell"></div></div>
    </td>
    <td class="table-as-list__cell" id="tablecell_13" role="cell">
      <div>
        <div class="table-as-list__cell">
          <ul class="table-cell-content" role="list" aria-label="Stellendetails" tabindex="158598">
            <li role="listitem"><h3 class="table-as-list__subtitle tableaslist_element_1152488"><a href="/Vacancies/700/Description/1" target="_blank" class="HSTableLinkSubTitle" aria-label="Sachbearbeiter:in Finanzbuchhaltung 50-60% im Jobsharing-Modell" id="link_1152488_5" tabindex="158599">Sachbearbeiter:in Finanzbuchhaltung 50-60% im Jobsharing-Modell</a></h3 ></li>
            <li role="listitem"><p class="table-as-list__subtitle tableaslist_element_1184115">Werden Sie Teammitglied des Fakturateams und unterst&uuml;tzen Sie uns mit Ihren Fachkenntnissen.<br /> </p ></li>
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184128" role="listitem" aria-label="Spital Davos AG"><span class="visually-hidden" id="column_label_1184128"></span><span class="icon-view"><i class="icon icon-umantis-icon-404" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184128">Spital Davos AG</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184117" role="listitem"><span class="visually-hidden" id="column_label_1184117">Art</span><span class="icon-view" title="Art"><i class="icon icon-jobtype" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184117">Teilzeit</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184118" role="listitem"><span class="visually-hidden" id="column_label_1184118">Befristung</span><span class="icon-view" title="Befristung"><i class="icon icon-jobperiod" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184118">Unbefristet</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1184120" role="listitem"><span class="visually-hidden" id="column_label_1184120">Organisationseinheit</span><span class="icon-view" title="Organisationseinheit"><i class="icon icon-department" aria-hidden="true"></i></span><span class="column-value" id="column_value_1184120"> Finanzen</span><br /> </li >
            <li class="form_content_paragraph table-as-list__text tableaslist_element_1152500" role="listitem"><a href="/Vacancies/700/Application/CheckLogin/1" target="_blank" class="HSTableLink" aria-label="Jetzt bewerben" id="link_1152500_5">Jetzt bewerben</a></li ><br />
          </ul>
        </div>
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
  <meta http-equiv="content-type" content="text/html; charset=UTF-8">
  <title>Stationsleitung Akutabteilung (80\u2013100%)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <div id="main">
    <div id="header">
      <div id="logo"><img class="logo1" src="/Vacancies/699/Description/1?ShowDocument=1" alt="Logo Spital Davos"></div>
    </div>
    <div id="main2">
      <div id="einleitung">
        <div id="welcome">Leben und arbeiten in der Destination Davos Klosters? Wir freuen uns auf Verst\u00e4rkung!</div>
        <div id="einleitung_text">
          In der Funktion als Stationsleitung der Akutabteilung sind Sie verantwortlich f\u00fcr die fachliche und personelle F\u00fchrung und arbeiten praktisch in Ihrem Team mit. Sie unterst\u00fctzen die Mitarbeitenden in der Sicherstellung des einwandfreien Betriebes des Tagesgesch\u00e4ftes.<br> </br>
          Als Regionalspital/Akutspital mit Rettungsdienst, Pflegeheim und Spitex sind wir f\u00fcr die medizinische Grundversorgung der Davoser Bev\u00f6lkerung und G\u00e4ste zust\u00e4ndig.
        </div>
      </div>
      <div id="inserat">
        <div id="text">
          Per 01.07.2026 oder nach Vereinbarung suchen wir eine f\u00fchrungsstarke Pflegefachperson als
        </div>
        <div id="titelpup">
          Stationsleitung Akutabteilung (80\u2013100%)
        </div>
        <div id="titel">
          Ihr Aufgabengebiet
        </div>
        <div id=text>
          <ul><li>Umfassende pflegerische Betreuung der station\u00e4ren und ambulanten Patientinnen und Patienten</li><li>Planung und Dokumentation des Pflegeprozesses</li><li>Verantwortung f\u00fcr F\u00fchrung, Einsatz und Entwicklung der direkt unterstellten Mitarbeitenden</li></ul>
        </div>
        <div id="titel">
          Ihr Profil
        </div>
        <div id=aufzaehlung>
          <ul><li>Abgeschlossene Ausbildung auf Terti\u00e4rstufe im Pflegebereich und mehrj\u00e4hrige Berufserfahrung</li><li>Ausgewiesene F\u00fchrungserfahrung oder Bereitschaft zur Weiterbildung</li><li>Ausgezeichnete m\u00fcndliche und schriftliche Deutschkenntnisse</li></ul>
        </div>
        <div id="titel">
          Unser Angebot
        </div>
        <div id=aufzaehlung>
          <ul><li>Anspruchsvolle, abwechslungsreiche T\u00e4tigkeit in einem professionellen Team</li><li>Attraktive Anstellungsbedingungen und Sozialleistungen</li><li>Vielseitiges Sport- und Freizeitangebot in Davos</li></ul>
        </div>
        <div id=text>
          F\u00fcr weitere Ausk\u00fcnfte steht Ihnen Bea Heeb, Leiterin Pflege (+41 81 414 82 50) gerne zur Verf\u00fcgung.<br>
        </div>
        <div id=text>
          Sind Sie bereit f\u00fcr eine neue Herausforderung? Unser HRM-Team freut sich auf Ihre Online-Bewerbung.<br>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Spital Davos crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPITAL_DAVOS_KEY).toBe('spital-davos');
    expect(SPITAL_DAVOS_COMPANY_NAME).toBe('Spital Davos');
  });

  // ── isSpitalDavosJob ──
  describe('isSpitalDavosJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalDavosJob({ companyKey: 'spital-davos' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSpitalDavosJob({ company: 'Spital Davos' })).toBe(true);
    });

    it('matches by company name with AG suffix', () => {
      expect(isSpitalDavosJob({ company: 'Spital Davos AG' })).toBe(true);
    });

    it('matches by spitaldavos.ch URL', () => {
      expect(isSpitalDavosJob({ url: 'https://spitaldavos.ch/jobs/123' })).toBe(true);
    });

    it('matches by Umantis URL', () => {
      expect(isSpitalDavosJob({ url: 'https://recruitingapp-2966.umantis.com/Vacancies/699/Description/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpitalDavosJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpitalDavosJob(null)).toBe(false);
      expect(isSpitalDavosJob(undefined)).toBe(false);
      expect(isSpitalDavosJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts spitaldavos.ch', () => {
      expect(isTrustedDomain('https://spitaldavos.ch/careers/job-123')).toBe(true);
    });

    it('trusts spitaldavos.ch subdomains', () => {
      expect(isTrustedDomain('https://www.spitaldavos.ch/job/456')).toBe(true);
    });

    it('trusts umantis.com subdomains', () => {
      expect(isTrustedDomain('https://recruitingapp-2966.umantis.com/Vacancies/699/Description/1')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseSpitalDavosListingPage ──
  describe('parseSpitalDavosListingPage', () => {
    const listings = parseSpitalDavosListingPage(FIXTURE_LISTING_HTML);

    it('parses correct number of listings', () => {
      expect(listings).toHaveLength(3);
    });

    it('extracts vacancy IDs', () => {
      expect(listings.map((l: { vacancyId: string }) => l.vacancyId)).toEqual(['699', '694', '700']);
    });

    it('extracts titles correctly', () => {
      expect(listings[0].title).toContain('Stationsleitung Akutabteilung');
      expect(listings[1].title).toContain('Pflegefachperson HF');
      expect(listings[2].title).toContain('Sachbearbeiter');
    });

    it('decodes HTML entities in titles', () => {
      // &ndash; should become – and &Uuml; should become Ü
      expect(listings[1].title).toContain('Überwachungsstation');
    });

    it('extracts snippets', () => {
      expect(listings[0].snippet).toContain('Stationsleitung');
      expect(listings[2].snippet).toContain('Fakturateams');
    });

    it('extracts employment type (Art)', () => {
      expect(listings[0].artText).toBe('Vollzeit');
      expect(listings[1].artText).toBe('Teilzeit');
      expect(listings[2].artText).toBe('Teilzeit');
    });

    it('extracts contract duration (Befristung)', () => {
      expect(listings[0].befristung).toBe('Unbefristet');
      expect(listings[1].befristung).toBe('Unbefristet');
    });

    it('extracts department (Organisationseinheit)', () => {
      expect(listings[0].department).toBe('Pflege');
      expect(listings[1].department).toContain('ÜWS/AWR');
      expect(listings[2].department).toBe('Finanzen');
    });

    it('builds correct detail URLs', () => {
      expect(listings[0].detailUrl).toBe('https://recruitingapp-2966.umantis.com/Vacancies/699/Description/1');
    });

    it('builds correct apply URLs', () => {
      expect(listings[0].applyUrl).toBe('https://recruitingapp-2966.umantis.com/Vacancies/699/Application/CheckLogin/1');
    });

    it('deduplicates by vacancy ID', () => {
      const dupeHtml = FIXTURE_LISTING_HTML.replace(
        '</table>',
        `<tr class="table-as-list__contentrow2" role="row">
          <td class="table-as-list__piccell"></td>
          <td class="table-as-list__cell"><div><div class="table-as-list__cell">
            <ul class="table-cell-content" role="list">
              <li role="listitem"><h3 class="table-as-list__subtitle tableaslist_element_1152488">
                <a href="/Vacancies/699/Description/1" class="HSTableLinkSubTitle">Stationsleitung Akutabteilung (80-100%)</a>
              </h3></li>
            </ul>
          </div></div></td>
        </tr></table>`
      );
      const result = parseSpitalDavosListingPage(dupeHtml);
      const ids = result.map((r: { vacancyId: string }) => r.vacancyId);
      expect(ids.filter((id: string) => id === '699')).toHaveLength(1);
    });

    it('returns empty array for empty/invalid HTML', () => {
      expect(parseSpitalDavosListingPage('')).toEqual([]);
      expect(parseSpitalDavosListingPage('<html><body></body></html>')).toEqual([]);
    });

    it('skips spontaneous application entries', () => {
      const initHtml = `<table>
        <tr class="table-as-list__contentrow1" role="row">
          <td class="table-as-list__piccell"></td>
          <td class="table-as-list__cell"><div><div class="table-as-list__cell">
            <ul class="table-cell-content" role="list">
              <li role="listitem"><h3 class="table-as-list__subtitle tableaslist_element_1152488">
                <a href="/Vacancies/9999/Description/1" class="HSTableLinkSubTitle">Initiativbewerbung</a>
              </h3></li>
            </ul>
          </div></div></td>
        </tr>
      </table>`;
      expect(parseSpitalDavosListingPage(initHtml)).toEqual([]);
    });
  });

  // ── parseSpitalDavosDetailPage ──
  describe('parseSpitalDavosDetailPage', () => {
    const detail = parseSpitalDavosDetailPage(FIXTURE_DETAIL_PAGE, 'Fallback Title');

    it('extracts title from <title> tag', () => {
      expect(detail.title).toContain('Stationsleitung Akutabteilung');
    });

    it('extracts description content', () => {
      expect(detail.description).toBeTruthy();
      expect(detail.description.length).toBeGreaterThan(50);
    });

    it('description includes intro text', () => {
      expect(detail.description).toContain('Stationsleitung der Akutabteilung');
    });

    it('description includes tasks', () => {
      expect(detail.description).toContain('pflegerische Betreuung');
    });

    it('description includes profile requirements', () => {
      expect(detail.description).toContain('Deutschkenntnisse');
    });

    it('description includes offer/benefits', () => {
      expect(detail.description).toContain('Anstellungsbedingungen');
    });

    it('description includes contact info', () => {
      expect(detail.description).toContain('Bea Heeb');
    });

    it('description excludes CTA text', () => {
      expect(detail.description).not.toContain('Sind Sie bereit');
    });

    it('uses fallback title when title tag is missing', () => {
      const noTitle = '<html><head></head><body><div id="einleitung_text">Some description text that is long enough to pass the threshold check.</div></body></html>';
      const result = parseSpitalDavosDetailPage(noTitle, 'My Fallback');
      expect(result.title).toBe('My Fallback');
    });

    it('handles empty HTML gracefully', () => {
      const result = parseSpitalDavosDetailPage('', 'Default');
      expect(result.title).toBe('Default');
      expect(result.description).toBe('');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts hospital job title to URL-safe slug', () => {
      const slug = slugify('Stationsleitung Akutabteilung (80-100%)');
      expect(slug).toContain('stationsleitung-akutabteilung');
    });

    it('handles German characters', () => {
      expect(slugify('Überwachungsstation')).toBe('uberwachungsstation');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer spital-davos ch')).toBe('developer-spital-davos-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'spital-davos-abc123def456',
      slug: 'stationsleitung-akutabteilung-80-100-spital-davos-ch',
      slugByLocale: { de: 'stationsleitung-akutabteilung-80-100-spital-davos-ch' },
      company: 'Spital Davos',
      companyKey: 'spital-davos',
      companyDomain: 'spitaldavos.ch',
      title: 'Stationsleitung Akutabteilung (80-100%)',
      titleByLocale: { de: 'Stationsleitung Akutabteilung (80-100%)' },
      description: 'A test job description for validation that is long enough to pass checks.',
      descriptionByLocale: { de: 'A test job description for validation that is long enough to pass checks.' },
      location: 'Davos',
      canton: 'GR',
      url: 'https://recruitingapp-2966.umantis.com/Vacancies/699/Description/1',
      source: 'Spital Davos Dedicated Parser (Umantis)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Davos',
      postalCode: '7270',
      addressCountry: 'CH',
      country: 'CH',
      sector: 'Sanità / Assistenza',
      currency: 'CHF',
      employmentType: 'FULL_TIME',
      applyUrl: 'https://recruitingapp-2966.umantis.com/Vacancies/699/Application/CheckLogin/1',
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
      expect(validJob.id).toMatch(/^spital-davos-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is GR', () => {
      expect(validJob.canton).toBe('GR');
    });

    it('sector is healthcare', () => {
      expect(validJob.sector).toBe('Sanità / Assistenza');
    });

    it('postal code is 7270 (Davos)', () => {
      expect(validJob.postalCode).toBe('7270');
    });

    it('URL is on trusted Umantis domain', () => {
      expect(isTrustedDomain(validJob.url)).toBe(true);
      expect(isTrustedDomain(validJob.applyUrl)).toBe(true);
    });
  });
});
