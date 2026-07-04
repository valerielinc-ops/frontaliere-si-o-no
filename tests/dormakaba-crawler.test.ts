import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  DORMAKABA_KEY,
  DORMAKABA_COMPANY_NAME,
  isDormakabaJob,
  isTrustedDomain,
  resolveAddress,
  fetchAllDormakabaJobs,
} from '../scripts/lib/dormakaba-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('dormakaba crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DORMAKABA_KEY).toBe('dormakaba');
    expect(DORMAKABA_COMPANY_NAME).toBe('dormakaba');
  });

  // ── isCompanyJob ──
  describe('isDormakabaJob', () => {
    it('matches by companyKey', () => {
      expect(isDormakabaJob({ companyKey: 'dormakaba' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDormakabaJob({ company: 'dormakaba' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDormakabaJob({ url: 'https://jobs.dormakaba.com/job-invite/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDormakabaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDormakabaJob(null)).toBe(false);
      expect(isDormakabaJob(undefined)).toBe(false);
      expect(isDormakabaJob({})).toBe(false);
    });

    it('rejects Legic jobs even though they share the dormakaba ATS instance', () => {
      // LEGIC Identsystems AG is a genuinely separate Swiss legal entity that
      // shares the same recruiting-solutions.org tenant as dormakaba — must
      // never be emitted as a dormakaba job.
      expect(
        isDormakabaJob({ companyKey: 'dormakaba', company: 'dormakaba', legalEntity: 'LEGIC Identsystems AG' }),
      ).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://dormakaba.com/ch-de/karriere')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.dormakaba.com/job-invite/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated, NEVER canton-only) ──
  describe('resolveAddress', () => {
    it('resolves the Rümlang group HQ street address', () => {
      expect(resolveAddress('Rümlang')).toEqual({
        streetAddress: 'Hofwisenstrasse 24',
        postalCode: '8153',
        canton: 'ZH',
      });
    });

    it('matches the Rümlang city name with an ASCII "u" spelling too', () => {
      expect(resolveAddress('Rumlang')).toMatchObject({ postalCode: '8153' });
    });

    it('resolves the Wetzikon (dormakaba Schweiz AG) street address', () => {
      expect(resolveAddress('Wetzikon')).toEqual({
        streetAddress: 'Mühlebühlstrasse 23',
        postalCode: '8623',
        canton: 'ZH',
      });
    });

    it('does NOT match on canton alone — an unrelated ZH city returns null', () => {
      // Both known offices are canton ZH; a same-canton city that is neither
      // Rümlang nor Wetzikon must not inherit either exact street address.
      expect(resolveAddress('Winterthur')).toBeNull();
      expect(resolveAddress('Zürich')).toBeNull();
    });

    it('returns null for an empty/unknown city', () => {
      expect(resolveAddress('')).toBeNull();
      expect(resolveAddress('St. Gallen')).toBeNull();
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('builds slug with company suffix inline', () => {
      expect(slugify('Servicetechniker dormakaba ch')).toBe('servicetechniker-dormakaba-ch');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité dormakaba ch')).toBe('ingenieur-qualite-dormakaba-ch');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'dormakaba-11691',
      slug: 'test-position-dormakaba-ch',
      slugByLocale: { de: 'test-position-dormakaba-ch' },
      company: 'dormakaba',
      companyKey: 'dormakaba',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Rümlang',
      canton: 'ZH',
      url: 'https://jobs.dormakaba.com/job-invite/11691',
      source: 'dormakaba Dedicated Parser',
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
      expect(validJob.id).toMatch(/^dormakaba-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('fetchAllDormakabaJobs (recruiting-solutions.org search API)', () => {
  beforeEach(() => { process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0'; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  function apiRecord(over = {}) {
    return {
      jobId: '11691-de_DE',
      language: 'de_DE',
      defaultLanguage: 'de_DE',
      title: 'Servicetechniker Zutrittskontrolle (a) 100%',
      legalEntity: 'dormakaba Schweiz AG',
      brandName: 'dormakaba',
      jobTypeLabel: 'Full-Time',
      jobLevelLabel: 'Professional',
      jobFunctionLabel: 'Service',
      datePosted: '2026-06-20T09:12:00Z',
      link: 'https://jobs.dormakaba.com/job-invite/11691/?locale=de_DE',
      description:
        '<div><h2><b>IHRE AUFGABEN</b></h2><p>Als Servicetechniker bist du zuständig für Installation und Wartung unserer Zutrittslösungen.</p><ul><li>Montage und Inbetriebnahme von Türsystemen</li><li>Wartung und Reparatur beim Kunden vor Ort</li></ul></div>',
      addresses: [{ city: 'Wetzikon', country: 'Schweiz', isPrimary: true }],
      ...over,
    };
  }

  function mockSearch(records: unknown[]) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ '@odata.count': records.length, value: records }),
    } as unknown as Response);
  }

  it('maps an API record to a job with the REAL (non-synthetic) description', async () => {
    mockSearch([apiRecord()]);
    const jobs = await fetchAllDormakabaJobs();
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.title).toBe('Servicetechniker Zutrittskontrolle (a) 100%');
    expect(j.location).toBe('Wetzikon');
    expect(j.postalCode).toBe('8623');
    expect(j.streetAddress).toBe('Mühlebühlstrasse 23');
    expect(j.canton).toBe('ZH');
    expect(j.employmentType).toBe('FULL_TIME');
    expect(j.experienceLevel).toBe('mid'); // Professional → mid
    expect(j.description.length).toBeGreaterThan(100);
    expect(j.description).toMatch(/IHRE AUFGABEN/);
    expect(j.description).toMatch(/(^|\n)- /);
    expect(j.descriptionByLocale.de).toBe(j.description);
  });

  it('dedups locale variants of the same physical job by internal id, preferring the authored copy', async () => {
    mockSearch([
      apiRecord({ jobId: '11691-de_DE', language: 'de_DE', defaultLanguage: 'de_DE' }),
      apiRecord({ jobId: '11691-en_US', language: 'en_US', defaultLanguage: 'de_DE', title: 'Service Technician Access Control (a) 100%' }),
    ]);
    const jobs = await fetchAllDormakabaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('dormakaba-11691');
    expect(jobs[0].sourceLang).toBe('de'); // authored (language === defaultLanguage) preferred over MT copy
  });

  it('excludes LEGIC Identsystems AG jobs (separate legal entity sharing the same ATS tenant)', async () => {
    mockSearch([
      apiRecord({ jobId: '20001-de_DE', legalEntity: 'LEGIC Identsystems AG', brandName: 'Legic' }),
    ]);
    const jobs = await fetchAllDormakabaJobs();
    expect(jobs).toHaveLength(0);
  });

  it('resolves the Rümlang HQ address for group-HQ postings', async () => {
    mockSearch([
      apiRecord({
        jobId: '30001-de_DE',
        title: 'HR Business Partner Group (a) 100%',
        addresses: [{ city: 'Rümlang', country: 'Schweiz', isPrimary: true }],
      }),
    ]);
    const jobs = await fetchAllDormakabaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('Rümlang');
    expect(jobs[0].postalCode).toBe('8153');
    expect(jobs[0].streetAddress).toBe('Hofwisenstrasse 24');
  });

  it('skips records whose description is empty instead of synthesising one', async () => {
    mockSearch([apiRecord({ description: '' })]);
    const jobs = await fetchAllDormakabaJobs();
    expect(jobs).toHaveLength(0);
  });

  it('returns [] (no throw) when the API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    const jobs = await fetchAllDormakabaJobs();
    expect(jobs).toEqual([]);
  });
});
