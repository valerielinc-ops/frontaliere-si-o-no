import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NOVARTIS_KEY,
  NOVARTIS_COMPANY_NAME,
  isNovartisJob,
  isTrustedDomain,
  fetchAllNovartisJobs,
} from '../scripts/lib/novartis-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Replay harness for fetchAllNovartisJobs: the Workday network calls are
// replaced by the payloads below, every pure helper of the client stays real.
const workdayReplay = vi.hoisted(() => ({
  listings: [] as Array<Record<string, unknown>>,
  details: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    async *fetchWorkdayJobs() {
      yield* workdayReplay.listings;
    },
    fetchWorkdayJobDetail: async (_apiBase: string, externalPath: string) =>
      workdayReplay.details.get(externalPath) ?? null,
    fetchWorkdayJobDescriptionText: async () => '',
  };
});

describe('Novartis crawler parser', () => {
  // Sibling of issue 9839 (nvidia-zurich). Live board of 2026-09-25 (labels,
  // external paths and detail locations verbatim): the `Remote` listing is a
  // US job (requisition `Remote Position (USA)`) that went out as `Remote / BS`,
  // and each `4 Locations` rollup went out as the Basel HQ default, although one
  // of them is also US-remote.
  describe('fetchAllNovartisJobs replay: a job needs a named Swiss locality', () => {
    const replay = [
      { title: 'Director, AI Platform Engineer - Remote', path: '/job/Remote/Director--AI-Platform-Engineer---Remote_REQ-10080349', label: 'Remote', primary: 'Remote' },
      { title: 'AD, Patient & Community Liaison Northeast - REMOTE', path: '/job/Remote/AD--Patient---Community-Liaison-Northeast---REMOTE_REQ-10083010-1', label: '4 Locations', primary: 'Remote' },
      { title: 'Director, CRM DU Strategy & Engagement (80-100%)', path: '/job/Basel-City/Director--CRM-DU-Strategy---Engagement--80-100--_REQ-10087647-1', label: '4 Locations', primary: 'Basel (City)' },
      { title: 'Scientist', path: '/job/Stein-Aargau/Scientist_REQ-10000001', label: 'Stein Aargau', primary: 'Stein Aargau' },
    ];

    afterEach(() => {
      workdayReplay.listings = [];
      workdayReplay.details.clear();
      vi.restoreAllMocks();
    });

    it('skips a location that names no Swiss place and resolves a rollup from its detail primary', async () => {
      for (const job of replay) {
        workdayReplay.listings.push({
          title: job.title,
          externalPath: job.path,
          locationsText: job.label,
          postedOn: 'Posted 3 Days Ago',
          bulletFields: [job.path.split('_').pop()],
        });
        workdayReplay.details.set(job.path, { jobPostingInfo: { title: job.title, location: job.primary } });
      }
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const jobs = await fetchAllNovartisJobs();

      expect(jobs.map((job: { title: string; location: string; canton: string }) => [job.title, job.location, job.canton]))
        .toEqual([
          ['Director, CRM DU Strategy & Engagement (80-100%)', 'Basel (City)', 'BS'],
          ['Scientist', 'Stein Aargau', 'AG'],
        ]);
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NOVARTIS_KEY).toBe('novartis');
    expect(NOVARTIS_COMPANY_NAME).toBe('Novartis');
  });

  // ── isCompanyJob ──
  describe('isNovartisJob', () => {
    it('matches by companyKey', () => {
      expect(isNovartisJob({ companyKey: 'novartis' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNovartisJob({ company: 'Novartis' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNovartisJob({ url: 'https://novartis.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNovartisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNovartisJob(null)).toBe(false);
      expect(isNovartisJob(undefined)).toBe(false);
      expect(isNovartisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://novartis.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.novartis.ch/job/456')).toBe(true);
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
      expect(slugify('Developer novartis ch')).toBe('developer-novartis-ch');
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
      id: 'novartis-abc123',
      slug: 'test-position-novartis-ch',
      slugByLocale: { it: 'test-position-novartis-ch' },
      company: 'Novartis',
      companyKey: 'novartis',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://novartis.ch/jobs/test',
      source: 'Novartis Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^novartis-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
