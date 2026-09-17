/**
 * Capri Holdings (Michael Kors / Versace) crawler parser tests
 *
 * Tests parseCapriHoldingsDetailPage(), isCapriHoldingsSwissJob(),
 * isCapriHoldingsJob(), and CAPRI_WORKDAY_HOSTS constants.
 */
import { describe, it, expect } from 'vitest';

import {
  parseCapriHoldingsDetailPage,
  isCapriHoldingsSwissJob,
  isCapriHoldingsJob,
  CAPRI_WORKDAY_HOSTS,
} from '@/scripts/lib/capri-holdings-job-parser.mjs';
import {
  isSwissWorkdayListing,
  resolveWorkdayLocation,
} from '../scripts/update-capri-holdings-jobs.mjs';
import { resolveSwissStructuredAddress } from '../scripts/lib/swiss-structured-address.mjs';

describe('Capri structured address resolution', () => {
  it('replaces a Mendrisio CAP with the verified CAP for the actual city', () => {
    const address = resolveSwissStructuredAddress({
      city: 'Winterthur',
      canton: 'ZH',
      postalCode: '6850',
      streetAddress: 'Via Penate',
    });

    expect(address).toMatchObject({ city: 'Winterthur', canton: 'ZH', postalCode: '8400' });
    expect(address.streetAddress).not.toBe('Via Penate');
  });

  it('rejects an arbitrary four-digit CAP instead of pairing it with the city', () => {
    expect(resolveSwissStructuredAddress({ city: 'Winterthur', canton: 'ZH', postalCode: '0000' }))
      .toMatchObject({ city: 'Winterthur', canton: 'ZH', postalCode: '8400' });
  });

  it('uses a complete same-canton fallback for an unverified municipality CAP', () => {
    expect(resolveSwissStructuredAddress({ city: 'Küsnacht (ZH)', canton: 'ZH' }))
      .toMatchObject({
        city: 'Zürich', canton: 'ZH', postalCode: '8001', streetAddress: 'Bahnhofstrasse 1',
      });
  });

  it('does not carry a source street into a canton fallback tuple', () => {
    expect(resolveSwissStructuredAddress({
      city: 'Küsnacht (ZH)',
      canton: 'ZH',
      postalCode: '9999',
      streetAddress: 'Via Penate',
    })).toMatchObject({
      city: 'Zürich', canton: 'ZH', postalCode: '8001', streetAddress: 'Bahnhofstrasse 1',
    });
  });
});

describe('Capri Workday location resolution', () => {
  it('accepts a Swiss location in a later bullet field', () => {
    expect(isSwissWorkdayListing({ bulletFields: ['Full time', 'Manno'] })).toBe(true);
  });

  it('accepts an explicit Swiss country signal from the listing', () => {
    expect(isSwissWorkdayListing({ locationCountry: 'Switzerland' })).toBe(true);
  });

  it('does not invent a historical location for a country-only listing', () => {
    const resolved = resolveWorkdayLocation(
      { country: 'Switzerland', bulletFields: ['5 locations'] },
      { country: 'Switzerland' },
    );

    expect(resolved).toMatchObject({
      countryIsSwiss: true,
      locationRaw: '',
      canton: '',
      resolvedSwissSignal: true,
    });
  });

  it('prefers a concrete canton resolved from the detail over the listing', () => {
    const resolved = resolveWorkdayLocation(
      { bulletFields: ['Zurich'] },
      { location: 'Manno' },
    );

    expect(resolved).toMatchObject({
      detailLocation: 'Manno',
      locationRaw: 'Manno',
      canton: 'TI',
    });
  });
});

