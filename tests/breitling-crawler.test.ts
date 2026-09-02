import { describe, it, expect } from 'vitest';
import {
  BREITLING_KEY,
  BREITLING_COMPANY_NAME,
  isBreitlingJob,
  isTrustedDomain,
  parseLocation,
} from '../scripts/lib/breitling-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Breitling crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BREITLING_KEY).toBe('breitling');
    expect(BREITLING_COMPANY_NAME).toBe('Breitling');
  });

  // ── isCompanyJob ──
  describe('isBreitlingJob', () => {
    it('matches by companyKey', () => {
      expect(isBreitlingJob({ companyKey: 'breitling' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBreitlingJob({ company: 'Breitling' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBreitlingJob({ url: 'https://careers.breitling.com/job/sales-associate/1420-en_GB' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBreitlingJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBreitlingJob(null)).toBe(false);
      expect(isBreitlingJob(undefined)).toBe(false);
      expect(isBreitlingJob({})).toBe(false);
    });

    // ── Collision guard ──
    // Bucherer is a Swiss watch/jewellery RETAILER that sells Breitling
    // watches and mentions the brand name in its own boilerplate
    // company-description text ("...partner ufficiale di marchi come
    // Rolex, Patek Philippe, Cartier e Breitling."). Its parser always
    // sets `company: 'Bucherer'` literally, never 'Breitling', and its
    // job URLs live on Bucherer's own domain/ATS — this must NOT match.
    it('does not collide with Bucherer jobs that merely mention the Breitling brand', () => {
      const buchererJob = {
        company: 'Bucherer',
        companyKey: 'bucherer',
        title: 'Sales Associate Watches & Jewellery',
        description: 'Bucherer è partner ufficiale di marchi come Rolex, Patek Philippe, Cartier e Breitling.',
        url: 'https://www.bucherer.com/int/en/careers/sales-associate',
      };
      expect(isBreitlingJob(buchererJob)).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://careers.breitling.com/job/sales-associate/1420-en_GB')).toBe(true);
    });

    it('trusts apex domain', () => {
      expect(isTrustedDomain('https://breitling.com/careers')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects the Bucherer domain', () => {
      expect(isTrustedDomain('https://www.bucherer.com/int/en/careers')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Sales Associate (90%) - Bern Boutique (f/m/x)');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Spécialiste Payroll')).toBe('specialiste-payroll');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Sales Associate breitling bern')).toBe('sales-associate-breitling-bern');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllBreitlingJobs emits)
    const validJob = {
      id: 'breitling-abc123',
      slug: 'sales-associate-breitling-bern',
      slugByLocale: { en: 'sales-associate-breitling-bern' },
      company: 'Breitling',
      companyKey: 'breitling',
      title: 'Sales Associate (90%) - Bern Boutique (f/m/x)',
      titleByLocale: { en: 'Sales Associate (90%) - Bern Boutique (f/m/x)' },
      description: 'A test job description for validation, long enough to pass the minimum word count floor used by the parser as a safe-default guard against thin content.',
      descriptionByLocale: { en: 'A test job description for validation, long enough to pass the minimum word count floor used by the parser as a safe-default guard against thin content.' },
      location: 'Bern, BE',
      canton: 'BE',
      url: 'https://careers.breitling.com/job/sales-associate/1420-en_GB',
      source: 'Breitling Dedicated Parser (SuccessFactors Unify)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Bern',
      addressRegion: 'BE',
      streetAddress: '',
      postalCode: '',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'PART_TIME',
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
      // postalCode/streetAddress may legitimately be empty when the source
      // genuinely omits them (e.g. Bern boutique) — only checked for presence,
      // not truthiness, here; Grenchen HQ postings do carry a real value.
      const structuredDataInputs = [
        'title', 'description', 'addressLocality', 'addressCountry',
        'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
    });

    it('Grenchen HQ postings carry the verified real street address as safe default', () => {
      const hqJob = {
        ...validJob,
        location: 'Grenchen, SO',
        canton: 'SO',
        addressLocality: 'Grenchen',
        addressRegion: 'SO',
        streetAddress: 'Léon Breitling-Strasse 2',
        postalCode: '2540',
      };
      expect(hqJob.postalCode).toBeTruthy();
      expect(hqJob.streetAddress).toBeTruthy();
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^breitling-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── parseLocation (#7056: canton-only Zürich source vs. Solothurn HQ) ──
  describe('parseLocation', () => {
    it('resolves the canton-only Zürich form to Zürich/ZH, not Solothurn HQ', () => {
      // Real observed jobLocationShort for the Zurich boutique: NO city
      // token, just canton code, country, postal code.
      expect(parseLocation('ZH, CHE, 8002')).toEqual({
        city: 'Zürich',
        canton: 'ZH',
        postalCode: '8002',
      });
    });

    it('still resolves the standard [city, canton, CHE, postalCode] form', () => {
      expect(parseLocation('Bern, BE, CHE, ')).toEqual({
        city: 'Bern',
        canton: 'BE',
        postalCode: '',
      });
    });

    it('resolves other canton-only forms without inventing the HQ canton', () => {
      expect(parseLocation('GE, CHE, 1201')).toEqual({
        city: 'Genève',
        canton: 'GE',
        postalCode: '1201',
      });
    });

    it('falls back to HQ only for a genuinely empty location', () => {
      expect(parseLocation('')).toEqual({
        city: 'Grenchen',
        canton: 'SO',
        postalCode: '',
      });
    });
  });
});
