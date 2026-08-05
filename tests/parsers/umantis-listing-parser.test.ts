/**
 * Tests for the shared Umantis listing parser.
 *
 * Covers Basel/Basel-Land hospitals using the Umantis ATS via the shared
 * factory in `scripts/lib/umantis-listing-common.mjs`:
 *   - Bethesda Spital (tenant 2998, newer UI)
 *   - Klinik Sonnenhalde Riehen (tenant 3030, newer UI)
 *
 * Adullam-Stiftung (ex-tenant 2562) MIGRATED off Umantis to the Solique board
 * (#1245/#1506); its matcher tests below assert the new Solique source, not the
 * dead tenant.
 *
 * Verifies:
 *   - Exported constants from each thin wrapper
 *   - isCompanyJob / isTrustedDomain matchers
 *   - Initiative-application filter (skips Initiativbewerbung/Spontanbewerbung)
 *   - Swiss date parsing (DD.MM.YYYY → YYYY-MM-DD)
 *   - HTML entity decoding (Swiss German + French chars)
 *   - Both newer-UI (column-value spans) and older-UI (pipe text) parsing
 */
import { describe, it, expect } from 'vitest';
import {
  createUmantisListingParser,
  parseUmantisListing,
  parseNewerUiListing,
  parseOlderUiListing,
  decodeEntities,
  parseSwissDate,
} from '../../scripts/lib/umantis-listing-common.mjs';
import {
  BETHESDA_SPITAL_KEY,
  BETHESDA_SPITAL_COMPANY_NAME,
  isBethesdaSpitalJob,
  isTrustedDomain as isBethesdaTrusted,
} from '../../scripts/lib/bethesda-spital-job-parser.mjs';
import {
  ADULLAM_KEY,
  ADULLAM_COMPANY_NAME,
  isAdullamJob,
  isTrustedDomain as isAdullamTrusted,
} from '../../scripts/lib/adullam-job-parser.mjs';
import {
  KLINIK_SONNENHALDE_KEY,
  KLINIK_SONNENHALDE_COMPANY_NAME,
  isKlinikSonnenhaldeJob,
  isTrustedDomain as isSonnenhaldeTrusted,
} from '../../scripts/lib/klinik-sonnenhalde-job-parser.mjs';

describe('Umantis hospitals — exported constants', () => {
  it('Bethesda exports valid constants', () => {
    expect(BETHESDA_SPITAL_KEY).toBe('bethesda-spital');
    expect(BETHESDA_SPITAL_COMPANY_NAME).toMatch(/Bethesda/);
  });

  it('Adullam exports valid constants', () => {
    expect(ADULLAM_KEY).toBe('adullam');
    expect(ADULLAM_COMPANY_NAME).toMatch(/Adullam/);
  });

  it('Klinik Sonnenhalde exports valid constants', () => {
    expect(KLINIK_SONNENHALDE_KEY).toBe('klinik-sonnenhalde');
    expect(KLINIK_SONNENHALDE_COMPANY_NAME).toMatch(/Sonnenhalde/);
  });
});

describe('Umantis hospitals — isCompanyJob matchers', () => {
  it('Bethesda matches by tenant URL', () => {
    expect(isBethesdaSpitalJob({ url: 'https://recruitingapp-2998.umantis.com/x' })).toBe(true);
    expect(isBethesdaSpitalJob({ url: 'https://recruitingapp-2562.umantis.com/x' })).toBe(false);
  });

  it('Adullam (migrated off Umantis → Solique) matches by Solique board URL, not the dead tenant', () => {
    expect(isAdullamJob({ url: 'https://live.solique.ch/adullam/job/details/123' })).toBe(true);
    // Re-pointed to Solique (#1245): the old Umantis tenant URL is no longer the
    // source and is matched only via companyKey (see below), not by URL.
    expect(isAdullamJob({ url: 'https://recruitingapp-2562.umantis.com/x' })).toBe(false);
  });

  it('Klinik Sonnenhalde matches by tenant URL', () => {
    expect(isKlinikSonnenhaldeJob({ url: 'https://recruitingapp-3030.umantis.com/x' })).toBe(true);
  });

  it('Matches by companyKey regardless of URL', () => {
    expect(isBethesdaSpitalJob({ companyKey: 'bethesda-spital' })).toBe(true);
    expect(isAdullamJob({ companyKey: 'adullam' })).toBe(true);
    expect(isKlinikSonnenhaldeJob({ companyKey: 'klinik-sonnenhalde' })).toBe(true);
  });
});

