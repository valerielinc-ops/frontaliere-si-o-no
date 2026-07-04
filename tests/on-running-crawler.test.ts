import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  ON_RUNNING_KEY,
  ON_RUNNING_COMPANY_NAME,
  ON_RUNNING_COMPANY_DOMAIN,
  isOnRunningJob,
  isTrustedDomain,
  resolveAddress,
  fetchAllOnRunningJobs,
  CAREER_URL,
} from '../scripts/lib/on-running-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('On Running crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(ON_RUNNING_KEY).toBe('on-running');
    expect(ON_RUNNING_COMPANY_NAME).toBe('On Running');
    expect(ON_RUNNING_COMPANY_DOMAIN).toBe('on-running.com');
    expect(CAREER_URL).toMatch(/^https:\/\/culture\.on\.com\//);
  });

  // ── isCompanyJob ──
  describe('isOnRunningJob', () => {
    it('matches by companyKey', () => {
      expect(isOnRunningJob({ companyKey: 'on-running' })).toBe(true);
    });

    it('matches by company name "On Running"', () => {
      expect(isOnRunningJob({ company: 'On Running' })).toBe(true);
    });

    it('matches by company name "On" alone', () => {
      expect(isOnRunningJob({ company: 'On' })).toBe(true);
    });

    it('matches by Greenhouse board URL', () => {
      expect(isOnRunningJob({ url: 'https://boards.greenhouse.io/onrunning/jobs/12345' })).toBe(true);
    });

    it('matches by culture.on.com career-site URL', () => {
      expect(isOnRunningJob({ url: 'https://culture.on.com/jobs/12345' })).toBe(true);
    });

    it('matches by on-running.com domain URL', () => {
      expect(isOnRunningJob({ url: 'https://www.on-running.com/en-ch/careers/12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOnRunningJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('does NOT false-positive on unrelated jobs merely containing the letters "on"', () => {
      // "On" is a common English word/substring — must not loosely substring-match.
      expect(isOnRunningJob({ company: 'Amazon', url: 'https://amazon.jobs/123' })).toBe(false);
      expect(isOnRunningJob({ company: 'Johnson & Johnson', url: 'https://jnj.com/careers/123' })).toBe(false);
      expect(isOnRunningJob({ title: 'Construction Site Manager', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOnRunningJob(null)).toBe(false);
      expect(isOnRunningJob(undefined)).toBe(false);
      expect(isOnRunningJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://on-running.com/en-ch/careers')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://www.on-running.com/en-ch/careers')).toBe(true);
    });

    it('trusts the on.com career micro-site domain', () => {
      expect(isTrustedDomain('https://culture.on.com/jobs/12345')).toBe(true);
    });

    it('trusts the Greenhouse ATS host', () => {
      expect(isTrustedDomain('https://boards.greenhouse.io/onrunning/jobs/12345')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/OnRunning/12345')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated, NEVER canton-only) ──
  describe('resolveAddress', () => {
    it('resolves the Zürich HQ street address', () => {
      expect(resolveAddress('Zurich')).toEqual({
        city: 'Zürich',
        postalCode: '8005',
        streetAddress: 'Förrlibuckstrasse 190',
      });
    });

    it('matches the umlaut spelling too', () => {
      expect(resolveAddress('Zürich')).toEqual({
        city: 'Zürich',
        postalCode: '8005',
        streetAddress: 'Förrlibuckstrasse 190',
      });
    });

    it('extracts the Zurich fragment from a combined multi-office location string', () => {
      expect(resolveAddress('London; Zurich')).toEqual({
        city: 'Zürich',
        postalCode: '8005',
        streetAddress: 'Förrlibuckstrasse 190',
      });
    });

    it('does NOT inherit the HQ street/postal code for a same-canton (ZH) city that is not Zürich', () => {
      // Winterthur is canton ZH, same as Zürich — canton-only gating would
      // wrongly inherit the HQ address here. City-text gating must not.
      const resolved = resolveAddress('Winterthur');
      expect(resolved.city).toBe('Winterthur');
      expect(resolved.postalCode).not.toBe('8005');
      expect(resolved.streetAddress).not.toBe('Förrlibuckstrasse 190');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('does NOT inherit the HQ address for another ZH city (Uster)', () => {
      const resolved = resolveAddress('Uster');
      expect(resolved.city).toBe('Uster');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('falls back to the HQ city/address for an empty/unknown location', () => {
      const resolved = resolveAddress('');
      expect(resolved.city).toBe('Zürich');
      expect(resolved.postalCode).toBe('8005');
      expect(resolved.streetAddress).toBe('Förrlibuckstrasse 190');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('builds slug with company suffix inline', () => {
      expect(slugify('Retail Associate on-running ch')).toBe('retail-associate-on-running-ch');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité on-running ch')).toBe('ingenieur-qualite-on-running-ch');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'on-running-abc123',
      slug: 'test-position-on-running-ch',
      slugByLocale: { en: 'test-position-on-running-ch' },
      company: 'On Running',
      companyKey: 'on-running',
      companyDomain: 'on-running.com',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://boards.greenhouse.io/onrunning/jobs/12345',
      source: 'On Running Dedicated Parser (Greenhouse)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Förrlibuckstrasse 190',
      postalCode: '8005',
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
      expect(validJob.id).toMatch(/^on-running-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('fetchAllOnRunningJobs (Greenhouse board "onrunning")', () => {
  beforeEach(() => { process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0'; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  function rawJob(over = {}) {
    return {
      id: 900001,
      title: 'Retail Associate (a) 80-100%',
      location: { name: 'Zurich' },
      absolute_url: 'https://boards.greenhouse.io/onrunning/jobs/900001',
      first_published: '2026-06-20T09:12:00Z',
      updated_at: '2026-06-21T09:12:00Z',
      content: '&lt;p&gt;Join our retail team in Zurich supporting customers with our latest running gear.&lt;/p&gt;',
      ...over,
    };
  }

  function mockBoard(jobs: unknown[]) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobs }),
    } as unknown as Response);
  }

  it('maps a Greenhouse record to a job with decoded description + Zürich HQ address', async () => {
    mockBoard([rawJob()]);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.title).toBe('Retail Associate (a) 80-100%');
    expect(j.location).toBe('Zürich');
    expect(j.canton).toBe('ZH');
    expect(j.postalCode).toBe('8005');
    expect(j.streetAddress).toBe('Förrlibuckstrasse 190');
    expect(j.employmentType).toBe('FULL_TIME');
    // Double-encoded entities must be decoded, not leaked as literal tag soup.
    expect(j.description).not.toMatch(/&lt;|&gt;/);
    expect(j.description).toMatch(/Join our retail team/);
    expect(j.company).toBe('On Running');
    expect(j.companyKey).toBe('on-running');
    expect(j.id).toMatch(/^on-running-/);
  });

  it('excludes non-Swiss postings', async () => {
    mockBoard([
      rawJob({ id: 900002, title: 'Warehouse Associate', location: { name: 'Berlin, Germany' } }),
    ]);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toHaveLength(0);
  });

  it('extracts the Zurich fragment from a combined multi-office listing and excludes non-Swiss single-office ones', async () => {
    mockBoard([
      rawJob({ id: 900003, title: 'Global Brand Manager', location: { name: 'London; Zurich' } }),
      rawJob({ id: 900004, title: 'Sales Associate France', location: { name: 'Paris, France' } }),
    ]);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('Zürich');
  });

  it('maps employmentType variants from title/description via the shared contract classifier', async () => {
    mockBoard([
      rawJob({ id: 900005, title: 'Intern - EMEA Sales Planning', location: { name: 'Zurich' }, absolute_url: 'https://boards.greenhouse.io/onrunning/jobs/900005' }),
      rawJob({ id: 900006, title: 'Fit Model (Flexible, Part-Time Opportunity)', location: { name: 'Zurich' }, absolute_url: 'https://boards.greenhouse.io/onrunning/jobs/900006' }),
    ]);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toHaveLength(2);
    const intern = jobs.find((j) => j.title.includes('Intern'));
    const partTime = jobs.find((j) => j.title.includes('Part-Time'));
    expect(intern.employmentType).toBe('INTERN');
    expect(partTime.employmentType).toBe('PART_TIME');
  });

  it('does not inherit the HQ address for a Winterthur (same-canton, different-city) posting', async () => {
    mockBoard([
      rawJob({ id: 900007, title: 'Logistics Coordinator', location: { name: 'Winterthur, Switzerland' } }),
    ]);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('Winterthur');
    expect(jobs[0].postalCode).toBe('');
    expect(jobs[0].streetAddress).toBe('');
    expect(jobs[0].canton).toBe('ZH');
  });

  it('dedups repeated postings by apply URL', async () => {
    mockBoard([rawJob(), rawJob()]);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toHaveLength(1);
  });

  it('returns [] (no throw) when the API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    const jobs = await fetchAllOnRunningJobs();
    expect(jobs).toEqual([]);
  });
});
