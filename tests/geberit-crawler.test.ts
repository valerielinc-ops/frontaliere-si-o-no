import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  GEBERIT_KEY,
  GEBERIT_COMPANY_NAME,
  isGeberitJob,
  isTrustedDomain,
  fetchAllGeberitJobs,
} from '../scripts/lib/geberit-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Geberit crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GEBERIT_KEY).toBe('geberit');
    expect(GEBERIT_COMPANY_NAME).toBe('Geberit');
  });

  // ── isCompanyJob ──
  describe('isGeberitJob', () => {
    it('matches by companyKey', () => {
      expect(isGeberitJob({ companyKey: 'geberit' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGeberitJob({ company: 'Geberit' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGeberitJob({ url: 'https://geberit.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGeberitJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGeberitJob(null)).toBe(false);
      expect(isGeberitJob(undefined)).toBe(false);
      expect(isGeberitJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://geberit.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.geberit.com/job/456')).toBe(true);
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
      expect(slugify('Developer geberit ch')).toBe('developer-geberit-ch');
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
      id: 'geberit-abc123',
      slug: 'test-position-geberit-ch',
      slugByLocale: { de: 'test-position-geberit-ch' },
      company: 'Geberit',
      companyKey: 'geberit',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://geberit.com/jobs/test',
      source: 'Geberit Dedicated Parser',
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
      expect(validJob.id).toMatch(/^geberit-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('fetchAllGeberitJobs (SuccessFactors RMK search API)', () => {
  // Skip the real exponential backoff (1s/2s/4s) fetchWithRetry does on
  // retryable statuses — the 503 test below deliberately triggers it.
  beforeEach(() => { process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0'; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  function apiRecord(over = {}) {
    return {
      jobId: '1799-de_DE',
      language: 'de_DE',
      title: 'Strategic Project Buyer (a) 100%',
      datePosted: '2026-05-16T12:35:05Z',
      jobType: { code: 'Full-Time', label: 'Vollzeit' },
      link: 'https://jobs.geberit.com/job-invite/1799/?locale=de_DE',
      description:
        "<div><h2><b>HAUPTAUFGABEN</b></h2><p>Als Strategic Project Buyer bist du zuständig für die Bereitstellung der Einkaufsartikel.</p><ul><li>Evaluierung von Lieferanten im Rahmen der Entwicklungsprojekte</li><li>Verantwortung für die rechtzeitige Bereitstellung der Beschaffungsartikel</li></ul></div>",
      addresses: [{ city: 'Rapperswil-Jona', postalCode: '8645', country: 'Schweiz', street: 'Schachenstrasse 77', countryCode: 'CHE' }],
      ...over,
    };
  }

  function mockSearch(records) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ '@odata.count': records.length, value: records }),
    } as unknown as Response);
  }

  it('maps an RMK record to a job with the REAL (non-synthetic) description', async () => {
    mockSearch([apiRecord()]);
    const jobs = await fetchAllGeberitJobs();
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.title).toBe('Strategic Project Buyer (a) 100%');
    expect(j.location).toBe('Rapperswil-Jona');
    expect(j.postalCode).toBe('8645');
    expect(j.employmentType).toBe('FULL_TIME');
    // real description: markdown with heading + bullets, NOT a "<title> — Geberit" stub
    expect(j.description.length).toBeGreaterThan(100);
    expect(j.description).toMatch(/HAUPTAUFGABEN/);
    expect(j.description).toMatch(/(^|\n)- /);
    expect(j.description).not.toMatch(/— Geberit,/);
    expect(j.descriptionByLocale.de).toBe(j.description);
  });

  it('dedups locale variants of the same physical job by internal id', async () => {
    mockSearch([
      apiRecord({ jobId: '1799-de_DE', language: 'de_DE' }),
      apiRecord({ jobId: '1799-en_US', language: 'en_US', title: 'Strategic Project Buyer (a) 100%' }),
    ]);
    const jobs = await fetchAllGeberitJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('geberit-1799');
    expect(jobs[0].sourceLang).toBe('de'); // de preferred over en
  });

  it('skips records whose description is empty instead of synthesising one', async () => {
    mockSearch([apiRecord({ description: '' })]);
    const jobs = await fetchAllGeberitJobs();
    expect(jobs).toHaveLength(0);
  });

  it('returns [] (no throw) when the API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    const jobs = await fetchAllGeberitJobs();
    expect(jobs).toEqual([]);
  });
});
