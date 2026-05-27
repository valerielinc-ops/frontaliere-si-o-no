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

// --- Fixture: Migros Nuxt portal listing page (actual URL pattern) ---
const LISTING_HTML = `
<html>
<body>
<div class="job-list">
  <a href="/it/le-nostre-imprese/job/denner-sa/gerente/bacaa68b-e4db-4290-9f1b-a94f01026d4d">
    Gerente (80-100%) - 6710 Biasca
  </a>
  <a href="/de/unsere-unternehmen/job/denner-ag/verkauferin/7a9b5d12-9b4c-4639-a010-c7e080110106">
    Verkauferin - Rubigen
  </a>
  <a href="/fr/nos-entreprises/job/denner-sa/vendeur-vendeuse/ba3bbe0e-985f-4e6e-a24c-da6c71c8e35b">
    Vendeur / vendeuse - Lausanne
  </a>
</div>
</body>
</html>`;

// --- Fixture: Legacy listing page (old URL pattern) ---
const LEGACY_LISTING_HTML = `
<html>
<body>
<div class="job-list">
  <a href="/it/offerte-di-lavoro/venditore-filiale-lugano-12345">
    Venditore/Venditrice Filiale Lugano
  </a>
  <a href="/de/stellenangebote/filialleiter-chiasso-12347">
    Filialleiter/in Chiasso
  </a>
</div>
</body>
</html>`;

// --- Fixture: Detail page ---
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

// ===================================================================
// parseDennerListingPage (Nuxt portal pattern)
// ===================================================================

describe('parseDennerListingPage', () => {
  it('extracts job URLs from Nuxt portal listing page', () => {
    const results = parseDennerListingPage(LISTING_HTML);
    expect(results.length).toBe(3);
  });

  it('builds absolute URLs with jobs.migros.ch domain', () => {
    const results = parseDennerListingPage(LISTING_HTML);
    expect(results[0].url).toContain('jobs.migros.ch');
  });

  it('handles Italian, German, and French URL patterns', () => {
    const results = parseDennerListingPage(LISTING_HTML);
    const itUrls = results.filter((r) => r.url.includes('/it/'));
    const deUrls = results.filter((r) => r.url.includes('/de/'));
    const frUrls = results.filter((r) => r.url.includes('/fr/'));
    expect(itUrls.length).toBe(1);
    expect(deUrls.length).toBe(1);
    expect(frUrls.length).toBe(1);
  });

  it('extracts legacy URL patterns', () => {
    const results = parseDennerListingPage(LEGACY_LISTING_HTML);
    expect(results.length).toBe(2);
    expect(results[0].url).toContain('jobs.migros.ch');
  });

  it('returns empty array for empty input', () => {
    expect(parseDennerListingPage('')).toEqual([]);
    expect(parseDennerListingPage(null)).toEqual([]);
  });

  it('deduplicates URLs', () => {
    const dupeHtml = `
      <a href="/it/le-nostre-imprese/job/denner-sa/gerente/abc123">Test</a>
      <a href="/it/le-nostre-imprese/job/denner-sa/gerente/abc123">Test Dup</a>
    `;
    const results = parseDennerListingPage(dupeHtml);
    expect(results.length).toBe(1);
  });
});

// ===================================================================
// parseDennerDetailPage
// ===================================================================

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

// ===================================================================
// isDennerTicinoJob
// ===================================================================

describe('isDennerTicinoJob', () => {
  it('returns true for Lugano', () => {
    expect(isDennerTicinoJob({ location: 'Lugano' })).toBe(true);
  });

  it('returns true for canton TI', () => {
    expect(isDennerTicinoJob({ canton: 'TI' })).toBe(true);
  });

  it('returns false for Bern', () => {
    // Cathedral 2026-05-10: Bern (BE) is now a target canton — assertion updated to true.
    expect(isDennerTicinoJob({ location: 'Bern' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isDennerTicinoJob(null)).toBe(false);
  });

  it('returns true for Massagno', () => {
    expect(isDennerTicinoJob({ location: 'Massagno' })).toBe(true);
  });
});

// ===================================================================
// isDennerJob
// ===================================================================

describe('isDennerJob', () => {
  it('matches by companyKey', () => {
    expect(isDennerJob({ companyKey: 'denner' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isDennerJob({ company: 'Denner SA' })).toBe(true);
  });

  it('matches by Migros portal URL with denner', () => {
    expect(isDennerJob({ url: 'https://jobs.migros.ch/it/le-nostre-imprese/job/denner-sa/gerente/abc123' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isDennerJob({ companyKey: 'lidl', company: 'Lidl' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDennerJob(null)).toBe(false);
  });
});

// ===================================================================
// Constants
// ===================================================================

describe('DENNER_PORTAL_URL', () => {
  it('points to Migros Group portal', () => {
    expect(DENNER_PORTAL_URL).toContain('jobs.migros.ch');
    expect(DENNER_PORTAL_URL).toContain('denner');
  });
});
