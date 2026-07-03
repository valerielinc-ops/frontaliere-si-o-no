import { describe, it, expect, vi } from 'vitest';
import {
  IGROOVE_KEY,
  IGROOVE_COMPANY_NAME,
  isIgrooveJob,
  isTrustedDomain,
} from '../scripts/lib/igroove-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('iGroove crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IGROOVE_KEY).toBe('igroove');
    expect(IGROOVE_COMPANY_NAME).toBe('iGroove AG');
  });

  // ── isCompanyJob ──
  describe('isIgrooveJob', () => {
    it('matches by companyKey', () => {
      expect(isIgrooveJob({ companyKey: 'igroove' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isIgrooveJob({ company: 'iGroove AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isIgrooveJob({ url: 'https://www.igroovemusic.com/careers/123' })).toBe(true);
    });

    it('matches by Personio ATS board URL', () => {
      expect(isIgrooveJob({ url: 'https://igroove.jobs.personio.de/job/2588083' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isIgrooveJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isIgrooveJob(null)).toBe(false);
      expect(isIgrooveJob(undefined)).toBe(false);
      expect(isIgrooveJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.igroovemusic.com/careers/job-123')).toBe(true);
    });

    it('trusts Personio ATS domain (job feed host)', () => {
      expect(isTrustedDomain('https://igroove.jobs.personio.de/job/2588083')).toBe(true);
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
      const slug = slugify('Senior Data Pipeline Engineer (Zürich)');
      expect(slug).toBe('senior-data-pipeline-engineer-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Senior Data Pipeline Engineer igroove Zürich')).toBe('senior-data-pipeline-engineer-igroove-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllIgrooveJobs emits)
    const validJob = {
      id: 'igroove-abc123',
      slug: 'senior-data-pipeline-engineer-igroove-zurich',
      slugByLocale: { de: 'senior-data-pipeline-engineer-igroove-zurich' },
      company: 'iGroove AG',
      companyKey: 'igroove',
      title: 'Senior Data Pipeline Engineer',
      titleByLocale: { de: 'Senior Data Pipeline Engineer' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich Hybrid',
      canton: 'ZH',
      url: 'https://igroove.jobs.personio.de/job/2588083',
      source: 'iGroove Dedicated Parser (Personio)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: '',
      postalCode: '8001',
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
      // postalCode/streetAddress inputs are ALWAYS present as keys (never
      // dropped), but streetAddress may legitimately be empty when no
      // confirmed Zürich office address is known — see HQ fallback comment
      // in scripts/lib/igroove-job-parser.mjs.
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob.postalCode).toBeTruthy();
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^igroove-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllIgrooveJobs (mocked Personio client, no network) ──
  describe('fetchAllIgrooveJobs', () => {
    it('maps a normalized Personio position into the repo job shape', async () => {
      vi.resetModules();
      vi.doMock('../scripts/lib/ats-clients/personio-client.mjs', () => ({
        fetchPersonioJobs: vi.fn(async () => [
          {
            jobReqId: '2588083',
            title: 'Senior Data Pipeline Engineer',
            location: 'Zürich Hybrid',
            department: 'IT',
            postedAt: '2026-03-31T07:10:55.000Z',
            applyUrl: 'https://igroove.jobs.personio.de/job/2588083',
            descriptionHtml: '<p>Build our data pipeline.</p>',
            employmentType: 'permanent',
            seniority: 'experienced',
            schedule: 'full-time',
            rawPosition: {},
          },
        ]),
      }));

      const { fetchAllIgrooveJobs } = await import('../scripts/lib/igroove-job-parser.mjs');
      const jobs = await fetchAllIgrooveJobs();

      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.companyKey).toBe('igroove');
      expect(job.company).toBe('iGroove AG');
      expect(job.title).toBe('Senior Data Pipeline Engineer');
      expect(job.canton).toBe('ZH');
      expect(job.url).toBe('https://igroove.jobs.personio.de/job/2588083');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.postalCode).toBe('8001');
      expect(job.id).toMatch(/^igroove-/);

      vi.doUnmock('../scripts/lib/ats-clients/personio-client.mjs');
      vi.resetModules();
    });

    it('returns an empty array when the feed has no positions', async () => {
      vi.resetModules();
      vi.doMock('../scripts/lib/ats-clients/personio-client.mjs', () => ({
        fetchPersonioJobs: vi.fn(async () => []),
      }));

      const { fetchAllIgrooveJobs } = await import('../scripts/lib/igroove-job-parser.mjs');
      const jobs = await fetchAllIgrooveJobs();
      expect(jobs).toEqual([]);

      vi.doUnmock('../scripts/lib/ats-clients/personio-client.mjs');
      vi.resetModules();
    });
  });
});
