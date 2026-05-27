/**
 * Allianz Suisse — Umantis ATS crawler parser tests
 *
 * Tests parseAllianzDetailPage(), parseAllianzListingPage(), inferAllianzCanton()
 * using HTML fixtures mirroring the real Umantis ATS page structure.
 *
 * Regression case: "consulente-previdenziale-per-l-agenzia-generale-chur-100-allianz-bewerbermanagement"
 *   https://recruitingapp-2872.umantis.com/Vacancies/404/Description/4
 *   — og:title was absent; <title> was "Job Title -- Allianz Bewerbermanagement"
 *   — the old regex only stripped "-- DE", leaving "Allianz Bewerbermanagement" in the title
 *   — fix: strip everything after "--" from <title>; prefer h1 as ground truth
 */
import { describe, it, expect } from 'vitest';

import {
  parseAllianzDetailPage,
  parseAllianzListingPage,
  inferAllianzCanton,
} from '@/scripts/lib/allianz-job-parser.mjs';

// ─── Fixtures: detail pages ────────────────────────────────────────────────

// Normal case: og:title present and consistent with h1
const FIXTURE_DETAIL_FULL = `<!DOCTYPE html>
<html lang="it">
<head>
  <title>Consulente clientela aziendale 100% -- Allianz Bewerbermanagement</title>
  <meta property="og:title" content="Consulente clientela aziendale 100%" />
  <meta property="og:site_name" content="Allianz Bewerbermanagement" />
</head>
<body>
  <h1>Consulente clientela aziendale 100%</h1>
  <div class="content">
    <p>Cosa ti proponiamo</p>
    <ul>
      <li>Un ambiente di lavoro stimolante e dinamico con oltre 50 anni di storia nel settore assicurativo svizzero.</li>
      <li>Formazione continua e sviluppo professionale con accesso a corsi interni ed esterni.</li>
      <li>Compensazione variabile attrattiva legata ai risultati raggiunti.</li>
    </ul>
    <p>Cosa ti chiediamo</p>
    <ul>
      <li>Esperienza nella consulenza aziendale e nella gestione di portafogli clienti.</li>
      <li>Ottima conoscenza del mercato ticinese e delle sue dinamiche economiche.</li>
      <li>Capacità di lavorare in modo autonomo e orientamento al cliente.</li>
    </ul>
    <p>Piazza del Sole<br>6500 Bellinzona</p>
  </div>
</body>
</html>`;

// Regression: og:title ABSENT — falls back to <title> with "-- Allianz Bewerbermanagement"
// Old code: strips only "-- DE", leaving "-- Allianz Bewerbermanagement" in title
// New code: strips everything after "--", then falls back to h1
const FIXTURE_DETAIL_NO_OG_TITLE = `<!DOCTYPE html>
<html lang="it">
<head>
  <title>Consulente previdenziale per l'Agenzia Generale Chur 100% -- Allianz Bewerbermanagement</title>
  <meta property="og:site_name" content="Allianz Bewerbermanagement" />
</head>
<body>
  <h1>Consulente previdenziale per l'Agenzia Generale Chur 100%</h1>
  <div class="content">
    <p>Cosa ti proponiamo</p>
    <ul>
      <li>Un ruolo dinamico nella consulenza previdenziale e assicurativa per clienti privati e aziendali.</li>
      <li>Supporto completo nella fase iniziale con formazione personalizzata.</li>
      <li>Ottime condizioni di compensazione e benefit aziendali.</li>
    </ul>
    <p>Cosa ti chiediamo</p>
    <ul>
      <li>Esperienza in ambito assicurativo o finanziario, idealmente nella previdenza.</li>
      <li>Conoscenza del mercato retico e affinità con la clientela germanofona.</li>
    </ul>
    <p>Alte Schanfiggerstrasse 7<br>7000 Chur</p>
  </div>
</body>
</html>`;

// Case: og:title present but diverges significantly from h1 (overlap < 0.7)
// Should prefer h1 over og:title
const FIXTURE_DETAIL_OGTITLE_MISMATCH = `<!DOCTYPE html>
<html lang="it">
<head>
  <title>Allianz Bewerbermanagement -- Allianz Bewerbermanagement</title>
  <meta property="og:title" content="Allianz Bewerbermanagement" />
  <meta property="og:site_name" content="Allianz Bewerbermanagement" />
</head>
<body>
  <h1>Broker Assicurativo Indipendente 100%</h1>
  <div class="content">
    <p>Cosa ti proponiamo</p>
    <ul>
      <li>Indipendenza e flessibilità nella gestione del proprio portafoglio clienti assicurativi.</li>
      <li>Accesso a prodotti Allianz Suisse con condizioni preferenziali per intermediari.</li>
    </ul>
  </div>
</body>
</html>`;

