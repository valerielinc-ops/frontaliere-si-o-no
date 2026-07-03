import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SOPHIA_GENETICS_KEY,
  SOPHIA_GENETICS_COMPANY_NAME,
  isSophiaGeneticsJob,
  isTrustedDomain,
  parseSophiaGeneticsWidgetPayload,
  resolveSophiaGeneticsSwissLocation,
  isSophiaGeneticsSwissJob,
  buildSophiaGeneticsDetailUrl,
  buildSophiaGeneticsApplyUrl,
  fetchAllSophiaGeneticsJobs,
} from '../scripts/lib/sophia-genetics-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const WIDGET_URL = 'https://apply.workable.com/api/v1/widget/accounts/sophia-genetics';

function longDescription(words = 80) {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
}

function widgetRow(overrides = {}) {
  return {
    title: 'IVD Development & Validation Lead',
    shortcode: 'A5F8F7F93B',
    code: '',
    employment_type: 'Full-time',
    department: 'Data Science',
    url: 'https://apply.workable.com/j/A5F8F7F93B',
    published_on: '2026-04-02',
    created_at: '2026-03-20',
    country: 'Switzerland',
    city: 'Rolle',
    locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Rolle', region: 'Vaud', hidden: false }],
    ...overrides,
  };
}

function detailPayload(overrides = {}) {
  return {
    title: 'IVD Development & Validation Lead',
    shortcode: 'A5F8F7F93B',
    location: { country: 'Switzerland', countryCode: 'CH', city: 'Rolle', region: 'Vaud' },
    locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Rolle', region: 'Vaud', hidden: false }],
    department: ['Data Science'],
    workplace: 'hybrid',
    published: '2026-04-02T00:00:00.000Z',
    description: `<p>${longDescription()}</p>`,
    ...overrides,
  };
}

