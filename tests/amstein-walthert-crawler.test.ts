import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AMSTEIN_WALTHERT_KEY,
  AMSTEIN_WALTHERT_COMPANY_NAME,
  isAmsteinWalthertJob,
  isTrustedDomain,
  fetchAllAmsteinWalthertJobs,
} from '../scripts/lib/amstein-walthert-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const JSON_ENDPOINT = 'https://amstein-walthert.ch/de/uber-w/w-als-arbeitgeber/offene-stellen/json/';

const LONG_PARAGRAPH =
  'Wir suchen eine engagierte Fachperson, welche unser interdisziplinäres Team in der Planung und ' +
  'Umsetzung anspruchsvoller Projekte im Bereich Gebäudetechnik tatkräftig unterstützt und dabei eng mit ' +
  'Bauherrschaften, Architekten und weiteren Fachplanern zusammenarbeitet, um nachhaltige und ' +
  'wirtschaftliche Lösungen über den gesamten Lebenszyklus eines Gebäudes hinweg sicherzustellen und ' +
  'laufend weiterzuentwickeln, inklusive Qualitätssicherung, Kostenkontrolle und Terminplanung.';

function listingJsonResponse() {
  return new Response(
    JSON.stringify({
      filters: {},
      objects: [
        {
          id: 'JEME3759.12',
          title: 'Fachplaner:in Gebäudeautomation 80-100%',
          url: '/de/uber-w/w-als-arbeitgeber/offene-stellen/jeme3759.12/',
          workplace: 'Zürich',
          workplace_id: 'zurich',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function detailHtmlResponse() {
  return new Response(
    `<html><body>
      <div class="intro"><p>${LONG_PARAGRAPH}</p></div>
      <div class="duty"><p>${LONG_PARAGRAPH}</p></div>
      <div class="requirement"><p>${LONG_PARAGRAPH}</p></div>
      <h3 class="side-content__section">Adresse</h3>
      <p>Amstein + Walthert AG<br>Andreasstrasse 5<br>8050 Zürich</p>
    </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } },
  );
}

describe('Amstein + Walthert AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(AMSTEIN_WALTHERT_KEY).toBe('amstein-walthert');
    expect(AMSTEIN_WALTHERT_COMPANY_NAME).toBe('Amstein + Walthert AG');
  });

  // ── isCompanyJob ──
  describe('isAmsteinWalthertJob', () => {
    it('matches by companyKey', () => {
      expect(isAmsteinWalthertJob({ companyKey: 'amstein-walthert' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAmsteinWalthertJob({ company: 'Amstein + Walthert AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAmsteinWalthertJob({ url: 'https://amstein-walthert.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAmsteinWalthertJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAmsteinWalthertJob(null)).toBe(false);
      expect(isAmsteinWalthertJob(undefined)).toBe(false);
      expect(isAmsteinWalthertJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://amstein-walthert.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.amstein-walthert.ch/job/456')).toBe(true);
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
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer amstein-walthert ch')).toBe('developer-amstein-walthert-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'amstein-walthert-abc123',
      slug: 'test-position-amstein-walthert-ch',
      slugByLocale: { de: 'test-position-amstein-walthert-ch' },
      company: 'Amstein + Walthert AG',
      companyKey: 'amstein-walthert',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://amstein-walthert.ch/jobs/test',
      source: 'Amstein + Walthert AG Dedicated Parser (bespoke in-house CMS)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Andreasstrasse 5',
      postalCode: '8050',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream via safe defaults;
      // the parser is only responsible for supplying accurate per-job inputs.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob.company).toBeTruthy(); // hiringOrganization.name source
      expect(validJob.location).toBeTruthy(); // jobLocation source
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^amstein-walthert-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllAmsteinWalthertJobs (graceful degradation + real shape) ──
  describe('fetchAllAmsteinWalthertJobs', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    // A fetch failure is not an empty listing: it propagates so the crawler
    // pipeline records its cause (issue 11077 class).
    it('propagates a total network failure instead of returning []', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND amstein-walthert.ch');
      }) as any;

      await expect(fetchAllAmsteinWalthertJobs()).rejects.toThrow(/ENOTFOUND/);
    });

    it('propagates a listing JSON endpoint error instead of returning []', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as any;

      await expect(fetchAllAmsteinWalthertJobs()).rejects.toThrow();
    });

    it('propagates a malformed listing JSON instead of returning []', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        if (String(url).startsWith(JSON_ENDPOINT)) {
          return new Response('not json', { status: 200 });
        }
        return new Response('', { status: 404 });
      }) as any;

      await expect(fetchAllAmsteinWalthertJobs()).rejects.toThrow();
    });

    it('degrades gracefully (keeps the listing) when a single detail-page fetch fails', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(JSON_ENDPOINT)) return listingJsonResponse();
        return new Response('', { status: 500 });
      }) as any;

      const jobs = await fetchAllAmsteinWalthertJobs();
      expect(jobs).toHaveLength(1);
      // The listing remains available, but a failed detail page must not
      // fabricate crawler-owned source text.
      expect(jobs[0].description).toBe('');
      expect(jobs[0].descriptionByLocale).toEqual({ [jobs[0].sourceLang]: '' });
      expect(jobs[0].postalCode).toBe('8050');
      expect(jobs[0].canton).toBe('ZH');
    });

    it('builds a fully-shaped job from listing + detail page', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(JSON_ENDPOINT)) return listingJsonResponse();
        return detailHtmlResponse();
      }) as any;

      const jobs = await fetchAllAmsteinWalthertJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];

      expect(job).toMatchObject({
        company: AMSTEIN_WALTHERT_COMPANY_NAME,
        companyKey: AMSTEIN_WALTHERT_KEY,
        canton: 'ZH',
        country: 'CH',
        addressCountry: 'CH',
        postalCode: '8050',
        streetAddress: 'Andreasstrasse 5',
        location: 'Zürich',
      });
      expect(job.title).toBe('Fachplaner:in Gebäudeautomation 80-100%');
      expect(job.id).toMatch(/^amstein-walthert-/);
      // "80-100%" is a full-time-eligible range (min 80%), not part-time.
      expect(job.employmentType).toBe('FULL_TIME');
      expect(isTrustedDomain(job.url)).toBe(true);
      expect(Object.keys(job.slugByLocale)).toEqual([job.sourceLang]);
      expect(Object.keys(job.titleByLocale)).toEqual([job.sourceLang]);
      expect(Object.keys(job.descriptionByLocale)).toEqual([job.sourceLang]);
    });

    it('description clears the 50-word thin-content floor (Non-Negotiable #4)', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(JSON_ENDPOINT)) return listingJsonResponse();
        return detailHtmlResponse();
      }) as any;

      const jobs = await fetchAllAmsteinWalthertJobs();
      const words = String(jobs[0].description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(50);
    });

    it('writes no text of its own when the detail has no body (issue 5253)', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(JSON_ENDPOINT)) return listingJsonResponse();
        // Detail page fetch "succeeds" but has none of the expected sections.
        return new Response('<html><body><p>n/a</p></body></html>', { status: 200 });
      }) as any;

      // The posting is still emitted (same slug), with no description: the
      // shared pipeline keeps the stored source body or quarantines it.
      const jobs = await fetchAllAmsteinWalthertJobs();
      expect(jobs[0].description).toBe('');
      expect(jobs[0].descriptionByLocale).toEqual({ [jobs[0].sourceLang]: '' });
      expect(jobs[0].slug).toMatch(/amstein-walthert/);
    });
  });
});
