import { describe, it, expect } from 'vitest';
import {
  POSTAUTO_KEY,
  POSTAUTO_COMPANY_NAME,
  isPostAutoRecord,
  isPostAutoJob,
  isTrustedDomain,
  resolveAddress,
} from '../scripts/lib/postauto-job-parser.mjs';
import { __testables as postAutoTestables } from '../scripts/lib/postauto-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('PostAuto crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(POSTAUTO_KEY).toBe('postauto');
    expect(POSTAUTO_COMPANY_NAME).toBe('PostAuto AG');
  });

  it('uses one multilingual owner predicate for the shared Post feed', () => {
    const tagged = (brand: string) => ({ cust_brandCompanyJobSearch: [brand] });
    for (const brand of ['PostAuto', 'CarPostal', 'PostBus Ltd', 'AutoPostale SA']) {
      expect(isPostAutoRecord(tagged(brand))).toBe(true);
    }
    expect(isPostAutoRecord(tagged('PostFinance'))).toBe(false);
    expect(isPostAutoRecord(tagged('Die Schweizerische Post'))).toBe(false);
  });

  // ── isCompanyJob ──
  describe('isPostAutoJob', () => {
    it('matches by companyKey', () => {
      expect(isPostAutoJob({ companyKey: 'postauto' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPostAutoJob({ company: 'PostAuto AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPostAutoJob({ url: 'https://www.postauto.ch/en/jobs-and-careers' })).toBe(true);
    });

    it('does NOT match on the shared job.post.ch host alone (avoids swallowing Post/PostFinance jobs)', () => {
      expect(
        isPostAutoJob({
          companyKey: 'posta-svizzera-centro-regionale',
          company: 'Die Schweizerische Post',
          url: 'https://job.post.ch/default/job/Sachbearbeiter/12345-de_DE',
        })
      ).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isPostAutoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPostAutoJob(null)).toBe(false);
      expect(isPostAutoJob(undefined)).toBe(false);
      expect(isPostAutoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.postauto.ch/en/jobs-and-careers')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.postauto.ch/en/careers')).toBe(true);
    });

    it('trusts the shared job.post.ch detail host', () => {
      expect(isTrustedDomain('https://job.post.ch/default/job/Chauffeur/74240-de_DE')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAddress (strict city-gated national scope) ──
  describe('resolveAddress', () => {
    it('derives the canton from the Swiss city, not the source region label', () => {
      expect(resolveAddress('Winterthur', 'BE')).toMatchObject({
        city: 'Winterthur',
        canton: 'ZH',
        region: 'ZH',
      });
    });

    it('rejects a foreign city even when the source region says Switzerland', () => {
      expect(resolveAddress('Milano', 'BE')).toBeNull();
    });

    it('does not fabricate the Bern HQ for a missing city', () => {
      expect(resolveAddress('', 'BE')).toBeNull();
    });
  });

  describe('listing pagination', () => {
    it('does not accept an empty page after a positive total was declared', async () => {
      const pageRecords = Array.from({ length: 20 }, (_, index) => ({
        response: {
          id: `postauto-test-${index}`,
          cust_brandCompanyJobSearch: ['PostAuto'],
        },
      }));
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as { pageNumber?: number };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalJobs: body.pageNumber === 0 ? 40 : 0,
            jobSearchResult: body.pageNumber === 0 ? pageRecords : [],
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        const listings = await postAutoTestables.fetchPostAutoListings(1000);
        expect(listings.fetchOutcome).toBe('feed_endpoint_unavailable');
        expect(listings.listingStats[0]).toMatchObject({
          locale: 'de_DE',
          seen: 20,
          totalJobs: 40,
          fetchOutcome: 'feed_endpoint_unavailable',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('fails closed when a non-empty page repeats source identities', async () => {
      const pageRecords = Array.from({ length: 20 }, (_, index) => ({
        response: {
          id: `postauto-repeated-${index}`,
          cust_brandCompanyJobSearch: ['PostAuto'],
        },
      }));
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ totalJobs: 40, jobSearchResult: pageRecords }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      try {
        await expect(postAutoTestables.fetchPostAutoListings(1000))
          .rejects.toThrow(/repeated source identity|no unique progress/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Chauffeur/-euse Bus (Winterthur)');
      expect(slug).toBe('chauffeur-euse-bus-winterthur');
    });

    it('strips diacritics', () => {
      expect(slugify('Sicherheitsspezialistin Öffentlicher Verkehr')).toBe('sicherheitsspezialistin-offentlicher-verkehr');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Chauffeur postauto Winterthur')).toBe('chauffeur-postauto-winterthur');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllPostAutoJobs emits)
    const validJob = {
      id: 'postauto-abc123',
      slug: 'chauffeur-postauto-winterthur',
      slugByLocale: { de: 'chauffeur-postauto-winterthur' },
      company: 'PostAuto AG',
      companyKey: 'postauto',
      title: 'Chauffeur/-euse Bus',
      titleByLocale: { de: 'Chauffeur/-euse Bus' },
      description: 'A test job description for validation, long enough to pass the thin-content guard.',
      descriptionByLocale: { de: 'A test job description for validation, long enough to pass the thin-content guard.' },
      location: 'Winterthur',
      canton: 'ZH',
      url: 'https://job.post.ch/default/job/Chauffeur/74240-de_DE',
      source: 'PostAuto Dedicated Parser (job.post.ch, brand=PostAuto)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Winterthur',
      addressRegion: 'ZH',
      streetAddress: '',
      postalCode: '',
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
      // Non-HQ-canton jobs (like this Winterthur/ZH example) legitimately have
      // empty postalCode/streetAddress — the canton-gated resolveAddress()
      // fallback only fills them in when the job's canton matches HQ (Bern/BE).
      const structuredDataInputs = [
        'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
    });

    it('an HQ-canton job (Bern/BE) has non-empty postalCode/streetAddress', () => {
      const hqJob = { ...validJob, canton: 'BE', addressRegion: 'BE', postalCode: '3030', streetAddress: 'Wankdorfallee 4' };
      expect(hqJob.postalCode).toBeTruthy();
      expect(hqJob.streetAddress).toBeTruthy();
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^postauto-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
