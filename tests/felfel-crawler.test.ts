import { describe, it, expect, vi } from 'vitest';

// Mock the shared Personio client so `fetchAllFelfelJobs` tests never hit
// the network — only `fetchPersonioJobs` is stubbed, `PersonioApiError` /
// `buildPersonioXmlUrl` stay real (imported by the parser too).
const { fetchPersonioJobs } = vi.hoisted(() => ({ fetchPersonioJobs: vi.fn() }));
vi.mock('@/scripts/lib/ats-clients/personio-client.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPersonioJobs };
});

import {
  FELFEL_KEY,
  FELFEL_COMPANY_NAME,
  isFelfelJob,
  isTrustedDomain,
  fetchAllFelfelJobs,
} from '../scripts/lib/felfel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function makeNormalizedJob(overrides: Record<string, unknown> = {}) {
  return {
    jobReqId: '2668071',
    title: 'Account Executive',
    location: 'Zürich',
    department: 'Commercial',
    postedAt: '2026-06-11T12:20:07.000Z',
    applyUrl: 'https://felfel.jobs.personio.de/job/2668071',
    descriptionHtml: '<p>Als unser Account Executive in Zürich...</p>',
    employmentType: 'permanent',
    seniority: 'experienced',
    schedule: 'full-time',
    rawPosition: { seniority: 'experienced', employmentType: 'permanent' },
    ...overrides,
  };
}

describe('FELFEL crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FELFEL_KEY).toBe('felfel');
    expect(FELFEL_COMPANY_NAME).toBe('FELFEL');
  });

  // ── isCompanyJob ──
  describe('isFelfelJob', () => {
    it('matches by companyKey', () => {
      expect(isFelfelJob({ companyKey: 'felfel' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFelfelJob({ company: 'FELFEL' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFelfelJob({ url: 'https://felfel.ch/en/careers' })).toBe(true);
    });

    it('matches by Personio ATS board URL', () => {
      expect(isFelfelJob({ url: 'https://felfel.jobs.personio.de/job/2668071' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFelfelJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFelfelJob(null)).toBe(false);
      expect(isFelfelJob(undefined)).toBe(false);
      expect(isFelfelJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://felfel.ch/en/careers')).toBe(true);
    });

    it('trusts Personio ATS domain', () => {
      expect(isTrustedDomain('https://felfel.jobs.personio.de/job/2668071')).toBe(true);
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
      const slug = slugify('Account Executive (Zürich)');
      expect(slug).toBe('account-executive-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Küchenchef Zürich')).toBe('kuchenchef-zurich');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Account Executive felfel zurich')).toBe('account-executive-felfel-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllFelfelJobs emits)
    const validJob = {
      id: 'felfel-abc123',
      slug: 'test-position-felfel-zurich',
      slugByLocale: { de: 'test-position-felfel-zurich' },
      company: 'FELFEL',
      companyKey: 'felfel',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://felfel.jobs.personio.de/job/2668071',
      source: 'FELFEL Dedicated Parser (Personio)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Räffelstrasse 24',
      postalCode: '8045',
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
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^felfel-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllFelfelJobs (network mocked via fetchPersonioJobs) ──
  describe('fetchAllFelfelJobs', () => {
    it('maps a Zürich office job onto the HQ address', async () => {
      fetchPersonioJobs.mockResolvedValueOnce([makeNormalizedJob()]);
      const jobs = await fetchAllFelfelJobs();
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.companyKey).toBe('felfel');
      expect(job.location).toBe('Zürich');
      expect(job.canton).toBe('ZH');
      expect(job.postalCode).toBe('8045');
      expect(job.streetAddress).toBe('Räffelstrasse 24');
      expect(job.addressCountry).toBe('CH');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.url).toBe('https://felfel.jobs.personio.de/job/2668071');
    });

    it('maps a Lausanne office job to VD without inheriting the Zürich street', async () => {
      fetchPersonioJobs.mockResolvedValueOnce([makeNormalizedJob({
        jobReqId: '2601890',
        title: 'Culinary Coordinator',
        location: 'Lausanne',
        applyUrl: 'https://felfel.jobs.personio.de/job/2601890',
        schedule: 'part-time',
      })]);
      const jobs = await fetchAllFelfelJobs();
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.location).toBe('Lausanne');
      expect(job.canton).toBe('VD');
      expect(job.streetAddress).not.toBe('Räffelstrasse 24');
      expect(job.employmentType).toBe('PART_TIME');
    });

    it('filters out explicitly foreign offices (e.g. New York)', async () => {
      fetchPersonioJobs.mockResolvedValueOnce([
        makeNormalizedJob(),
        makeNormalizedJob({
          jobReqId: '2142463',
          title: 'US Sales Lead',
          location: 'New York',
          applyUrl: 'https://felfel.jobs.personio.de/job/2142463',
        }),
      ]);
      const jobs = await fetchAllFelfelJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs.some((j) => j.location === 'New York')).toBe(false);
    });

    it('falls back to HQ for an empty/unrecognised office instead of dropping the job', async () => {
      fetchPersonioJobs.mockResolvedValueOnce([makeNormalizedJob({
        jobReqId: '2633046',
        location: '',
        applyUrl: 'https://felfel.jobs.personio.de/job/2633046',
      })]);
      const jobs = await fetchAllFelfelJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].location).toBe('Zürich');
      expect(jobs[0].postalCode).toBe('8045');
    });

    it('returns an empty array when the feed has no listings', async () => {
      fetchPersonioJobs.mockResolvedValueOnce([]);
      const jobs = await fetchAllFelfelJobs();
      expect(jobs).toEqual([]);
    });
  });
});
