/**
 * ALDI Suisse crawler parser tests
 *
 * Tests parseAldiSearchResults(), parseAldiListingPage(),
 * parseAldiDetailPage(), isAldiTicinoJob(), isAldiJob(), and constants.
 */
import { describe, it, expect } from 'vitest';

import {
  parseAldiSearchResults,
  parseAldiListingPage,
  parseAldiDetailPage,
  isAldiTicinoJob,
  isAldiJob,
  ALDI_SEARCH_API,
  ALDI_SUCCESSFACTORS_BASE,
} from '@/scripts/lib/aldi-suisse-job-parser.mjs';

// --- Fixture: live TYPO3 REST job-search response ---
const SEARCH_JSON = {
  jobs: [
    {
      rmk_id: '74455',
      title: 'Mitarbeiter Verkauf (m/w/d)',
      shift_type: '50 - 70%',
      shift: '50 - 70%',
      url: 'job/1271973201',
      area_of_activity_title: 'Filialteam',
      workload: 59,
      career_level_title: 'Berufseinsteiger',
      sys_language_uid: 0,
      latitude: '47.10',
      longitude: '9.06',
      city: 'Näfels',
      address: 'Oberdorf 54',
      zip: '8752',
      job_id: '1271973201',
    },
    {
      rmk_id: '77113',
      title: 'Filialleiter/in (m/w/d)',
      shift_type: '100%',
      url: 'job/1409127233',
      area_of_activity_title: 'Filialteam',
      sys_language_uid: 2,
      city: 'Bellinzona',
      address: 'Via Stazione 1',
      zip: '6500',
      job_id: '1409127233',
    },
    // duplicate URL — must be deduped
    {
      title: 'Mitarbeiter Verkauf (m/w/d) dup',
      url: 'job/1271973201',
      city: 'Näfels',
      zip: '8752',
      job_id: '1271973201',
    },
  ],
};

// --- Fixture: same physical position shipped twice with different
// sys_language_uid / job/{id} (#3119 item 3 — cross-language duplicate) ---
const SEARCH_JSON_CROSS_LINGUA = {
  jobs: [
    {
      rmk_id: '88221',
      title: 'Mitarbeiter Verkauf (m/w/d)',
      shift_type: '60 - 80%',
      url: 'job/2001000001',
      sys_language_uid: 0,
      city: 'Lugano',
      zip: '6900',
      job_id: '2001000001',
    },
    // Same rmk_id (same physical role), different language variant and
    // distinct job/{id} URL — must collapse to a single result.
    {
      rmk_id: '88221',
      title: 'Collaboratore vendita (m/f/d)',
      shift_type: '60 - 80%',
      url: 'job/2001000002',
      sys_language_uid: 2,
      city: 'Lugano',
      zip: '6900',
      job_id: '2001000002',
    },
  ],
};

// --- Fixture: live TYPO3 detail page (description div) ---
const DETAIL_TYPO3_HTML = `
<html><body>
  <h1 class="title">Mitarbeiter Verkauf (m/w/d)</h1>
  <div class="profilecolumn"><b>ARBEITSORT</b> 8752 Näfels, Oberdorf 54</div>
  <div class="shifttype">50 - 70%</div>
  <div class="description">
    <p><b>Aufgaben</b></p>
    <ul>
      <li>Warenbereitstellung</li>
      <li>Kassieren und Kundenberatung</li>
      <li>Reinigung der Filiale</li>
    </ul>
    <p><b>Profil</b></p>
    <ul>
      <li>Berufserfahrung im Verkauf</li>
      <li>Gute Deutschkenntnisse</li>
    </ul>
  </div>
</body></html>`;

// --- Fixture: Homepage with /job/{id} links ---
const LISTING_HTML = `
<html>
<body>
<div class="topjobs">
  <a href="/job/1007064001">
    Area Manager - Genf / Lausanne
    100%
    Mostra
  </a>
  <a href="/job/1224938701">
    Lernender Detailhandel (m/w/d)
    100%
    Mostra
  </a>
  <a href="https://career5.successfactors.eu/career?company=aldisuis&jobId=12345">
    Filialleiter/in
    100%
    6500 Bellinzona
    Mostra
  </a>
</div>
</body>
</html>`;

