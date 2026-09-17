import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  SWISS_LIFE_KEY,
  SWISS_LIFE_COMPANY_NAME,
  assertSwissLifeNationalReadComplete,
  fetchSwissListings,
  isSwissLifeJob,
  isTrustedDomain,
  parseWorkdayLocation,
  resolveSwissLifeLocation,
} from '../scripts/lib/swiss-life-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function makeListing(id: string, locationsText = 'Zürich, Switzerland') {
  return {
    externalPath: `/job/${id}`,
    title: `Swiss Life job ${id}`,
    locationsText,
    bulletFields: [id],
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Swiss Life crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWISS_LIFE_KEY).toBe('swiss-life');
    expect(SWISS_LIFE_COMPANY_NAME).toBe('Swiss Life');
  });

  it('keeps the city before a mixed canton/country suffix', () => {
    expect(parseWorkdayLocation('Sion – VS, Suisse romande')).toBe('Sion');
    expect(parseWorkdayLocation('Sion-VS')).toBe('Sion');
    expect(parseWorkdayLocation('Visp-Switzerland')).toBe('Visp');
    expect(parseWorkdayLocation('ST-MAURICE')).toBe('ST-MAURICE');
  });

  it('resolves Swiss locations across cantons', () => {
    expect(resolveSwissLifeLocation({ location: 'Zürich, Switzerland' })).toBe('Zürich');
    expect(resolveSwissLifeLocation({ location: 'Lugano, Ticino' })).toBe('Lugano');
  });

  it('prefers a concrete additional locality over a country-only primary descriptor', () => {
    expect(resolveSwissLifeLocation({
      location: 'Switzerland',
      additionalLocations: [{ descriptor: 'Zürich, Switzerland' }],
    })).toBe('Zürich');
  });

  it('fails closed when no Swiss locality and canton can be resolved', () => {
    expect(resolveSwissLifeLocation({ location: 'Switzerland' })).toBe('');
    expect(resolveSwissLifeLocation({ location: 'Arezzo, Italy' })).toBe('');
  });

  // ── isCompanyJob ──
  describe('isSwissLifeJob', () => {
    it('matches by companyKey', () => {
      expect(isSwissLifeJob({ companyKey: 'swiss-life' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwissLifeJob({ company: 'Swiss Life' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwissLifeJob({ url: 'https://swisslife.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwissLifeJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwissLifeJob(null)).toBe(false);
      expect(isSwissLifeJob(undefined)).toBe(false);
      expect(isSwissLifeJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swisslife.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swisslife.ch/job/456')).toBe(true);
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
      expect(slugify('Developer swiss-life ch')).toBe('developer-swiss-life-ch');
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
      id: 'swiss-life-abc123',
      slug: 'test-position-swiss-life-ch',
      slugByLocale: { de: 'test-position-swiss-life-ch' },
      company: 'Swiss Life',
      companyKey: 'swiss-life',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://swisslife.ch/jobs/test',
      source: 'Swiss Life Dedicated Parser',
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
      expect(validJob.id).toMatch(/^swiss-life-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('national pagination', () => {
    it('continues after a short page until the declared total is reached', async () => {
      const pages = new Map([
        [0, { total: 2, jobPostings: [makeListing('one')] }],
        [1, { total: 2, jobPostings: [makeListing('two')] }],
      ]);
      const offsets: number[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        offsets.push(body.offset);
        return jsonResponse(pages.get(body.offset) || { total: 2, jobPostings: [] });
      }));

      const listings = await fetchSwissListings();

      expect(offsets).toEqual([0, 1]);
      expect(listings.map((listing) => listing.externalPath)).toEqual(['/job/one', '/job/two']);
    });

    it('fails explicitly when an empty page leaves the declared total incomplete', async () => {
      const pages = new Map([
        [0, { total: 2, jobPostings: [makeListing('only')] }],
        [1, { total: 2, jobPostings: [] }],
      ]);
      vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        return jsonResponse(pages.get(body.offset) || { total: 2, jobPostings: [] });
      }));

      await expect(fetchSwissListings()).rejects.toThrow(/1 of 2 declared records fetched/);
    });
  });

  describe('national read completeness', () => {
    it('accepts a single declared listing without a count gate', () => {
      expect(() => assertSwissLifeNationalReadComplete({
        terminationProven: true,
        totalHits: 1,
        recordsSeen: 1,
      })).not.toThrow();
    });

    it('rejects a truncated read against the declared total', () => {
      expect(() => assertSwissLifeNationalReadComplete({
        terminationProven: false,
        totalHits: 123,
        recordsSeen: 80,
      })).toThrow(/80 of 123 declared records fetched/);
    });
  });
});
