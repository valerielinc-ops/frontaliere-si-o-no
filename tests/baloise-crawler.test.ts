import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  BALOISE_KEY,
  BALOISE_COMPANY_NAME,
  isBaloiseJob,
  isTrustedDomain,
  fetchAllBaloiseJobs,
} from '../scripts/lib/baloise-job-parser.mjs';
import { fetchAllHelvetiaJobs } from '../scripts/lib/helvetia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Baloise shares Prospective.ch medium 1005736 with Helvetia (post-merger
// "Baloise Bank" postings live in the same feed as Helvetia postings,
// discriminated by `szas.sza_workplace` starting with "Baloise"). Both
// parsers hit the same endpoint; the mocks below assert the INVERSE
// filterListing partition (each listing must surface under exactly one of
// the two companyKeys).
const MEDIUM_ENDPOINT_PREFIX = 'https://ohws.prospective.ch/public/v1/medium/1005736/jobs';

function mixedFeedResponse() {
  return new Response(
    JSON.stringify({
      total: 2,
      jobs: [
        {
          szas: {
            sza_title: 'Leiter Assistenz-Hub Privatkunden Bank (w/m/d)',
            sza_workplace: 'Baloise Solothurn, Amthausplatz 4, 4500 Solothurn',
            'sza_location.city': '4500-Solothurn',
            'sza_location.zip': '4500',
            sza_introduction:
              'Werde Teil der neu formierten Helvetia Baloise und gestalte die Zukunft des Schweizer Bankings mit einem motivierten Team in Solothurn. Wir suchen eine engagierte Führungspersönlichkeit für unseren Assistenz-Hub, die unsere Privatkundinnen und Privatkunden mit Herzblut und hoher Servicequalität betreut und das Team fachlich sowie menschlich weiterentwickelt.',
            sza_tasks: '<ul><li>Führung des Assistenz-Teams am Standort Solothurn</li><li>Sicherstellung der Servicequalität im Kundenkontakt</li><li>Zusammenarbeit mit den Kundenberatenden</li></ul>',
            sza_requirements: '<ul><li>Bankausbildung oder gleichwertige Qualifikation</li><li>Mehrjährige Führungserfahrung im Bankumfeld</li><li>Ausgeprägte Kunden- und Serviceorientierung</li></ul>',
            'sza_pensum.min': '100',
            'sza_pensum.max': '100',
          },
          links: {
            directlink:
              'https://jobs.helvetia.com/offene-stellen/leiter-assistenz-hub-privatkunden-bank-w-m-d/dcc56b6a-d7dd-4822-a3b4-049768ba24eb',
          },
          start_date: '2026-07-03',
        },
        {
          szas: {
            sza_title: 'Underwriter Sachversicherung (w/m/d)',
            sza_workplace: 'Helvetia St. Gallen, Dufourstrasse 40, 9001 St. Gallen',
            'sza_location.city': '9001-St. Gallen',
            'sza_location.zip': '9001',
            sza_introduction:
              'Für unser Underwriting-Team in St. Gallen suchen wir eine erfahrene Fachperson im Bereich Sachversicherung, die unsere Kundinnen und Kunden kompetent berät und komplexe Risiken sauber einschätzt.',
            sza_tasks: '<ul><li>Risikoprüfung</li><li>Policenerstellung</li></ul>',
            sza_requirements: '<ul><li>Versicherungsfachausweis</li><li>Mehrjährige Erfahrung</li></ul>',
            'sza_pensum.min': '80',
            'sza_pensum.max': '100',
          },
          links: {
            directlink:
              'https://jobs.helvetia.com/offene-stellen/underwriter-sachversicherung-w-m-d/aaaa1111-2222-3333-4444-555566667777',
          },
          start_date: '2026-06-15',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Baloise crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BALOISE_KEY).toBe('baloise');
    expect(BALOISE_COMPANY_NAME).toBe('Baloise');
  });

  // ── isCompanyJob ──
  describe('isBaloiseJob', () => {
    it('matches by companyKey', () => {
      expect(isBaloiseJob({ companyKey: 'baloise' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBaloiseJob({ company: 'Baloise' })).toBe(true);
    });

    it('rejects a bare shared-medium URL with no company signal (medium 1005736 is split with Helvetia)', () => {
      // sharedMedium:true disables the bare-medium-URL fallback for this
      // tenant, since it can't discriminate which of the two companies a
      // job belongs to — the two crawlers already do that at fetch time
      // via filterListing on szas.sza_workplace, not via URL matching.
      expect(isBaloiseJob({ url: 'https://ohws.prospective.ch/public/v1/medium/1005736/jobs' })).toBe(false);
    });

    it('matches by corporate host URL', () => {
      expect(isBaloiseJob({ url: 'https://baloise.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBaloiseJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBaloiseJob(null)).toBe(false);
      expect(isBaloiseJob(undefined)).toBe(false);
      expect(isBaloiseJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://baloise.com/jobs/123')).toBe(true);
    });

    it('trusts the shared Prospective career portal (jobs.helvetia.com)', () => {
      expect(isTrustedDomain('https://jobs.helvetia.com/offene-stellen/some-job/uuid')).toBe(true);
    });

    it('trusts the Prospective API host scoped to this medium', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/medium/1005736/jobs')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Kreditberater Hypotheken (w/m/d)');
      expect(slug).toBe('kreditberater-hypotheken-w-m-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Spécialiste hypothèques')).toBe('specialiste-hypotheques');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'baloise-abc123',
      slug: 'test-position-baloise-solothurn',
      slugByLocale: { de: 'test-position-baloise-solothurn' },
      company: 'Baloise',
      companyKey: 'baloise',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Solothurn',
      canton: 'SO',
      url: 'https://jobs.helvetia.com/offene-stellen/test/uuid',
      source: 'Baloise Dedicated Parser (Prospective medium 1005736)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
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

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^baloise-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllBaloiseJobs (graceful degradation + shared-tenant filter) ──
  describe('fetchAllBaloiseJobs', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 500 });
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('returns [] (no throw) on total network failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND ohws.prospective.ch');
      }) as any;

      const jobs = await fetchAllBaloiseJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 503 });
      }) as any;

      const jobs = await fetchAllBaloiseJobs();
      expect(jobs).toEqual([]);
    });

    it('keeps only "Baloise"-workplace listings from the shared medium', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(MEDIUM_ENDPOINT_PREFIX)) return mixedFeedResponse();
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllBaloiseJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Baloise',
        companyKey: 'baloise',
        location: 'Solothurn',
        canton: 'SO',
        country: 'CH',
        postalCode: '4500',
        streetAddress: 'Amthausplatz 4',
      });
      expect(jobs[0].title).toBe('Leiter Assistenz-Hub Privatkunden Bank (w/m/d)');
      expect(jobs[0].id).toMatch(/^baloise-/);
      expect(isTrustedDomain(jobs[0].url)).toBe(true);
    });

    it('never double-counts a listing under both baloise and helvetia companyKeys', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(MEDIUM_ENDPOINT_PREFIX)) return mixedFeedResponse();
        return new Response('', { status: 404 });
      }) as any;

      const [baloiseJobs, helvetiaJobs] = await Promise.all([
        fetchAllBaloiseJobs(),
        fetchAllHelvetiaJobs(),
      ]);

      expect(baloiseJobs).toHaveLength(1);
      expect(helvetiaJobs).toHaveLength(1);
      expect(baloiseJobs[0].url).not.toBe(helvetiaJobs[0].url);
      expect(helvetiaJobs[0].title).toBe('Underwriter Sachversicherung (w/m/d)');
      expect(helvetiaJobs[0].companyKey).toBe('helvetia');
      expect(helvetiaJobs[0].location).toBe('St. Gallen');
    });

    it('description clears the 50-word thin-content floor', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(MEDIUM_ENDPOINT_PREFIX)) return mixedFeedResponse();
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllBaloiseJobs();
      const words = String(jobs[0].description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(50);
    });
  });
});