describe('SOPHiA GENETICS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SOPHIA_GENETICS_KEY).toBe('sophia-genetics');
    expect(SOPHIA_GENETICS_COMPANY_NAME).toBe('SOPHiA GENETICS');
  });

  // ── isCompanyJob ──
  describe('isSophiaGeneticsJob', () => {
    it('matches by companyKey', () => {
      expect(isSophiaGeneticsJob({ companyKey: 'sophia-genetics' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSophiaGeneticsJob({ company: 'SOPHiA GENETICS' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSophiaGeneticsJob({ url: 'https://apply.workable.com/sophia-genetics/j/ABC123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSophiaGeneticsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSophiaGeneticsJob(null)).toBe(false);
      expect(isSophiaGeneticsJob(undefined)).toBe(false);
      expect(isSophiaGeneticsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://sophiagenetics.com/careers')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.sophiagenetics.com/job/456')).toBe(true);
    });

    it('trusts the Workable ATS host', () => {
      expect(isTrustedDomain('https://apply.workable.com/sophia-genetics/j/A5F8F7F93B/')).toBe(true);
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
      expect(slugify('Developer sophia genetics rolle')).toBe('developer-sophia-genetics-rolle');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Widget payload dedupe ──
  describe('parseSophiaGeneticsWidgetPayload', () => {
    it('dedupes multi-location rows by shortcode', () => {
      const payload = {
        jobs: [
          widgetRow({ shortcode: 'X1', country: 'United Kingdom' }),
          widgetRow({ shortcode: 'X1', country: 'Germany' }),
          widgetRow({ shortcode: 'X1', country: 'Switzerland' }),
          widgetRow({ shortcode: 'X2' }),
        ],
      };
      const listings = parseSophiaGeneticsWidgetPayload(payload);
      expect(listings).toHaveLength(2);
      expect(listings.map((l) => l.shortcode).sort()).toEqual(['X1', 'X2']);
    });

    it('returns empty array for empty/missing feed', () => {
      expect(parseSophiaGeneticsWidgetPayload({ jobs: [] })).toEqual([]);
      expect(parseSophiaGeneticsWidgetPayload({})).toEqual([]);
      expect(parseSophiaGeneticsWidgetPayload(null)).toEqual([]);
    });

    it('skips rows without a shortcode', () => {
      const listings = parseSophiaGeneticsWidgetPayload({ jobs: [{ title: 'No shortcode' }] });
      expect(listings).toEqual([]);
    });
  });

  // ── Swiss location resolution (non-Swiss / foreign-office filtering) ──
  describe('resolveSophiaGeneticsSwissLocation / isSophiaGeneticsSwissJob', () => {
    it('resolves the Swiss location when it is the primary location', () => {
      const loc = resolveSophiaGeneticsSwissLocation(detailPayload());
      expect(loc).toEqual({ city: 'Rolle', region: 'Vaud', countryCode: 'CH' });
      expect(isSophiaGeneticsSwissJob(detailPayload())).toBe(true);
    });

    it('finds a genuine CH entry buried in locations[] even when the primary location is foreign', () => {
      // Reproduces the confirmed live bug-class: detail.location is GB while
      // a real CH row exists deeper in locations[].
      const detail = detailPayload({
        location: { country: 'United Kingdom', countryCode: 'GB', city: '', region: null },
        locations: [
          { country: 'United Kingdom', countryCode: 'GB', city: '', region: null, hidden: false },
          { country: 'Germany', countryCode: 'DE', city: '', region: null, hidden: false },
          { country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich', hidden: false },
        ],
      });
      const loc = resolveSophiaGeneticsSwissLocation(detail);
      expect(loc).toEqual({ city: 'Zürich', region: 'Zurich', countryCode: 'CH' });
      expect(isSophiaGeneticsSwissJob(detail)).toBe(true);
    });

    it('returns null (filters out) foreign-office-only postings', () => {
      const detail = detailPayload({
        location: { country: 'United States', countryCode: 'US', city: 'Boston', region: 'MA' },
        locations: [{ country: 'United States', countryCode: 'US', city: 'Boston', region: 'MA', hidden: false }],
      });
      expect(resolveSophiaGeneticsSwissLocation(detail)).toBeNull();
      expect(isSophiaGeneticsSwissJob(detail)).toBe(false);
    });

    it('handles missing location data gracefully', () => {
      expect(resolveSophiaGeneticsSwissLocation({})).toBeNull();
      expect(resolveSophiaGeneticsSwissLocation(null)).toBeNull();
    });

    it('prefers a visible CH entry over a hidden one', () => {
      const detail = detailPayload({
        locations: [
          { country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich', hidden: true },
          { country: 'Switzerland', countryCode: 'CH', city: 'Rolle', region: 'Vaud', hidden: false },
        ],
      });
      expect(resolveSophiaGeneticsSwissLocation(detail)).toEqual({ city: 'Rolle', region: 'Vaud', countryCode: 'CH' });
    });
  });

  // ── URL builders ──
  describe('URL builders', () => {
    it('builds the v2 detail API URL', () => {
      expect(buildSophiaGeneticsDetailUrl('A5F8F7F93B')).toBe(
        'https://apply.workable.com/api/v2/accounts/sophia-genetics/jobs/A5F8F7F93B',
      );
    });

    it('builds the canonical public apply URL with trailing slash', () => {
      expect(buildSophiaGeneticsApplyUrl('A5F8F7F93B')).toBe(
        'https://apply.workable.com/sophia-genetics/j/A5F8F7F93B/',
      );
    });
  });

  // ── fetchAllSophiaGeneticsJobs (mocked fetch) ──
  describe('fetchAllSophiaGeneticsJobs', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns an empty array when the widget feed has no jobs', async () => {
      global.fetch = vi.fn(async (url: string) => {
        expect(String(url)).toBe(WIDGET_URL);
        return new Response(JSON.stringify({ name: 'SOPHiA GENETICS', jobs: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllSophiaGeneticsJobs();
      expect(jobs).toEqual([]);
    });

    it('parses a successful feed, keeping only Swiss jobs and producing complete structured-data fields', async () => {
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u === WIDGET_URL) {
          return new Response(
            JSON.stringify({
              name: 'SOPHiA GENETICS',
              jobs: [
                widgetRow({ shortcode: 'CH_JOB', title: 'IVD Development & Validation Lead' }),
                widgetRow({
                  shortcode: 'FOREIGN_JOB',
                  title: 'Boston-based Role',
                  country: 'United States',
                  city: 'Boston',
                  locations: [{ country: 'United States', countryCode: 'US', city: 'Boston', region: 'MA', hidden: false }],
                }),
              ],
            }),
            { status: 200 },
          );
        }
        if (u.endsWith('/jobs/CH_JOB')) {
          return new Response(JSON.stringify(detailPayload({ shortcode: 'CH_JOB' })), { status: 200 });
        }
        if (u.endsWith('/jobs/FOREIGN_JOB')) {
          return new Response(
            JSON.stringify(
              detailPayload({
                shortcode: 'FOREIGN_JOB',
                title: 'Boston-based Role',
                location: { country: 'United States', countryCode: 'US', city: 'Boston', region: 'MA' },
                locations: [{ country: 'United States', countryCode: 'US', city: 'Boston', region: 'MA', hidden: false }],
              }),
            ),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllSophiaGeneticsJobs();

      // Non-Swiss/foreign-office job filtered out.
      expect(jobs).toHaveLength(1);
      const job = jobs[0];

      // Canton inference for Rolle → VD.
      expect(job.location).toBe('Rolle');
      expect(job.canton).toBe('VD');

      // Structured-data completeness fields (Non-Negotiable #3).
      expect(job.title).toBe('IVD Development & Validation Lead');
      expect(typeof job.description).toBe('string');
      expect(job.description.length).toBeGreaterThan(0);
      expect(job.postedDate).toBe('2026-04-02');
      expect(job.company).toBe('SOPHiA GENETICS');
      expect(job.addressLocality).toBe('Rolle');
      expect(job.postalCode).toBe('1180');
      expect(job.streetAddress).toBe('La Pièce 12');
      expect(job.employmentType).toBe('FULL_TIME');

      // Thin-description guard: real descriptions clear 50 words.
      const wordCount = job.description.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('canton-gates postalCode/streetAddress: does NOT attach HQ address to a non-HQ-canton Swiss job', async () => {
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u === WIDGET_URL) {
          return new Response(
            JSON.stringify({
              name: 'SOPHiA GENETICS',
              jobs: [
                widgetRow({
                  shortcode: 'ZH_JOB',
                  title: 'Senior Full-Stack Software Machine Learning Engineer',
                  city: 'Zürich',
                  locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich', hidden: false }],
                }),
              ],
            }),
            { status: 200 },
          );
        }
        if (u.endsWith('/jobs/ZH_JOB')) {
          return new Response(
            JSON.stringify(
              detailPayload({
                shortcode: 'ZH_JOB',
                title: 'Senior Full-Stack Software Machine Learning Engineer',
                location: { country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich' },
                locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich', hidden: false }],
              }),
            ),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllSophiaGeneticsJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.canton).toBe('ZH');
      expect(job.location).toBe('Zürich');
      // HQ (Rolle VD) postalCode/streetAddress must NOT leak onto a ZH job.
      expect(job.postalCode).toBe('');
      expect(job.streetAddress).toBe('');
    });

    it('skips jobs whose detail fetch fails, without throwing', async () => {
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u === WIDGET_URL) {
          return new Response(JSON.stringify({ name: 'SOPHiA GENETICS', jobs: [widgetRow()] }), { status: 200 });
        }
        return new Response('server error', { status: 500 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllSophiaGeneticsJobs();
      expect(jobs).toEqual([]);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'sophia-genetics-abc123',
      slug: 'test-position-sophia-genetics-rolle',
      slugByLocale: { en: 'test-position-sophia-genetics-rolle' },
      company: 'SOPHiA GENETICS',
      companyKey: 'sophia-genetics',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Rolle',
      canton: 'VD',
      url: 'https://apply.workable.com/sophia-genetics/j/TEST/',
      source: 'SOPHiA GENETICS Dedicated Parser (Workable)',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^sophia-genetics-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
