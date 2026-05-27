/**
 * Decathlon Suisse crawler parser tests
 *
 * Tests parseDecathlonListingPage(), parseDecathlonDetailPage(),
 * isDecathlonTicinoJob(), and constants.
 */
import { describe, it, expect } from 'vitest';

import {
  parseDecathlonListingPage,
  parseDecathlonDetailPage,
  isDecathlonTicinoJob,
  DECATHLON_API_BASE,
} from '@/scripts/lib/decathlon-job-parser.mjs';

// ─── Fixture: Listing page with job links ───
const LISTING_HTML = `
<html>
<body>
<div class="job-list">
  <a href="/it_CH/annonces/venditore-sport-lugano-12345">Venditore Sport - Lugano</a>
  <a href="/it_CH/annonces/responsabile-reparto-bellinzona-12346">Responsabile Reparto - Bellinzona</a>
  <a href="/it_CH/annonce/magazziniere-sant-antonino-12347">Magazziniere - Sant'Antonino</a>
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
    "title": "Venditore Sport",
    "employmentType": "FULL_TIME",
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
  <h1>Venditore Sport</h1>
  <div class="description">
    <p>Decathlon cerca un venditore appassionato di sport per il negozio
    di Lugano. Il candidato ideale ha esperienza nel retail e una forte
    passione per lo sport. Offriamo un ambiente di lavoro dinamico e
    opportunita di crescita professionale all'interno del gruppo.</p>
    <h3>Le tue responsabilita</h3>
    <ul>
      <li>Accoglienza e consulenza clienti</li>
      <li>Gestione del reparto assegnato</li>
      <li>Rifornimento scaffali e visual merchandising</li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseDecathlonListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseDecathlonListingPage', () => {
  it('extracts job URLs from listing page', () => {
    const results = parseDecathlonListingPage(LISTING_HTML);
    expect(results.length).toBe(3);
  });

  it('builds absolute URLs with decathlon.ch domain', () => {
    const results = parseDecathlonListingPage(LISTING_HTML);
    expect(results[0].url).toContain('joinus.decathlon.ch');
  });

  it('extracts titles', () => {
    const results = parseDecathlonListingPage(LISTING_HTML);
    expect(results[0].title).toContain('Venditore Sport');
  });

  it('returns empty array for empty input', () => {
    expect(parseDecathlonListingPage('')).toEqual([]);
    expect(parseDecathlonListingPage(null)).toEqual([]);
  });

  it('deduplicates URLs', () => {
    const dupeHtml = `
      <a href="/it_CH/annonces/test-123">Test Job</a>
      <a href="/it_CH/annonces/test-123">Test Job Dup</a>
    `;
    const results = parseDecathlonListingPage(dupeHtml);
    expect(results.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDecathlonDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDecathlonDetailPage', () => {
  it('extracts title', () => {
    const result = parseDecathlonDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Venditore Sport');
  });

  it('extracts location from JSON-LD', () => {
    const result = parseDecathlonDetailPage(DETAIL_HTML);
    expect(result.location).toBe('Lugano');
  });

  it('extracts contract type', () => {
    const result = parseDecathlonDetailPage(DETAIL_HTML);
    expect(result.contract).toBe('FULL_TIME');
  });

  it('extracts body text', () => {
    const result = parseDecathlonDetailPage(DETAIL_HTML);
    expect(result.body).toContain('venditore appassionato');
  });

  it('returns null for empty input', () => {
    expect(parseDecathlonDetailPage('')).toBeNull();
    expect(parseDecathlonDetailPage(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// isDecathlonTicinoJob
// ═══════════════════════════════════════════════════════════════

describe('isDecathlonTicinoJob', () => {
  it('returns true for Lugano', () => {
    expect(isDecathlonTicinoJob({ location: 'Lugano' })).toBe(true);
  });

  it('returns true for canton TI', () => {
    expect(isDecathlonTicinoJob({ canton: 'TI' })).toBe(true);
  });

  it('returns true for Sant\'Antonino', () => {
    expect(isDecathlonTicinoJob({ location: 'Sant\'Antonino' })).toBe(true);
  });

  it('returns false for Zurich', () => {
    // Cathedral 2026-05-10: Zurich (ZH) is now a target canton — assertion updated to true.
    expect(isDecathlonTicinoJob({ location: 'Zurich' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isDecathlonTicinoJob(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

describe('DECATHLON_API_BASE', () => {
  it('points to Digital Recruiters API', () => {
    expect(DECATHLON_API_BASE).toContain('digitalrecruiters.com');
  });
});
