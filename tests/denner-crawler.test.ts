/**
 * Denner crawler parser tests
 *
 * Tests parseDennerListingPage(), parseDennerDetailPage(),
 * isDennerTicinoJob(), isDennerJob(), and constants.
 */
import { describe, it, expect } from 'vitest';

import {
  parseDennerListingPage,
  parseDennerDetailPage,
  isDennerTicinoJob,
  isDennerJob,
  DENNER_PORTAL_URL,
} from '@/scripts/lib/denner-job-parser.mjs';

// ─── Fixture: Migros portal listing page ───
const LISTING_HTML = `
<html>
<body>
<div class="job-list">
  <a href="/it/offerte-di-lavoro/venditore-filiale-lugano-12345">
    Venditore/Venditrice Filiale Lugano
  </a>
  <a href="/it/offerte-di-lavoro/responsabile-filiale-bellinzona-12346">
    Responsabile Filiale Bellinzona
  </a>
  <a href="/de/stellenangebote/filialleiter-chiasso-12347">
    Filialleiter/in Chiasso
  </a>
</div>
</body>
</html>`;

// ─── Fixture: Detail page ───
const DETAIL_HTML = `
<html>
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "Venditore/Venditrice",
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Lugano"
      }
    }
  }
  </script>
</head>
<body>
<main>
  <h1>Venditore/Venditrice (60-100%)</h1>
  <div class="content">
    <p>Denner cerca un/una venditore/venditrice per la filiale di Lugano.
    La posizione prevede il servizio alla clientela, la gestione della cassa
    e il rifornimento degli scaffali. Offriamo un ambiente di lavoro
    piacevole e condizioni contrattuali interessanti secondo il CCL del
    commercio al dettaglio.</p>
    <h3>Le tue responsabilita</h3>
    <ul>
      <li>Servizio alla clientela</li>
      <li>Gestione cassa</li>
      <li>Rifornimento scaffali</li>
      <li>Controllo qualita prodotti</li>
    </ul>
    <h3>Il tuo profilo</h3>
    <ul>
      <li>Formazione nel commercio al dettaglio</li>
      <li>Italiano fluente</li>
      <li>Orientamento al cliente</li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseDennerListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseDennerListingPage', () => {
  it('extracts job URLs from listing page', () => {
    const results = parseDennerListingPage(LISTING_HTML);
    expect(results.length).toBe(3);
  });

  it('builds absolute URLs with jobs.migros.ch domain', () => {
    const results = parseDennerListingPage(LISTING_HTML);
    expect(results[0].url).toContain('jobs.migros.ch');
  });

  it('handles both Italian and German URL patterns', () => {
    const results = parseDennerListingPage(LISTING_HTML);
    const itUrls = results.filter((r) => r.url.includes('/it/'));
    const deUrls = results.filter((r) => r.url.includes('/de/'));
    expect(itUrls.length).toBe(2);
    expect(deUrls.length).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseDennerListingPage('')).toEqual([]);
    expect(parseDennerListingPage(null)).toEqual([]);
  });

  it('deduplicates URLs', () => {
    const dupeHtml = `
      <a href="/it/offerte-di-lavoro/test-123">Test</a>
      <a href="/it/offerte-di-lavoro/test-123">Test Dup</a>
    `;
    const results = parseDennerListingPage(dupeHtml);
    expect(results.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDennerDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDennerDetailPage', () => {
  it('extracts title', () => {
    const result = parseDennerDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toContain('Venditore');
  });

  it('extracts location from JSON-LD', () => {
    const result = parseDennerDetailPage(DETAIL_HTML);
    expect(result.location).toBe('Lugano');
  });

  it('extracts percentage', () => {
    const result = parseDennerDetailPage(DETAIL_HTML);
    expect(result.percentage).toContain('60');
  });

  it('extracts body text', () => {
    const result = parseDennerDetailPage(DETAIL_HTML);
    expect(result.body).toContain('filiale di Lugano');
  });

  it('returns null for empty input', () => {
    expect(parseDennerDetailPage('')).toBeNull();
    expect(parseDennerDetailPage(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// isDennerTicinoJob
// ═══════════════════════════════════════════════════════════════

describe('isDennerTicinoJob', () => {
  it('returns true for Lugano', () => {
    expect(isDennerTicinoJob({ location: 'Lugano' })).toBe(true);
  });

  it('returns true for canton TI', () => {
    expect(isDennerTicinoJob({ canton: 'TI' })).toBe(true);
  });

  it('returns false for Bern', () => {
    expect(isDennerTicinoJob({ location: 'Bern' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDennerTicinoJob(null)).toBe(false);
  });

  it('returns true for Massagno', () => {
    expect(isDennerTicinoJob({ location: 'Massagno' })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// isDennerJob
// ═══════════════════════════════════════════════════════════════

describe('isDennerJob', () => {
  it('matches by companyKey', () => {
    expect(isDennerJob({ companyKey: 'denner' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isDennerJob({ company: 'Denner SA' })).toBe(true);
  });

  it('matches by Migros portal URL with denner', () => {
    expect(isDennerJob({ url: 'https://jobs.migros.ch/it/offerte-di-lavoro/denner-venditore' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isDennerJob({ companyKey: 'lidl', company: 'Lidl' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDennerJob(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

describe('DENNER_PORTAL_URL', () => {
  it('points to Migros Group portal', () => {
    expect(DENNER_PORTAL_URL).toContain('jobs.migros.ch');
    expect(DENNER_PORTAL_URL).toContain('denner');
  });
});
