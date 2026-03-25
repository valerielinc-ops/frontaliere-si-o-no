/**
 * ALDI Suisse crawler parser tests
 *
 * Tests parseAldiListingPage(), parseAldiDetailPage(),
 * isAldiTicinoJob(), isAldiJob(), and constants.
 */
import { describe, it, expect } from 'vitest';

import {
  parseAldiListingPage,
  parseAldiDetailPage,
  isAldiTicinoJob,
  isAldiJob,
  ALDI_SUCCESSFACTORS_BASE,
} from '@/scripts/lib/aldi-suisse-job-parser.mjs';

// ─── Fixture: Listing page ───
const LISTING_HTML = `
<html>
<body>
<div class="topjobs">
  <a href="/it/ricerca-posizione?area=ticino">
    Area Manager - Ticino
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

// ─── Fixture: Detail page ───
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

// ═══════════════════════════════════════════════════════════════
// parseAldiListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseAldiListingPage', () => {
  it('extracts job URLs from listing page', () => {
    const results = parseAldiListingPage(LISTING_HTML);
    expect(results.length).toBeGreaterThanOrEqual(1);
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
      <a href="https://career5.successfactors.eu/career?company=aldisuis&jobId=123">Job A - 100% - Mostra</a>
      <a href="https://career5.successfactors.eu/career?company=aldisuis&jobId=123">Job A dup - 100% - Mostra</a>
    `;
    const results = parseAldiListingPage(dupeHtml);
    expect(results.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseAldiDetailPage
// ═══════════════════════════════════════════════════════════════

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
});

// ═══════════════════════════════════════════════════════════════
// isAldiTicinoJob
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// isAldiJob
// ═══════════════════════════════════════════════════════════════

describe('isAldiJob', () => {
  it('matches by companyKey', () => {
    expect(isAldiJob({ companyKey: 'aldi-suisse' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isAldiJob({ company: 'ALDI SUISSE' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isAldiJob({ url: 'https://www.jobs.aldi.ch/it/job/123' })).toBe(true);
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

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

describe('ALDI_SUCCESSFACTORS_BASE', () => {
  it('points to SuccessFactors with ALDI company', () => {
    expect(ALDI_SUCCESSFACTORS_BASE).toContain('successfactors');
    expect(ALDI_SUCCESSFACTORS_BASE).toContain('aldisuis');
  });
});