// Case: no h1, no og:title — falls back to cleaned <title>
const FIXTURE_DETAIL_FALLBACK_TO_TITLE = `<!DOCTYPE html>
<html lang="it">
<head>
  <title>Responsabile Sinistri Auto -- Allianz Suisse AG</title>
  <meta property="og:site_name" content="Allianz Suisse AG" />
</head>
<body>
  <div class="content">
    <p>Cosa ti proponiamo</p>
    <ul>
      <li>Ruolo chiave nella gestione dei sinistri auto con responsabilità crescenti.</li>
      <li>Ambiente di lavoro collaborativo con team specializzati nel settore danni.</li>
    </ul>
  </div>
</body>
</html>`;

// Case: complete fallback to listing title when no usable title found
const FIXTURE_DETAIL_ALL_GENERIC = `<!DOCTYPE html>
<html lang="it">
<head>
  <title>Allianz Bewerbermanagement -- Allianz Bewerbermanagement</title>
  <meta property="og:title" content="Allianz Bewerbermanagement" />
  <meta property="og:site_name" content="Allianz Bewerbermanagement" />
</head>
<body>
  <div class="content"><p>Some content here.</p></div>
</body>
</html>`;

// ─── Fixtures: listing page ────────────────────────────────────────────────

const FIXTURE_LISTING_PAGE = `<!DOCTYPE html>
<html lang="it">
<head><title>Jobs - Allianz Bewerbermanagement</title></head>
<body>
<table>
  <tr class="tableaslist_contentrow1">
    <td><span class="tableaslist_element_1152486">Agenzia Generale Lugano</span></td>
    <td><span class="tableaslist_element_1152488">
      <a href="/Vacancies/101/Description/4">Consulente clientela aziendale 100%</a>
    </span></td>
    <td><span class="tableaslist_element_1152495">Lugano</span></td>
  </tr>
  <tr class="tableaslist_contentrow2">
    <td><span class="tableaslist_element_1152486">Agenzia Generale Bellinzona</span></td>
    <td><span class="tableaslist_element_1152488">
      <a href="/Vacancies/202/Description/4">Responsabile Sinistri Auto</a>
    </span></td>
    <td><span class="tableaslist_element_1152495">Bellinzona</span></td>
  </tr>
  <tr class="tableaslist_contentrow1">
    <td><span class="tableaslist_element_1152486">Agenzia Generale Lugano</span></td>
    <td><span class="tableaslist_element_1152488">
      <a href="/Vacancies/101/Description/4">Consulente clientela aziendale 100%</a>
    </span></td>
    <td><span class="tableaslist_element_1152495">Lugano</span></td>
  </tr>
</table>
</body>
</html>`;

// ─── parseAllianzDetailPage — normal case ─────────────────────────────────

describe('parseAllianzDetailPage — normal case (og:title present)', () => {
  it('extracts title from og:title when consistent with h1', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_FULL);
    expect(title).toBe('Consulente clientela aziendale 100%');
  });

  it('does not include site name in title', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_FULL);
    expect(title).not.toContain('Allianz Bewerbermanagement');
  });

  it('extracts agency from og:site_name', () => {
    const { agency } = parseAllianzDetailPage(FIXTURE_DETAIL_FULL);
    expect(agency).toBe('Allianz Bewerbermanagement');
  });

  it('extracts location from body (Bellinzona postal code 6500)', () => {
    const { location } = parseAllianzDetailPage(FIXTURE_DETAIL_FULL, '', '');
    expect(location.toLowerCase()).toContain('bellinzona');
  });

  it('extracts description containing Cosa ti proponiamo content', () => {
    const { description } = parseAllianzDetailPage(FIXTURE_DETAIL_FULL);
    expect(description).toContain('ambiente di lavoro stimolante');
  });
});

// ─── parseAllianzDetailPage — regression (no og:title) ──────────────────