// ─── Fixture: Workday detail page (Mendrisio) ───
const MENDRISIO_JOB_HTML = `
<html>
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "Warehouse Operator",
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Mendrisio",
        "addressCountry": "CH"
      }
    }
  }
  </script>
</head>
<body>
<main>
  <h1>Warehouse Operator</h1>
  <div class="description">
    <p>Michael Kors is looking for a Warehouse Operator at our Mendrisio
    logistics center. You will be responsible for receiving, storing, and
    distributing merchandise. We offer a dynamic work environment and
    competitive benefits package.</p>
    <h3>Responsibilities</h3>
    <ul>
      <li>Receiving and processing incoming stock</li>
      <li>Picking and filling orders from stock</li>
      <li>Packing and shipping orders</li>
      <li>Managing inventory</li>
    </ul>
    <h3>Requirements</h3>
    <ul>
      <li>Previous warehouse experience</li>
      <li>Physical fitness</li>
      <li>Italian language skills</li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Non-Swiss job (Milan) ───
const MILAN_JOB_HTML = `
<html>
<body>
<main>
  <h1>Store Manager</h1>
  <div class="description">
    <p>Versace is looking for a Store Manager at our Milan boutique.
    The ideal candidate has luxury retail experience.</p>
  </div>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseCapriHoldingsDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseCapriHoldingsDetailPage', () => {
  it('extracts title from detail page', () => {
    const result = parseCapriHoldingsDetailPage(MENDRISIO_JOB_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Warehouse Operator');
  });

  it('extracts location from JSON-LD', () => {
    const result = parseCapriHoldingsDetailPage(MENDRISIO_JOB_HTML);
    expect(result.location).toBe('Mendrisio');
  });

  it('detects Michael Kors brand', () => {
    const result = parseCapriHoldingsDetailPage(MENDRISIO_JOB_HTML);
    expect(result.brand).toBe('Michael Kors');
  });

  it('detects Versace brand', () => {
    const result = parseCapriHoldingsDetailPage(MILAN_JOB_HTML);
    expect(result.brand).toBe('Versace');
  });

  it('extracts body text', () => {
    const result = parseCapriHoldingsDetailPage(MENDRISIO_JOB_HTML);
    expect(result.body).toContain('Warehouse Operator');
    expect(result.body).toContain('logistics center');
  });

  it('returns null for empty input', () => {
    expect(parseCapriHoldingsDetailPage('')).toBeNull();
    expect(parseCapriHoldingsDetailPage(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// isCapriHoldingsSwissJob
// ═══════════════════════════════════════════════════════════════

describe('isCapriHoldingsSwissJob', () => {
  it('returns true for Mendrisio', () => {
    expect(isCapriHoldingsSwissJob({ location: 'Mendrisio' })).toBe(true);
  });

  it('returns true for country CH', () => {
    expect(isCapriHoldingsSwissJob({ country: 'CH' })).toBe(true);
  });

  it('returns true for country Switzerland', () => {
    expect(isCapriHoldingsSwissJob({ country: 'Switzerland' })).toBe(true);
  });

  it('returns false for Milan', () => {
    expect(isCapriHoldingsSwissJob({ location: 'Milan', country: 'IT' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCapriHoldingsSwissJob(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// isCapriHoldingsJob
// ═══════════════════════════════════════════════════════════════

describe('isCapriHoldingsJob', () => {
  it('matches by companyKey', () => {
    expect(isCapriHoldingsJob({ companyKey: 'capri-holdings' })).toBe(true);
  });

  it('matches by Michael Kors company name', () => {
    expect(isCapriHoldingsJob({ company: 'Michael Kors' })).toBe(true);
  });

  it('matches by Versace company name', () => {
    expect(isCapriHoldingsJob({ company: 'Versace' })).toBe(true);
  });

  it('matches by Workday URL', () => {
    expect(isCapriHoldingsJob({ url: 'https://capriholdings.wd1.myworkdayjobs.com/job/123' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isCapriHoldingsJob({ companyKey: 'lidl', company: 'Lidl' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCapriHoldingsJob(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// CAPRI_WORKDAY_HOSTS
// ═══════════════════════════════════════════════════════════════

describe('CAPRI_WORKDAY_HOSTS', () => {
  it('contains at least 2 Workday hosts', () => {
    expect(CAPRI_WORKDAY_HOSTS.length).toBeGreaterThanOrEqual(2);
  });

  it('includes capriholdings Workday host', () => {
    expect(CAPRI_WORKDAY_HOSTS).toContain('capriholdings.wd1.myworkdayjobs.com');
  });
});
