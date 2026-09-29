import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  APPLE_RETAIL_SWITZERLAND_KEY,
  APPLE_RETAIL_SWITZERLAND_COMPANY_NAME,
  isAppleRetailSwitzerlandJob,
  isTrustedDomain,
  resolveAppleRetailSwitzerlandCanton,
} from '../scripts/lib/apple-retail-switzerland-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { parseAppleJobDetailsData, buildAppleJobDescription, fetchAllAppleRetailSwitzerlandJobs } from '../scripts/lib/apple-retail-switzerland-job-parser.mjs';

describe('Apple Retail Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(APPLE_RETAIL_SWITZERLAND_KEY).toBe('apple-retail-switzerland');
    expect(APPLE_RETAIL_SWITZERLAND_COMPANY_NAME).toBe('Apple Retail Switzerland');
  });

  // ── isCompanyJob ──
  describe('isAppleRetailSwitzerlandJob', () => {
    it('matches by companyKey', () => {
      expect(isAppleRetailSwitzerlandJob({ companyKey: 'apple-retail-switzerland' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAppleRetailSwitzerlandJob({ company: 'Apple Retail Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAppleRetailSwitzerlandJob({ url: 'https://jobs.apple.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAppleRetailSwitzerlandJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAppleRetailSwitzerlandJob(null)).toBe(false);
      expect(isAppleRetailSwitzerlandJob(undefined)).toBe(false);
      expect(isAppleRetailSwitzerlandJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.apple.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.apple.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAppleRetailSwitzerlandCanton (issue #7055) ──
  describe('resolveAppleRetailSwitzerlandCanton', () => {
    it('resolves a real Swiss city to its canton', () => {
      expect(resolveAppleRetailSwitzerlandCanton('Lugano')).toBe('TI');
    });

    it('does not route a nationwide "Switzerland" posting to a canton', () => {
      expect(resolveAppleRetailSwitzerlandCanton('Switzerland')).toBe('');
    });

    it('falls back to ZH only when a real (unresolved) city is given', () => {
      expect(resolveAppleRetailSwitzerlandCanton('Nowhereville')).toBe('ZH');
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
      expect(slugify('Developer apple-retail-switzerland ch')).toBe('developer-apple-retail-switzerland-ch');
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
      id: 'apple-retail-switzerland-abc123',
      slug: 'test-position-apple-retail-switzerland-ch',
      slugByLocale: { de: 'test-position-apple-retail-switzerland-ch' },
      company: 'Apple Retail Switzerland',
      companyKey: 'apple-retail-switzerland',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.apple.com/jobs/test',
      source: 'Apple Retail Switzerland Dedicated Parser',
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
      expect(validJob.id).toMatch(/^apple-retail-switzerland-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Shape minimised from the job page of jobs.apple.com/en-us/details/114438017/
// ch-specialist-m-f-d (2026-09-29): the page hydrates from
// `window.__staticRouterHydrationData = JSON.parse("…")`. The search API only
// returns `jobSummary`, so 15/18 postings were published as the teaser
// paragraph alone, without any list (audit run 36528331656).
describe('Apple job-details record', () => {
  const jobsData = {
    postingTitle: 'CH-Specialist (m/f/d)',
    jobSummary: 'Apple Retail is where the best of Apple comes together.',
    description: 'Deliver excellent service to Apple customers by seeking to understand their needs.',
    minimumQualifications: 'Fluency in German and English.\n\nAvailability to work a flexible schedule.',
    preferredQualifications: 'Retail experience.\nEnthusiasm for Apple products.',
    postingFooters: [{ localizations: { en_US: [{ content: '<p>At Apple, we’re not all the same. And that’s our greatest strength.</p>' }] } }],
  };
  const html = `<html><body><script nonce="x">window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify({ loaderData: { jobDetails: { jobsData } } }))});</script></body></html>`;

  it('reads the hydrated posting record', () => {
    expect(parseAppleJobDetailsData(html)).toMatchObject({ postingTitle: 'CH-Specialist (m/f/d)' });
    expect(parseAppleJobDetailsData('<html></html>')).toBeNull();
  });

  it('composes summary, description, qualifications as bullets and the footer', () => {
    const text = buildAppleJobDescription(parseAppleJobDetailsData(html));
    const order = ['Summary', 'Description', 'Minimum Qualifications', 'Preferred Qualifications'].map((h) => text.indexOf(`${h}\n`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/^• Fluency in German and English\.$/m);
    expect(text).toMatch(/^• Enthusiasm for Apple products\.$/m);
    expect(text).toContain('greatest strength');
    expect(buildAppleJobDescription(null)).toBe('');
  });
});

// Only the posting's own text is published (issue 5253). Without the detail
// record and without a search summary a posting used to go out as
// "{title} — Apple Retail Switzerland"; it is not published any more. Shapes
// of jobs.apple.com (CSRFToken, search API, hydrated detail page) as served on
// 2026-09-29.
describe('fetchAllAppleRetailSwitzerlandJobs — posting without any vacancy text', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the posting with text and skips the one without, never inventing text', async () => {
    const jobsData = {
      postingTitle: 'Specialist',
      jobSummary: 'Apple Retail is where the best of Apple comes together.',
      description: 'Deliver excellent service to Apple customers by seeking to understand their needs.',
    };
    const detailHtml = `<html><body><script nonce="x">window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify({ loaderData: { jobDetails: { jobsData } } }))});</script></body></html>`;
    const listing = (positionId: string, title: string) => ({
      positionId,
      postingTitle: title,
      transformedPostingTitle: title.toLowerCase().replace(/\W+/g, '-'),
      jobSummary: '',
      locations: [{ name: 'Zurich' }],
      postDateInGMT: '2026-09-20T00:00:00Z',
      team: { teamID: 'teamsAndSubTeams-APPST' },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/CSRFToken')) return new Response('{}', { status: 200, headers: { 'x-apple-csrf-token': 'tok', 'set-cookie': 'a=b; Path=/' } });
      if (u.endsWith('/api/v1/search')) {
        return new Response(JSON.stringify({ res: { totalRecords: 2, searchResults: [listing('200600001', 'Specialist'), listing('200600002', 'Technical Specialist')] } }), { status: 200 });
      }
      if (u.includes('200600001')) return new Response(detailHtml, { status: 200 });
      return new Response('<html></html>', { status: 200 });
    }));

    const jobs = await fetchAllAppleRetailSwitzerlandJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Specialist']);
    expect(jobs[0].description).toContain('Deliver excellent service to Apple customers');
    for (const job of jobs) expect(job.description).not.toMatch(/— Apple Retail Switzerland$/);
  }, 20_000);
});
