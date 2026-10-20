import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIAMARKT_KEY,
  MEDIAMARKT_COMPANY_NAME,
  fetchAllMediamarktJobs,
  htmlToMarkdown,
  isMediamarktJob,
  isTrustedDomain,
} from '../scripts/lib/mediamarkt-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const recentSourceDate = () => new Date(Date.now() - 3 * 86_400_000).toISOString();

describe('MediaMarkt crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MEDIAMARKT_KEY).toBe('mediamarkt');
    expect(MEDIAMARKT_COMPANY_NAME).toBe('MediaMarkt');
  });

  // ── isCompanyJob ──
  describe('isMediamarktJob', () => {
    it('matches by companyKey', () => {
      expect(isMediamarktJob({ companyKey: 'mediamarkt' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMediamarktJob({ company: 'MediaMarkt' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMediamarktJob({ url: 'https://mediamarkt.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMediamarktJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMediamarktJob(null)).toBe(false);
      expect(isMediamarktJob(undefined)).toBe(false);
      expect(isMediamarktJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://mediamarkt.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.mediamarkt.ch/job/456')).toBe(true);
    });

    it('trusts the official MediaMarkt SuccessFactors career host', () => {
      expect(isTrustedDomain('https://careers.mediamarktsaturn.com/job-invite/100208/?locale=de_CH')).toBe(true);
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
      expect(slugify('Developer mediamarkt ch')).toBe('developer-mediamarkt-ch');
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
      id: 'mediamarkt-abc123',
      slug: 'test-position-mediamarkt-ch',
      slugByLocale: { de: 'test-position-mediamarkt-ch' },
      company: 'MediaMarkt',
      companyKey: 'mediamarkt',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://mediamarkt.ch/jobs/test',
      source: 'MediaMarkt Dedicated Parser',
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
      expect(validJob.id).toMatch(/^mediamarkt-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('fetchAllMediamarktJobs (MediaMarkt Azure Search)', () => {
  beforeEach(() => {
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  function apiRecord(over = {}) {
    return {
      jobId: '100208-de_CH',
      language: 'de_CH',
      defaultLocale: 'de_CH',
      title: 'Logistikmitarbeiter*in 100%',
      businessArea: 'Store - Logistics',
      careerLevel: 'fino a 10 anni di esperienza',
      employmentType: 'Full Time',
      datePosted: recentSourceDate(),
      link: 'https://careers.mediamarktsaturn.com/job-invite/100208/?locale=de_CH',
      description: '<div><h2>Deine Mission</h2><ul><li>Warenannahme und Warenausgabe organisieren</li><li>Die Verkaufsfläche ordentlich halten</li></ul><h2>Dein Match mit uns</h2><p>Du arbeitest zuverlässig im Team und hast Freude am Umgang mit Menschen.</p></div>',
      addresses: [{
        street: 'Feldstrasse 30',
        city: 'Gümligen',
        country: 'CHE',
        postalCode: '3073',
        isPrimary: true,
      }],
      legalEntity: 'Media Markt Muri Bern',
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

  it('converts the SPA API record into a source-backed Swiss job', async () => {
    const postedAt = recentSourceDate();
    mockSearch([apiRecord({ datePosted: postedAt })]);

    const jobs = await fetchAllMediamarktJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'mediamarkt-100208',
      title: 'Logistikmitarbeiter*in 100%',
      sourceLang: 'de',
      location: 'Gümligen',
      canton: 'BE',
      postalCode: '3073',
      streetAddress: 'Feldstrasse 30',
      addressCountry: 'CH',
      employmentType: 'FULL_TIME',
      contract: 'full-time',
      category: 'Logistica',
      sector: 'Commercio al dettaglio / Elettronica',
      datePosted: postedAt,
      postingDateSource: 'reported',
    });
    expect(jobs[0].description).toContain('## Deine Mission');
    expect(jobs[0].description).toMatch(/(^|\n)- /);
    expect(jobs[0].descriptionByLocale.de).toBe(jobs[0].description);
  });

  it('keeps the source location when the API lists a foreign address first', async () => {
    mockSearch([apiRecord({
      jobId: '100209-de_CH',
      addresses: [
        { city: 'Ingolstadt', country: 'DE', isPrimary: true },
        { city: 'Zürich', country: 'CHE', postalCode: '8045' },
      ],
    })]);

    const jobs = await fetchAllMediamarktJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Zürich', canton: 'ZH', postalCode: '8045' });
  });

  it('resolves the canton from the official Swiss postal directory', async () => {
    mockSearch([apiRecord({
      jobId: '100211-de_CH',
      addresses: [{ city: '', name: 'Media Markt Brig', country: 'CHE', postalCode: '3902', isPrimary: true }],
    })]);

    const jobs = await fetchAllMediamarktJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Glis', canton: 'VS', postalCode: '3902' });
  });

  it('deduplicates locale variants by the stable internal job ID', async () => {
    mockSearch([
      apiRecord(),
      apiRecord({ jobId: '100208-it_IT', language: 'it_IT', title: 'Addetto alla logistica 100%' }),
    ]);

    const jobs = await fetchAllMediamarktJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('mediamarkt-100208');
    expect(jobs[0].sourceLang).toBe('de');
  });

  it('does not publish a record without a resolvable Swiss locality', async () => {
    mockSearch([apiRecord({
      jobId: '100210-de_CH',
      addresses: [{ city: 'Unknownville', country: 'CHE', postalCode: '' }],
    })]);

    await expect(fetchAllMediamarktJobs()).resolves.toEqual([]);
  });

  it('preserves headings and list structure from the source description', () => {
    expect(htmlToMarkdown('<h2>Aufgaben</h2><ul><li>Erster Punkt</li><li>Zweiter Punkt</li></ul>'))
      .toBe('## Aufgaben\n\n- Erster Punkt\n- Zweiter Punkt');
  });

  it('propagates an API failure instead of treating it as an empty listing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);

    await expect(fetchAllMediamarktJobs()).rejects.toThrow(/MediaMarkt search API/);
  });
});
