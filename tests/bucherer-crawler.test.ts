import { describe, it, expect } from 'vitest';
import {
  BUCHERER_KEY,
  BUCHERER_COMPANY_NAME,
  isBuchererJob,
  isTrustedDomain,
  parsePostings,
} from '../scripts/lib/bucherer-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bucherer crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BUCHERER_KEY).toBe('bucherer');
    expect(BUCHERER_COMPANY_NAME).toBe('Bucherer');
  });

  // ── isCompanyJob ──
  describe('isBuchererJob', () => {
    it('matches by companyKey', () => {
      expect(isBuchererJob({ companyKey: 'bucherer' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBuchererJob({ company: 'Bucherer' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBuchererJob({ url: 'https://www.bucherer.com/en/career/job-123' })).toBe(true);
    });

    it('matches by Dayforce candidate portal URL', () => {
      expect(isBuchererJob({ url: 'https://jobs.dayforcehcm.com/en-GB/bucherer/CANDIDATEPORTAL/Job/737' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBuchererJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBuchererJob(null)).toBe(false);
      expect(isBuchererJob(undefined)).toBe(false);
      expect(isBuchererJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.bucherer.com/en/career')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bucherer.com/job/456')).toBe(true);
    });

    it('trusts the Dayforce ATS host', () => {
      expect(isTrustedDomain('https://jobs.dayforcehcm.com/en-GB/bucherer/CANDIDATEPORTAL')).toBe(true);
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
      const slug = slugify('Sales Associate (m/f/d)');
      expect(slug).toBe('sales-associate-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Vendeur/-euse conseil')).toBe('vendeur-euse-conseil');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Sales Associate bucherer Luzern')).toBe('sales-associate-bucherer-luzern');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── parsePostings: successful parse ──
  describe('parsePostings — successful parse', () => {
    const richDescription = `<p>${'Bucherer offre un ambiente di lavoro unico nel settore del lusso. '.repeat(10)}</p>`;

    const buildPosting = (overrides = {}) => ({
      jobPostingId: '737',
      jobReqId: 'REQ-737',
      jobTitle: 'Sales Associate',
      jobDescription: richDescription,
      postingStartTimestampUTC: '2026-06-01T00:00:00Z',
      isEvergreen: false,
      postingLocations: [
        {
          formattedAddress: 'Langensandstrasse 27, 6005 Luzern, Switzerland',
          cityName: 'Luzern',
          stateCode: 'LU',
          stateName: 'Luzern',
          postalCode: '6005',
          addressLine1: 'Langensandstrasse 27',
          isoCountryCode: 'CH',
        },
      ],
      typeOfEmployment: { label: 'Full Time' },
      ...overrides,
    });

    it('parses a well-formed posting into a full job object', () => {
      const jobs = parsePostings([buildPosting()]);
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.id).toMatch(/^bucherer-[0-9a-f]{12}$/);
      expect(job.company).toBe('Bucherer');
      expect(job.companyKey).toBe('bucherer');
      expect(job.title).toBe('Sales Associate');
      expect(job.location).toBe('Luzern');
      expect(job.canton).toBe('LU');
      expect(job.url).toContain('737');
      expect(job.employmentType).toBe('FULL_TIME');
    });

    it('drops postings with no usable title', () => {
      const jobs = parsePostings([buildPosting({ jobTitle: '' })]);
      expect(jobs).toHaveLength(0);
    });

    it('deduplicates postings sharing the same public URL', () => {
      const jobs = parsePostings([buildPosting(), buildPosting()]);
      expect(jobs).toHaveLength(1);
    });
  });

  // ── parsePostings: empty feed ──
  describe('parsePostings — empty feed', () => {
    it('returns an empty array for an empty postings list', () => {
      expect(parsePostings([])).toEqual([]);
    });

    it('returns an empty array when called with no argument', () => {
      expect(parsePostings()).toEqual([]);
    });
  });

  // ── parsePostings: non-Swiss / foreign-office filtering ──
  describe('parsePostings — foreign office filtering', () => {
    it('drops postings whose only location is outside Switzerland', () => {
      const posting = {
        jobPostingId: '900',
        jobTitle: 'Regional Merchandiser',
        jobDescription: 'x'.repeat(400),
        postingLocations: [
          { formattedAddress: 'Maximilianstrasse 1, 80539 München, Germany', cityName: 'München', isoCountryCode: 'DE' },
        ],
      };
      expect(parsePostings([posting])).toHaveLength(0);
    });

    it('keeps a posting that has both a Swiss and a foreign location', () => {
      const posting = {
        jobPostingId: '901',
        jobTitle: 'Group Buyer',
        jobDescription: 'x'.repeat(400),
        postingLocations: [
          { formattedAddress: 'Maximilianstrasse 1, 80539 München, Germany', cityName: 'München', isoCountryCode: 'DE' },
          { formattedAddress: 'Bahnhofstrasse 1, 8001 Zürich, Switzerland', cityName: 'Zürich', stateCode: 'ZH', isoCountryCode: 'CH' },
        ],
      };
      const jobs = parsePostings([posting]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].canton).toBe('ZH');
    });

    it('keeps a posting with no location data at all (falls back to HQ)', () => {
      const posting = { jobPostingId: '902', jobTitle: 'Corporate Role', jobDescription: 'x'.repeat(400) };
      const jobs = parsePostings([posting]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].canton).toBe('LU');
    });
  });

  // ── parsePostings: canton inference across multiple store locations ──
  describe('parsePostings — canton inference', () => {
    it('infers canton from stateCode for a non-HQ store (Zürich)', () => {
      const posting = {
        jobPostingId: '910',
        jobTitle: 'Boutique Manager',
        jobDescription: 'x'.repeat(400),
        postingLocations: [
          {
            formattedAddress: 'Bahnhofstrasse 1, 8001 Zürich, Switzerland',
            cityName: 'Zürich',
            stateCode: 'ZH',
            postalCode: '8001',
            addressLine1: 'Bahnhofstrasse 1',
            isoCountryCode: 'CH',
          },
        ],
      };
      const jobs = parsePostings([posting]);
      expect(jobs[0].canton).toBe('ZH');
      expect(jobs[0].location).toBe('Zürich');
      // Non-HQ canton: HQ street/postal must NOT leak onto this job.
      expect(jobs[0].streetAddress).toBe('Bahnhofstrasse 1');
      expect(jobs[0].postalCode).toBe('8001');
    });

    it('infers canton from city name when stateCode is missing (Lugano → TI)', () => {
      const posting = {
        jobPostingId: '911',
        jobTitle: 'Sales Associate Lugano',
        jobDescription: 'x'.repeat(400),
        postingLocations: [
          { formattedAddress: 'Via Nassa 5, 6900 Lugano, Switzerland', cityName: 'Lugano', isoCountryCode: 'CH' },
        ],
      };
      const jobs = parsePostings([posting]);
      expect(jobs[0].canton).toBe('TI');
    });

    it('does not attach HQ street/postal to a job resolved to a different canton with no source address', () => {
      const posting = {
        jobPostingId: '912',
        jobTitle: 'Sales Associate Geneva',
        jobDescription: 'x'.repeat(400),
        postingLocations: [
          { cityName: 'Genève', stateCode: 'GE', isoCountryCode: 'CH' },
        ],
      };
      const jobs = parsePostings([posting]);
      expect(jobs[0].canton).toBe('GE');
      expect(jobs[0].streetAddress).toBe('');
      expect(jobs[0].postalCode).toBe('');
    });

    it('falls back to HQ address only when the resolved canton matches HQ (Luzern)', () => {
      const posting = {
        jobPostingId: '913',
        jobTitle: 'Sales Associate Luzern',
        jobDescription: 'x'.repeat(400),
        postingLocations: [
          { cityName: 'Luzern', stateCode: 'LU', isoCountryCode: 'CH' },
        ],
      };
      const jobs = parsePostings([posting]);
      expect(jobs[0].canton).toBe('LU');
      expect(jobs[0].streetAddress).toBe('Langensandstrasse 27');
      expect(jobs[0].postalCode).toBe('6005');
    });
  });

  // ── parsePostings: thin-description guard (Non-Negotiable #4) ──
  describe('parsePostings — thin-description guard', () => {
    it('keeps a crawled description with >= 50 words', () => {
      const longDescription = 'Bucherer offre un ambiente di lavoro dedicato al lusso e alla tradizione orologiera svizzera. '.repeat(10);
      const posting = {
        jobPostingId: '920',
        jobTitle: 'Watchmaker',
        jobDescription: longDescription,
        postingLocations: [{ cityName: 'Luzern', stateCode: 'LU', isoCountryCode: 'CH' }],
      };
      const jobs = parsePostings([posting]);
      expect(jobs[0].description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(50);
      expect(jobs[0].description).toContain('Bucherer offre un ambiente');
    });

    it('replaces a too-short crawled description with a rich >= 50-word fallback', () => {
      const posting = {
        jobPostingId: '921',
        jobTitle: 'Trainee Orologeria',
        jobDescription: '<p>Short desc.</p>',
        postingLocations: [{ cityName: 'Luzern', stateCode: 'LU', isoCountryCode: 'CH' }],
      };
      const jobs = parsePostings([posting]);
      const wordCount = jobs[0].description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
      expect(jobs[0].description).toContain('Trainee Orologeria');
      expect(jobs[0].description).toContain('Bucherer AG');
    });

    it('replaces a missing crawled description with a rich fallback', () => {
      const posting = {
        jobPostingId: '922',
        jobTitle: 'Store Manager',
        postingLocations: [{ cityName: 'Basel', stateCode: 'BS', isoCountryCode: 'CH' }],
      };
      const jobs = parsePostings([posting]);
      expect(jobs[0].description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(50);
    });
  });

  // ── structured-data completeness (Non-Negotiable #3) ──
  describe('parsePostings — structured-data completeness', () => {
    const posting = {
      jobPostingId: '930',
      jobReqId: 'REQ-930',
      jobTitle: 'Sales Associate',
      jobDescription: 'Bucherer sales role description text long enough to pass the guard. '.repeat(8),
      postingStartTimestampUTC: '2026-05-10T00:00:00Z',
      postingLocations: [
        {
          formattedAddress: 'Langensandstrasse 27, 6005 Luzern, Switzerland',
          cityName: 'Luzern',
          stateCode: 'LU',
          postalCode: '6005',
          addressLine1: 'Langensandstrasse 27',
          isoCountryCode: 'CH',
        },
      ],
      typeOfEmployment: { label: 'Full Time' },
    };
    const job = parsePostings([posting])[0];

    it('has all required base fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(job).toHaveProperty(field);
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
        expect(job).toHaveProperty(field);
        expect(job[field]).toBeTruthy();
      }
    });

    it('company doubles as hiringOrganization.name source', () => {
      expect(job.company).toBe('Bucherer');
    });

    it('location + canton + addressLocality double as jobLocation source', () => {
      expect(job.location).toBeTruthy();
      expect(job.canton).toBeTruthy();
      expect(job.addressLocality).toBeTruthy();
      expect(job.addressCountry).toBe('CH');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(job.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(job.sourceLang);
    });

    it('id starts with company key', () => {
      expect(job.id).toMatch(/^bucherer-/);
    });

    it('slug is URL-safe', () => {
      expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
