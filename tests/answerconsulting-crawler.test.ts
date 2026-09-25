import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ANSWERCONSULTING_KEY,
  ANSWERCONSULTING_COMPANY_NAME,
  isAnswerConsultingJob,
  isTrustedDomain,
  parseAnswerConsultingWidgetPayload,
  resolveAnswerConsultingLocation,
  isAnswerConsultingSwissJob,
  buildAnswerConsultingDetailUrl,
  buildAnswerConsultingApplyUrl,
  fetchAllAnswerConsultingJobs,
} from '../scripts/lib/answerconsulting-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const WIDGET_URL = 'https://apply.workable.com/api/v1/widget/accounts/answermodules';

function longDescription(words = 80) {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
}

function widgetRow(overrides = {}) {
  return {
    title: 'R&D Software Engineer',
    shortcode: '86EE20F0FD',
    code: '',
    employment_type: 'Full-time',
    department: 'R&D',
    url: 'https://apply.workable.com/j/86EE20F0FD',
    published_on: '2026-04-02',
    created_at: '2026-03-20',
    country: 'Switzerland',
    city: 'Mendrisio',
    locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Mendrisio', region: 'Ticino', hidden: false }],
    ...overrides,
  };
}

function detailPayload(overrides = {}) {
  return {
    title: 'R&D Software Engineer',
    shortcode: '86EE20F0FD',
    location: { country: 'Switzerland', countryCode: 'CH', city: 'Mendrisio', region: 'Ticino' },
    locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Mendrisio', region: 'Ticino', hidden: false }],
    department: ['R&D'],
    workplace: 'hybrid',
    published: '2026-04-02T00:00:00.000Z',
    description: `<p>${longDescription()}</p>`,
    ...overrides,
  };
}