// --- Fixture: Detail page ---
const DETAIL_HTML = `
<html>
<body>
<main>
  <h1>Area Manager (100%)</h1>
  <p>Standort: Bellinzona</p>
  <div class="content">
    <p>ALDI SUISSE cerca un Area Manager per la regione del Ticino.
    La posizione prevede la gestione di diversi punti vendita nella
    regione, con responsabilita operativa e strategica. Il candidato
    ideale ha esperienza nel retail e ottime capacita di leadership.</p>
    <h3>Il tuo profilo</h3>
    <ul>
      <li>Formazione commerciale completata</li>
      <li>Esperienza nel settore retail</li>
      <li>Capacita di leadership</li>
      <li>Italiano e tedesco fluenti</li>
    </ul>
    <h3>Offriamo</h3>
    <ul>
      <li>Stipendio competitivo</li>
      <li>Auto aziendale</li>
      <li>Formazione continua</li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ===================================================================
// parseAldiSearchResults (live REST discovery path)
// ===================================================================

describe('parseAldiSearchResults', () => {
  it('extracts job rows from the REST payload', () => {
    const rows = parseAldiSearchResults(SEARCH_JSON);
    // 3 input rows, 1 duplicate URL → 2 unique
    expect(rows.length).toBe(2);
  });

  it('builds absolute detail URLs from relative job/{id}', () => {
    const rows = parseAldiSearchResults(SEARCH_JSON);
    expect(rows[0].url).toBe('https://www.jobs.aldi.ch/job/1271973201');
  });

  it('carries the structured location fields (city/zip/address)', () => {
    const rows = parseAldiSearchResults(SEARCH_JSON);
    expect(rows[0].city).toBe('Näfels');
    expect(rows[0].zip).toBe('8752');
    expect(rows[0].address).toBe('Oberdorf 54');
  });

  it('uses shift_type as the human workload, not the numeric workload score', () => {
    const rows = parseAldiSearchResults(SEARCH_JSON);
    expect(rows[0].workload).toBe('50 - 70%');
  });

  it('deduplicates rows that share a URL', () => {
    const rows = parseAldiSearchResults(SEARCH_JSON);
    const naefels = rows.filter((r) => r.url.includes('1271973201'));
    expect(naefels.length).toBe(1);
  });

  it('deduplicates rows that share an rmk_id even with different job/{id} URLs (cross-language variant, #3119 item 3)', () => {
    const rows = parseAldiSearchResults(SEARCH_JSON_CROSS_LINGUA);
    expect(rows.length).toBe(1);
    expect(rows[0].jobId).toBe('2001000001');
  });

  it('accepts a raw JSON string payload', () => {
    const rows = parseAldiSearchResults(JSON.stringify(SEARCH_JSON));
    expect(rows.length).toBe(2);
  });

  it('returns empty array for malformed / empty input', () => {
    expect(parseAldiSearchResults('')).toEqual([]);
    expect(parseAldiSearchResults('not json')).toEqual([]);
    expect(parseAldiSearchResults(null)).toEqual([]);
    expect(parseAldiSearchResults({})).toEqual([]);
    expect(parseAldiSearchResults({ jobs: [] })).toEqual([]);
  });
});

// ===================================================================
// parseAldiListingPage
// ===================================================================

describe('parseAldiListingPage', () => {
  it('extracts job URLs from listing page', () => {
    const results = parseAldiListingPage(LISTING_HTML);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts /job/{id} direct links', () => {
    const results = parseAldiListingPage(LISTING_HTML);
    const jobIdUrls = results.filter((r) => r.url.includes('/job/'));
    expect(jobIdUrls.length).toBeGreaterThanOrEqual(2);
  });

  it('includes SuccessFactors URLs', () => {
    const results = parseAldiListingPage(LISTING_HTML);
    const sfUrls = results.filter((r) => r.url.includes('successfactors'));
    expect(sfUrls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseAldiListingPage('')).toEqual([]);
    expect(parseAldiListingPage(null)).toEqual([]);
  });

  it('returns empty array for page without job links', () => {
    const noJobsHtml = '<html><body><p>Coming soon</p></body></html>';
    expect(parseAldiListingPage(noJobsHtml)).toEqual([]);
  });

  it('deduplicates URLs', () => {
    const dupeHtml = `
      <a href="/job/123">Job A - 100% - Mostra</a>
      <a href="/job/123">Job A dup - 100% - Mostra</a>
    `;
    const results = parseAldiListingPage(dupeHtml);
    expect(results.length).toBe(1);
  });
});

// ===================================================================
// parseAldiDetailPage
// ===================================================================

describe('parseAldiDetailPage', () => {
  it('extracts title', () => {
    const result = parseAldiDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Area Manager (100%)');
  });

  it('extracts location', () => {
    const result = parseAldiDetailPage(DETAIL_HTML);
    expect(result.location).toBe('Bellinzona');
  });

  it('extracts percentage', () => {
    const result = parseAldiDetailPage(DETAIL_HTML);
    expect(result.percentage).toBe('100%');
  });

  it('extracts body text', () => {
    const result = parseAldiDetailPage(DETAIL_HTML);
    expect(result.body).toContain('Area Manager');
    expect(result.body).toContain('retail');
  });

  it('returns null for empty input', () => {
    expect(parseAldiDetailPage('')).toBeNull();
    expect(parseAldiDetailPage(null)).toBeNull();
  });

  it('extracts the body from the live TYPO3 <div class="description">', () => {
    const result = parseAldiDetailPage(DETAIL_TYPO3_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Mitarbeiter Verkauf (m/w/d)');
    expect(result.body).toContain('Aufgaben');
    expect(result.body).toContain('Kassieren');
    expect(result.body).toContain('Profil');
  });

  it('extracts bullet requirements from the description block', () => {
    const result = parseAldiDetailPage(DETAIL_TYPO3_HTML);
    expect(result.requirements.length).toBe(5);
    expect(result.requirements).toContain('Warenbereitstellung');
    expect(result.requirements).toContain('Gute Deutschkenntnisse');
  });

  it('does not truncate the body when the description block has nested <div>s', () => {
    const nestedHtml = `