describe('parseAllianzDetailPage — regression vacancy 404 (og:title absent)', () => {
  it('extracts correct title from h1, not the title tag with site name appended', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_NO_OG_TITLE, 'fallback title');
    expect(title).toBe("Consulente previdenziale per l'Agenzia Generale Chur 100%");
  });

  it('does not include "Allianz Bewerbermanagement" in title', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_NO_OG_TITLE);
    expect(title).not.toContain('Allianz Bewerbermanagement');
  });

  it('extracts location from body (Chur postal code 7000)', () => {
    const { location } = parseAllianzDetailPage(FIXTURE_DETAIL_NO_OG_TITLE, '', '');
    expect(location.toLowerCase()).toContain('chur');
  });
});

// ─── parseAllianzDetailPage — og:title diverges from h1 ─────────────────

describe('parseAllianzDetailPage — og:title diverges from h1 (overlap guard)', () => {
  it('prefers h1 when og:title is just the site name', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_OGTITLE_MISMATCH);
    expect(title).toBe('Broker Assicurativo Indipendente 100%');
  });

  it('does not use og:title that equals site name', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_OGTITLE_MISMATCH);
    expect(title).not.toBe('Allianz Bewerbermanagement');
  });
});

// ─── parseAllianzDetailPage — fallback to cleaned <title> ────────────────

describe('parseAllianzDetailPage — fallback to cleaned <title> tag', () => {
  it('strips " -- {SiteName}" suffix from <title> when no h1 or og:title', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_FALLBACK_TO_TITLE);
    expect(title).toBe('Responsabile Sinistri Auto');
  });

  it('does not include site name suffix in cleaned title', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_FALLBACK_TO_TITLE);
    expect(title).not.toContain('Allianz Suisse AG');
  });
});

// ─── parseAllianzDetailPage — ultimate fallback to listing title ──────────

describe('parseAllianzDetailPage — ultimate fallback to listing title', () => {
  it('falls back to provided fallbackTitle when all sources are generic', () => {
    const { title } = parseAllianzDetailPage(FIXTURE_DETAIL_ALL_GENERIC, 'Consulente Assicurativo');
    expect(title).toBe('Consulente Assicurativo');
  });
});

// ─── parseAllianzListingPage ──────────────────────────────────────────────

describe('parseAllianzListingPage', () => {
  it('extracts job rows from tableaslist_contentrow1 and contentrow2', () => {
    const jobs = parseAllianzListingPage(FIXTURE_LISTING_PAGE);
    // 3 rows but 2 unique vacancy IDs (101 deduplicated)
    expect(jobs).toHaveLength(2);
  });

  it('extracts vacancy IDs', () => {
    const jobs = parseAllianzListingPage(FIXTURE_LISTING_PAGE);
    const ids = jobs.map((j: any) => j.vacancyId);
    expect(ids).toContain('101');
    expect(ids).toContain('202');
  });

  it('extracts title from anchor text', () => {
    const jobs = parseAllianzListingPage(FIXTURE_LISTING_PAGE);
    const titles = jobs.map((j: any) => j.title);
    expect(titles).toContain('Consulente clientela aziendale 100%');
    expect(titles).toContain('Responsabile Sinistri Auto');
  });

  it('builds correct detail URL', () => {
    const jobs = parseAllianzListingPage(FIXTURE_LISTING_PAGE);
    const job101 = jobs.find((j: any) => j.vacancyId === '101');
    expect(job101?.detailUrl).toBe('https://recruitingapp-2872.umantis.com/Vacancies/101/Description/4');
  });

  it('deduplicates identical vacancy IDs', () => {
    const jobs = parseAllianzListingPage(FIXTURE_LISTING_PAGE);
    const ids = jobs.map((j: any) => j.vacancyId);
    expect(ids.filter((id: string) => id === '101')).toHaveLength(1);
  });

  it('returns empty array for empty HTML', () => {
    expect(parseAllianzListingPage('')).toHaveLength(0);
  });
});

// ─── inferAllianzCanton ───────────────────────────────────────────────────

describe('inferAllianzCanton', () => {
  it('returns TI for Ticino agency names', () => {
    expect(inferAllianzCanton('Agenzia Generale Lugano', '')).toBe('TI');
  });

  it('returns TI for Ticino locations', () => {
    expect(inferAllianzCanton('', 'Bellinzona')).toBe('TI');
    expect(inferAllianzCanton('', 'Lugano')).toBe('TI');
  });

  it('returns GR for Graubünden locations', () => {
    expect(inferAllianzCanton('', 'Chur')).toBe('GR');
  });

  it('returns correct canton for non-TI/GR Swiss locations', () => {
    expect(inferAllianzCanton('Agenzia Berna', 'Bern')).toBe('BE');
  });
});