describe('Umantis hospitals — isTrustedDomain', () => {
  it('Bethesda trusts both corporate + umantis tenant', () => {
    expect(isBethesdaTrusted('https://www.bethesda-spital.ch/x')).toBe(true);
    expect(isBethesdaTrusted('https://recruitingapp-2998.umantis.com/Vacancies/1/Description/1')).toBe(true);
  });

  it('Adullam trusts corporate + Solique board (migrated off Umantis)', () => {
    expect(isAdullamTrusted('https://www.adullam.ch/x')).toBe(true);
    expect(isAdullamTrusted('https://live.solique.ch/adullam/job/details/123')).toBe(true);
    // No longer a Umantis tenant — the dead tenant host is not trusted.
    expect(isAdullamTrusted('https://recruitingapp-2562.umantis.com/x')).toBe(false);
  });

  it('Sonnenhalde rejects unrelated domains', () => {
    expect(isSonnenhaldeTrusted('https://malicious.example/x')).toBe(false);
    expect(isSonnenhaldeTrusted('not-a-url')).toBe(false);
  });
});

describe('parseSwissDate — DD.MM.YYYY → ISO', () => {
  it('parses two-digit day and month', () => {
    expect(parseSwissDate('29.03.2023')).toBe('2023-03-29');
  });

  it('parses single-digit day/month', () => {
    expect(parseSwissDate('3.5.2024')).toBe('2024-05-03');
  });

  it('returns empty for invalid input', () => {
    expect(parseSwissDate('not-a-date')).toBe('');
    expect(parseSwissDate('')).toBe('');
    expect(parseSwissDate('2024-05-03')).toBe('');
  });
});

describe('decodeEntities — Swiss/French entity coverage', () => {
  it('decodes German umlauts', () => {
    expect(decodeEntities('M&uuml;ller &amp; K&ouml;hl')).toBe('Müller & Köhl');
  });

  it('decodes French accents', () => {
    expect(decodeEntities('h&eacute;pato&middot;biliaire')).toBe('hépato·biliaire');
  });

  it('decodes typographic punctuation', () => {
    expect(decodeEntities('l&rsquo;h&ocirc;pital')).toBe('l’hôpital');
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('&#8211; &#x2014;')).toBe('– —');
  });

  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&unknownEntity;')).toBe('&unknownEntity;');
  });
});