<html><body>
  <h1 class="title">Filialleiter (m/w/d)</h1>
  <div class="description">
    <div class="section"><p><b>Aufgaben</b></p>
      <ul><li>Filialführung</li></ul>
    </div>
    <div class="section"><p><b>Profil</b></p>
      <ul><li>Berufserfahrung im Detailhandel</li></ul>
    </div>
    <p>Unser Angebot: attraktive Anstellungsbedingungen.</p>
  </div>
</body></html>`;
    const result = parseAldiDetailPage(nestedHtml);
    expect(result).not.toBeNull();
    // First nested </div> must NOT end the capture: later sections survive.
    expect(result.body).toContain('Aufgaben');
    expect(result.body).toContain('Profil');
    expect(result.body).toContain('Unser Angebot');
    expect(result.requirements).toContain('Filialführung');
    expect(result.requirements).toContain('Berufserfahrung im Detailhandel');
  });
});

// ===================================================================
// isAldiTicinoJob
// ===================================================================

describe('isAldiTicinoJob', () => {
  it('returns true for Bellinzona', () => {
    expect(isAldiTicinoJob({ location: 'Bellinzona' })).toBe(true);
  });

  it('returns true for canton TI', () => {
    expect(isAldiTicinoJob({ canton: 'TI' })).toBe(true);
  });

  it('returns false for Zurich', () => {
    expect(isAldiTicinoJob({ location: 'Zurich' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAldiTicinoJob(null)).toBe(false);
  });

  it('returns true for Giubiasco', () => {
    expect(isAldiTicinoJob({ location: 'Giubiasco' })).toBe(true);
  });
});

// ===================================================================
// isAldiJob
// ===================================================================

describe('isAldiJob', () => {
  it('matches by companyKey', () => {
    expect(isAldiJob({ companyKey: 'aldi-suisse' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isAldiJob({ company: 'ALDI SUISSE' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isAldiJob({ url: 'https://www.jobs.aldi.ch/job/1007064001' })).toBe(true);
  });

  it('matches SuccessFactors URL', () => {
    expect(isAldiJob({ url: 'https://career5.successfactors.eu/career?company=aldisuis&jobId=123' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isAldiJob({ companyKey: 'lidl', company: 'Lidl' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAldiJob(null)).toBe(false);
  });
});

// ===================================================================
// Constants
// ===================================================================

describe('ALDI_SUCCESSFACTORS_BASE', () => {
  it('points to SuccessFactors with ALDI company', () => {
    expect(ALDI_SUCCESSFACTORS_BASE).toContain('successfactors');
    expect(ALDI_SUCCESSFACTORS_BASE).toContain('aldisuis');
  });
});

describe('ALDI_SEARCH_API', () => {
  it('points to the jobs.aldi.ch REST job-search endpoint', () => {
    expect(ALDI_SEARCH_API).toBe('https://www.jobs.aldi.ch/rest/jobs/search');
  });
});
