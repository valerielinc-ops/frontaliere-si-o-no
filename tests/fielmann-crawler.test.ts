import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  FIELMANN_KEY,
  FIELMANN_COMPANY_NAME,
  isFielmannJob,
  isTrustedDomain,
  fetchAllFielmannJobs,
} from '../scripts/lib/fielmann-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Fielmann Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FIELMANN_KEY).toBe('fielmann');
    expect(FIELMANN_COMPANY_NAME).toBe('Fielmann Group');
  });

  // ── isCompanyJob ──
  describe('isFielmannJob', () => {
    it('matches by companyKey', () => {
      expect(isFielmannJob({ companyKey: 'fielmann' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFielmannJob({ company: 'Fielmann Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFielmannJob({ url: 'https://jobs.fielmann.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFielmannJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFielmannJob(null)).toBe(false);
      expect(isFielmannJob(undefined)).toBe(false);
      expect(isFielmannJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.fielmann.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.fielmann.com/job/456')).toBe(true);
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
      expect(slugify('Developer fielmann ch')).toBe('developer-fielmann-ch');
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
      id: 'fielmann-abc123',
      slug: 'test-position-fielmann-ch',
      slugByLocale: { de: 'test-position-fielmann-ch' },
      company: 'Fielmann Group',
      companyKey: 'fielmann',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.fielmann.com/jobs/test',
      source: 'Fielmann Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^fielmann-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Only the posting's own text is published (issue 5253): a req without a
// Workday body used to go out as "{title} — Fielmann Group". CXS shapes of
// fielmann.wd3.myworkdayjobs.com (listing bulletFields with the store
// address, job detail).
describe('fetchAllFielmannJobs — req without a vacancy body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the req with a body and skips the one without, never inventing text', async () => {
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/jobs')) {
        return json({
          total: 2,
          jobPostings: [
            { title: 'Augenoptiker (w/m/d)', externalPath: '/job/Basel/Augenoptiker--w-m-_R-2837', bulletFields: ['R-2837', 'Marktplatz 16, 4001 Basel'] },
            { title: 'Filialleiter (w/m/d)', externalPath: '/job/Basel/Filialleiter--w-m-_R-2838', bulletFields: ['R-2838', 'Marktplatz 16, 4001 Basel'] },
          ],
        });
      }
      if (u.includes('R-2837')) return json({ jobPostingInfo: { title: 'Augenoptiker (w/m/d)', jobDescription: '<p>Sie beraten unsere Kundinnen und Kunden rund um Brillen und Kontaktlinsen. Du arbeitest eng mit Kolleginnen und Kollegen aus mehreren Abteilungen zusammen, dokumentierst deine Arbeit sorgfältig und hilfst uns, unsere Abläufe zu verbessern. Wir bieten einen modernen Arbeitsplatz, flexible Arbeitszeiten, Weiterbildungen und eine offene Teamkultur. Gute Deutschkenntnisse und eine strukturierte Arbeitsweise runden dein Profil ab.</p>', location: 'Basel' } });
      return json({ jobPostingInfo: { title: 'Filialleiter (w/m/d)', jobDescription: '', location: 'Basel' } });
    }));

    const jobs = await fetchAllFielmannJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Augenoptiker (w/m/d)']);
    expect(jobs[0].description).toContain('Sie beraten unsere Kundinnen und Kunden');
    for (const job of jobs) expect(job.description).not.toMatch(/— Fielmann Group$/);
  }, 20_000);
});