describe('parseUmantisListing — UI detection', () => {
  it('routes newer-UI HTML through newer parser', () => {
    const html = `
      <table>
        <tr class="table-as-list__contentrow1">
          <td>
            <a href="/Vacancies/123/Description/1">Pflegefachfrau 80%</a>
            <span class="column-value" id="column_value_1184128">Bethesda Spital AG</span>
            <span class="column-value" id="column_value_1184117">Teilzeit</span>
            <span class="column-value" id="column_value_1184118">Unbefristet</span>
            <span class="column-value" id="column_value_1184120">Pflege</span>
          </td>
        </tr>
      </table>
    `;
    const { entries, ui } = parseUmantisListing(html);
    expect(ui).toBe('newer');
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('123');
    expect(entries[0].title).toBe('Pflegefachfrau 80%');
    expect(entries[0].art).toBe('Teilzeit');
    expect(entries[0].befristung).toBe('Unbefristet');
    expect(entries[0].department).toBe('Pflege');
  });

  it('routes older-UI HTML through older parser', () => {
    const html = `
      <span class="tableaslist_text tableaslist_element_1152486">&nbsp;Basel</span>
      <span class="tableaslist_text tableaslist_element_1152487">&nbsp;|&nbsp;Online seit: 15.05.2026<br/></span>
      <span class="tableaslist_subtitle tableaslist_element_1152488">
        <a href="/Vacancies/456/Description/1">Logopäde/-in 20%</a>
      </span>
      <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Teilzeit</span>
      <span class="tableaslist_subtitle tableaslist_element_1152492">&nbsp;|&nbsp;Befristung: unbefristet</span>
      <span class="tableaslist_subtitle tableaslist_element_1152494">&nbsp;|&nbsp;Unternehmensbereich: Medizinische Querschnittsdienste</span>
    `;
    const { entries, ui } = parseUmantisListing(html);
    expect(ui).toBe('older');
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('456');
    expect(entries[0].title).toBe('Logopäde/-in 20%');
    expect(entries[0].art).toBe('Teilzeit');
    expect(entries[0].department).toBe('Medizinische Querschnittsdienste');
    expect(entries[0].datum).toBe('15.05.2026');
  });

  it('skips Initiativbewerbung / Initiativ placeholders', () => {
    const html = `
      <tr class="table-as-list__contentrow1">
        <td><a href="/Vacancies/9999/Description/1">Initiativbewerbung erstellen</a></td>
      </tr>
      <tr class="table-as-list__contentrow2">
        <td><a href="/Vacancies/100/Description/1">Ärztin/Arzt Geriatrie (a) Initiativ</a></td>
      </tr>
      <tr class="table-as-list__contentrow1">
        <td><a href="/Vacancies/200/Description/1">Pflegefachfrau IPS 100%</a></td>
      </tr>
    `;
    const { entries } = parseUmantisListing(html);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('200');
  });

  it('deduplicates the same vacancy ID across multiple rows', () => {
    const html = `
      <tr class="table-as-list__contentrow1"><td><a href="/Vacancies/777/Description/1">Title A</a></td></tr>
      <tr class="table-as-list__contentrow2"><td><a href="/Vacancies/777/Description/1">Title A</a></td></tr>
    `;
    const { entries } = parseUmantisListing(html);
    expect(entries).toHaveLength(1);
  });

  it('older-UI: does not bleed a neighbouring row\'s location into a short row (issue #5011)', () => {
    // Regression for #5011: Bürgenstock's multi-property listing has short
    // rows between jobs, so a fixed-distance lookbehind previously reached
    // past the current row's own (empty) location text and picked up the
    // PREVIOUS row's location/brand name instead.
    const html = `
      <span class="tableaslist_text tableaslist_element_1152486">&nbsp;Taverne</span>
      <span class="tableaslist_text tableaslist_element_1152487">&nbsp;|&nbsp;Online seit: 10.05.2026<br/></span>
      <span class="tableaslist_subtitle tableaslist_element_1152488">
        <a href="/Vacancies/111/Description/1">Service Mitarbeiter/-in 100%</a>
      </span>
      <span class="tableaslist_subtitle tableaslist_element_1152488">
        <a href="/Vacancies/222/Description/1">Assistent/-in Floral Design 100%</a>
      </span>
      <span class="tableaslist_subtitle tableaslist_element_1152491">&nbsp;|&nbsp;Art: Vollzeit</span>
    `;
    const { entries } = parseUmantisListing(html);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('111');
    expect(entries[0].location).toBe('Taverne');
    // The second job's own row carries no "<City> | Online seit" text — the
    // bounded window must NOT reach back across job 111's anchor to reuse
    // "Taverne" for job 222 too.
    expect(entries[1].id).toBe('222');
    expect(entries[1].location).toBe('');
  });
});

describe('createUmantisListingParser — config validation', () => {
  it('throws on missing required config', () => {
    expect(() => createUmantisListingParser({} as any)).toThrow();
    expect(() => createUmantisListingParser({
      companyKey: 'x',
      companyName: 'X',
      // missing tenantId, defaultCanton
    } as any)).toThrow();
  });

  it('returns three exposed functions', () => {
    const p = createUmantisListingParser({
      companyKey: 'test-hospital',
      companyName: 'Test Hospital',
      companyDomain: 'test.ch',
      tenantId: 9999,
      defaultCanton: 'ZH',
      defaultCity: 'Zürich',
      defaultPostalCode: '8000',
    });
    expect(typeof p.fetchAllJobs).toBe('function');
    expect(typeof p.isCompanyJob).toBe('function');
    expect(typeof p.isTrustedDomain).toBe('function');
  });
});