describe('AnswerConsulting SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ANSWERCONSULTING_KEY).toBe('answerconsulting');
    expect(ANSWERCONSULTING_COMPANY_NAME).toBe('AnswerConsulting SA');
  });

  // ── isCompanyJob ──
  describe('isAnswerConsultingJob', () => {
    it('matches by companyKey', () => {
      expect(isAnswerConsultingJob({ companyKey: 'answerconsulting' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAnswerConsultingJob({ company: 'AnswerConsulting SA' })).toBe(true);
    });

    it('matches by AnswerModules brand name', () => {
      expect(isAnswerConsultingJob({ company: 'AnswerModules' })).toBe(true);
    });

    it('matches by URL domain (corporate site)', () => {
      expect(isAnswerConsultingJob({ url: 'https://www.answerconsulting.ch/careers' })).toBe(true);
    });

    it('matches by URL domain (Workable ATS)', () => {
      expect(isAnswerConsultingJob({ url: 'https://apply.workable.com/answermodules/j/ABC123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAnswerConsultingJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAnswerConsultingJob(null)).toBe(false);
      expect(isAnswerConsultingJob(undefined)).toBe(false);
      expect(isAnswerConsultingJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.answerconsulting.ch/careers')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.answerconsulting.ch/job/456')).toBe(true);
    });

    it('trusts the AnswerModules product domain', () => {
      expect(isTrustedDomain('https://www.answermodules.com/')).toBe(true);
    });

    it('trusts Workable ATS host', () => {
      expect(isTrustedDomain('https://apply.workable.com/answermodules/j/86EE20F0FD/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported crawler-template) ──
  describe('slugify', () => {
    it('converts a title to a URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer answerconsulting mendrisio')).toBe('developer-answerconsulting-mendrisio');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Widget payload dedupe ──
  describe('parseAnswerConsultingWidgetPayload', () => {
    it('dedupes multi-location rows by shortcode', () => {
      const payload = {
        jobs: [
          widgetRow({ shortcode: 'X1', country: 'Germany' }),
          widgetRow({ shortcode: 'X1', country: 'Switzerland' }),
          widgetRow({ shortcode: 'X2' }),
        ],
      };
      const listings = parseAnswerConsultingWidgetPayload(payload);
      expect(listings).toHaveLength(2);
      expect(listings.map((l) => l.shortcode).sort()).toEqual(['X1', 'X2']);
    });

    it('returns an empty array for a payload with no jobs', () => {
      expect(parseAnswerConsultingWidgetPayload({ jobs: [] })).toEqual([]);
      expect(parseAnswerConsultingWidgetPayload({})).toEqual([]);
      expect(parseAnswerConsultingWidgetPayload(null)).toEqual([]);
    });

    it('skips malformed rows without a shortcode', () => {
      const payload = { jobs: [{ title: 'No shortcode' }, widgetRow({ shortcode: 'OK' })] };
      expect(parseAnswerConsultingWidgetPayload(payload)).toHaveLength(1);
    });
  });

  // ── Location resolution ──
  describe('resolveAnswerConsultingLocation', () => {
    it('resolves the Swiss HQ location from a single-location detail payload', () => {
      const detail = detailPayload();
      expect(resolveAnswerConsultingLocation(detail)).toEqual({ city: 'Mendrisio', region: 'Ticino', countryCode: 'CH' });
      expect(isAnswerConsultingSwissJob(detail)).toBe(true);
    });

    it('scans locations[] for a non-hidden CH entry deeper in the list', () => {
      const detail = detailPayload({
        location: { country: 'Germany', countryCode: 'DE', city: '', region: null },
        locations: [
          { country: 'Germany', countryCode: 'DE', city: '', region: null, hidden: false },
          { country: 'Switzerland', countryCode: 'CH', city: 'Mendrisio', region: 'Ticino', hidden: false },
        ],
      });
      const loc = resolveAnswerConsultingLocation(detail);
      expect(loc).toEqual({ city: 'Mendrisio', region: 'Ticino', countryCode: 'CH' });
      expect(isAnswerConsultingSwissJob(detail)).toBe(true);
    });

    it('returns null (filters out) foreign-office-only postings', () => {
      const detail = detailPayload({
        location: { country: 'Germany', countryCode: 'DE', city: 'Munich', region: 'Bavaria' },
        locations: [{ country: 'Germany', countryCode: 'DE', city: 'Munich', region: 'Bavaria', hidden: false }],
      });
      expect(resolveAnswerConsultingLocation(detail)).toBeNull();
      expect(isAnswerConsultingSwissJob(detail)).toBe(false);
    });

    it('falls back to the Mendrisio HQ when no location data is present at all', () => {
      expect(resolveAnswerConsultingLocation({})).toEqual({ city: 'Mendrisio', region: 'Ticino', countryCode: 'CH' });
      expect(resolveAnswerConsultingLocation(null)).toEqual({ city: 'Mendrisio', region: 'Ticino', countryCode: 'CH' });
    });

    it('prefers a visible CH entry over a hidden one', () => {
      const detail = detailPayload({
        locations: [
          { country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich', hidden: true },
          { country: 'Switzerland', countryCode: 'CH', city: 'Mendrisio', region: 'Ticino', hidden: false },
        ],
      });
      expect(resolveAnswerConsultingLocation(detail)).toEqual({ city: 'Mendrisio', region: 'Ticino', countryCode: 'CH' });
    });
  });

  // ── URL builders ──
  describe('URL builders', () => {
    it('builds the v2 detail API URL', () => {
      expect(buildAnswerConsultingDetailUrl('86EE20F0FD')).toBe(
        'https://apply.workable.com/api/v2/accounts/answermodules/jobs/86EE20F0FD',
      );
    });

    it('builds the canonical public apply URL with trailing slash', () => {
      expect(buildAnswerConsultingApplyUrl('86EE20F0FD')).toBe(
        'https://apply.workable.com/answermodules/j/86EE20F0FD/',
      );
    });
  });

  // ── fetchAllAnswerConsultingJobs (mocked fetch) ──
  describe('fetchAllAnswerConsultingJobs', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns an empty array when the widget feed has no jobs (current live state: 0 openings)', async () => {
      global.fetch = vi.fn(async (url: string) => {
        expect(String(url)).toBe(WIDGET_URL);
        return new Response(JSON.stringify({ name: 'AnswerModules', jobs: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllAnswerConsultingJobs();
      expect(jobs).toEqual([]);
    });

    it('parses a successful feed, keeping only Swiss jobs and producing complete structured-data fields', async () => {
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u === WIDGET_URL) {
          return new Response(
            JSON.stringify({
              name: 'AnswerModules',
              jobs: [
                widgetRow({ shortcode: 'CH_JOB', title: 'R&D Software Engineer' }),
                widgetRow({
                  shortcode: 'FOREIGN_JOB',
                  title: 'Munich-based Role',
                  country: 'Germany',
                  city: 'Munich',
                  locations: [{ country: 'Germany', countryCode: 'DE', city: 'Munich', region: 'Bavaria', hidden: false }],
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
                title: 'Munich-based Role',
                location: { country: 'Germany', countryCode: 'DE', city: 'Munich', region: 'Bavaria' },
                locations: [{ country: 'Germany', countryCode: 'DE', city: 'Munich', region: 'Bavaria', hidden: false }],
              }),
            ),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllAnswerConsultingJobs();

      // Non-Swiss/foreign-office job filtered out.
      expect(jobs).toHaveLength(1);
      const job = jobs[0];

      // Canton inference for Mendrisio → TI.
      expect(job.location).toBe('Mendrisio');
      expect(job.canton).toBe('TI');

      // Structured-data completeness fields (Non-Negotiable #3).
      expect(job.title).toBe('R&D Software Engineer');
      expect(typeof job.description).toBe('string');
      expect(job.description.length).toBeGreaterThan(0);
      expect(job.postedDate).toBe('2026-04-02');
      expect(job.company).toBe('AnswerConsulting SA');
      expect(job.addressLocality).toBe('Mendrisio');
      expect(job.postalCode).toBe('6850');
      expect(job.streetAddress).toBe('Via Penate 4');
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
              name: 'AnswerModules',
              jobs: [
                widgetRow({
                  shortcode: 'ZH_JOB',
                  title: 'Senior OpenText Consultant',
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
                title: 'Senior OpenText Consultant',
                location: { country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich' },
                locations: [{ country: 'Switzerland', countryCode: 'CH', city: 'Zürich', region: 'Zurich', hidden: false }],
              }),
            ),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllAnswerConsultingJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.canton).toBe('ZH');
      expect(job.location).toBe('Zürich');
      // HQ (Mendrisio TI) postalCode/streetAddress must NOT leak onto a ZH job.
      expect(job.postalCode).toBe('');
      expect(job.streetAddress).toBe('');
    });

    it('skips jobs whose detail fetch fails, without throwing', async () => {
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u === WIDGET_URL) {
          return new Response(JSON.stringify({ name: 'AnswerModules', jobs: [widgetRow()] }), { status: 200 });
        }
        return new Response('server error', { status: 500 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllAnswerConsultingJobs();
      expect(jobs).toEqual([]);
    });

    it('dedupes multi-location widget rows before fetching detail', async () => {
      let detailFetchCount = 0;
      global.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u === WIDGET_URL) {
          return new Response(
            JSON.stringify({
              name: 'AnswerModules',
              jobs: [
                widgetRow({ shortcode: 'DUP', country: 'Germany' }),
                widgetRow({ shortcode: 'DUP', country: 'Switzerland' }),
              ],
            }),
            { status: 200 },
          );
        }
        if (u.endsWith('/jobs/DUP')) {
          detailFetchCount += 1;
          return new Response(JSON.stringify(detailPayload({ shortcode: 'DUP' })), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const jobs = await fetchAllAnswerConsultingJobs();
      expect(jobs).toHaveLength(1);
      expect(detailFetchCount).toBe(1);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'answerconsulting-abc123',
      slug: 'test-position-answerconsulting-mendrisio',
      slugByLocale: { en: 'test-position-answerconsulting-mendrisio' },
      company: 'AnswerConsulting SA',
      companyKey: 'answerconsulting',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Mendrisio',
      canton: 'TI',
      url: 'https://apply.workable.com/answermodules/j/TEST/',
      source: 'AnswerConsulting Dedicated Parser (Workable)',
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

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^answerconsulting-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
