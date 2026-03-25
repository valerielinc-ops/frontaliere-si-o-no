/**
 * TPL (Trasporti Pubblici Luganesi) crawler parser tests
 *
 * Tests parseTplListingPage(), parseTplDetailPage(), and isTplJob()
 * using realistic HTML fixtures.
 */
import { describe, it, expect } from 'vitest';

import {
  parseTplListingPage,
  parseTplDetailPage,
  isTplJob,
} from '@/scripts/lib/tpl-lugano-job-parser.mjs';

// ─── Fixture: Listing page with jobs ───
const LISTING_WITH_JOBS_HTML = `
<html>
<body>
<div class="content">
  <h1>TPL - Lavora con noi</h1>
  <p>Le seguenti posizioni sono aperte:</p>
  <a href="/2/51/autista-autobus.html">Autista Autobus</a>
  <a href="/2/52/meccanico-officina.html">Meccanico Officina</a>
  <a href="/2/53/impiegato-amministrativo.html">Impiegato Amministrativo</a>
</div>
</body>
</html>`;

// ─── Fixture: Listing page with no jobs ───
const LISTING_NO_JOBS_HTML = `
<html>
<body>
<div class="content">
  <h1>TPL - Lavora con noi</h1>
  <p>Non ci sono risultati nell'area selezionata.</p>
  <p>Unicamente per candidature spontanee, preghiamo di utilizzare il seguente formulario.</p>
</div>
</body>
</html>`;

// ─── Fixture: Detail page ───
const DETAIL_HTML = `
<html>
<body>
<main>
  <h1>Autista Autobus</h1>
  <div class="content">
    <p>TPL SA cerca un autista per il servizio di trasporto pubblico nella regione
    di Lugano. Il candidato deve possedere la patente di categoria D e avere
    esperienza nella guida di veicoli pesanti. Offriamo un ambiente di lavoro
    dinamico e un contratto a tempo indeterminato con benefit aziendali.</p>
    <h3>Requisiti</h3>
    <ul>
      <li>Patente categoria D</li>
      <li>Esperienza minima 2 anni</li>
      <li>Conoscenza italiano</li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseTplListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseTplListingPage', () => {
  it('extracts job URLs from listing page with jobs', () => {
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results.length).toBe(3);
  });

  it('builds absolute URLs with tplsa.ch domain', () => {
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results[0].url).toContain('tplsa.ch');
  });

  it('extracts correct titles', () => {
    const results = parseTplListingPage(LISTING_WITH_JOBS_HTML);
    expect(results[0].title).toBe('Autista Autobus');
  });

  it('returns empty array when no jobs listed', () => {
    const results = parseTplListingPage(LISTING_NO_JOBS_HTML);
    expect(results).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseTplListingPage('')).toEqual([]);
    expect(parseTplListingPage(null)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseTplDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseTplDetailPage', () => {
  it('extracts title from detail page', () => {
    const result = parseTplDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Autista Autobus');
  });

  it('sets location to Lugano', () => {
    const result = parseTplDetailPage(DETAIL_HTML);
    expect(result.location).toBe('Lugano');
  });

  it('extracts body text', () => {
    const result = parseTplDetailPage(DETAIL_HTML);
    expect(result.body).toContain('trasporto pubblico');
  });

  it('returns null for empty input', () => {
    expect(parseTplDetailPage('')).toBeNull();
    expect(parseTplDetailPage(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// isTplJob
// ═══════════════════════════════════════════════════════════════

describe('isTplJob', () => {
  it('matches by companyKey', () => {
    expect(isTplJob({ companyKey: 'tpl-lugano', company: '' })).toBe(true);
  });

  it('matches by company name containing TPL', () => {
    expect(isTplJob({ companyKey: '', company: 'TPL SA' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isTplJob({ companyKey: '', company: '', url: 'https://www.tplsa.ch/job/123' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isTplJob({ companyKey: 'lidl', company: 'Lidl', url: 'https://lidl.ch' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTplJob(null)).toBe(false);
  });
});
