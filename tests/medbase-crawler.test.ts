import { afterEach, describe, it, expect, vi } from 'vitest';

const { launchStealthOrChromiumMock } = vi.hoisted(() => ({
  launchStealthOrChromiumMock: vi.fn(),
}));

vi.mock('../scripts/lib/stealth-browser.mjs', () => ({
  chromeUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  isStealthBrowser: () => false,
  launchStealthOrChromium: launchStealthOrChromiumMock,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  launchStealthOrChromiumMock.mockReset();
});
import {
  MEDBASE_KEY,
  MEDBASE_COMPANY_NAME,
  MEDBASE_BROWSER_PUBLIC_URL,
  fetchAllMedbaseJobs,
  isMedbaseJob,
  isTrustedDomain,
} from '../scripts/lib/medbase-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Medbase crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MEDBASE_KEY).toBe('medbase');
    expect(MEDBASE_COMPANY_NAME).toBe('Medbase');
    expect(MEDBASE_BROWSER_PUBLIC_URL).toBe(
      'https://wd502.myworkdaysite.com/de-CH/recruiting/medbase/Medbase_jobs/',
    );
  });

  // ── isCompanyJob ──
  describe('isMedbaseJob', () => {
    it('matches by companyKey', () => {
      expect(isMedbaseJob({ companyKey: 'medbase' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMedbaseJob({ company: 'Medbase' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMedbaseJob({ url: 'https://medbase.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMedbaseJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMedbaseJob(null)).toBe(false);
      expect(isMedbaseJob(undefined)).toBe(false);
      expect(isMedbaseJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://medbase.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.medbase.ch/job/456')).toBe(true);
    });

    it('trusts the Workday tenant host', () => {
      expect(isTrustedDomain('https://medbase.wd502.myworkdayjobs.com/en/Medbase_jobs/job/abc')).toBe(true);
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
      const slug = slugify('Physiotherapeut:in (a) 40-80%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Pharmaassistentin Zürich')).toBe('pharmaassistentin-zurich');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Apotheker medbase ch')).toBe('apotheker-medbase-ch');
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
      id: 'medbase-abc123',
      slug: 'test-position-medbase-ch',
      slugByLocale: { de: 'test-position-medbase-ch' },
      company: 'Medbase',
      companyKey: 'medbase',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Winterthur',
      canton: 'ZH',
      url: 'https://medbase.ch/jobs/test',
      source: 'Medbase Dedicated Parser',
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
      expect(validJob.id).toMatch(/^medbase-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('transport fallback', () => {
    it('bootstraps the browser on Medbase public Workday site after a CXS transport failure', async () => {
      vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      const page = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        evaluate: vi.fn().mockImplementation(async (_fn, args) => {
          const url = String(args.requestUrl);
          if (url.endsWith('/jobs')) {
            return {
              status: 200,
              body: JSON.stringify({
                total: 1,
                jobPostings: [{
                  title: 'Physiotherapeut:in',
                  externalPath: '/job/Winterthur/Physiotherapeut-in_R1',
                  locationsText: 'Winterthur',
                }],
              }),
            };
          }
          if (url.endsWith('/sidebar')) return { status: 200, body: '[]' };
          return {
            status: 200,
            body: JSON.stringify({
              jobPostingInfo: {
                location: 'Winterthur, Switzerland',
                jobRequisitionLocation: {
                  country: { alpha2Code: 'CH', descriptor: 'Switzerland' },
                },
                jobDescription: 'Responsibilities include patient care, clinical documentation, interdisciplinary teamwork, careful treatment planning, reliable communication with patients and colleagues, and a structured contribution to the Medbase team. You coordinate appointments, document treatment progress, participate in quality improvement, and explain next steps clearly to patients and families. We offer professional development, modern facilities, flexible working arrangements, a supportive working environment, and close collaboration with experienced specialists across the network.',
              },
            }),
          };
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const context = {
        newPage: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const browser = {
        version: () => '140.0.0',
        newContext: vi.fn().mockResolvedValue(context),
        close: vi.fn().mockResolvedValue(undefined),
      };
      launchStealthOrChromiumMock.mockResolvedValue(browser);

      const jobs = await fetchAllMedbaseJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ title: 'Physiotherapeut:in', canton: 'ZH' });
      expect(page.goto).toHaveBeenCalledWith(
        MEDBASE_BROWSER_PUBLIC_URL,
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
      expect(browser.close).toHaveBeenCalledOnce();
    });
  });
});
