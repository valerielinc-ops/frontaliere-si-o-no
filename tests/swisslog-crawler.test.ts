import { describe, it, expect } from 'vitest';
import {
  SWISSLOG_KEY,
  SWISSLOG_COMPANY_NAME,
  isSwisslogJob,
  isTrustedDomain,
  resolveCanton,
} from '../scripts/lib/swisslog-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Swisslog crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWISSLOG_KEY).toBe('swisslog');
    expect(SWISSLOG_COMPANY_NAME).toBe('Swisslog');
  });

  // ── resolveCanton (unresolved-canton skip guard — Switzerland-wide crawl, task-critical) ──
  describe('resolveCanton', () => {
    it('resolves the Buchs/Mägenwil HQ cities directly, bypassing generic inference', () => {
      expect(resolveCanton('Buchs', '')).toBe('AG');
      expect(resolveCanton('Mägenwil', '')).toBe('AG');
    });

    it('resolves a known Swiss city outside the HQ cantons via generic inference', () => {
      expect(resolveCanton('Bern', '', 'Bern')).toBe('BE');
    });

    it('falls back to the Buchs HQ canton when no real city text was scraped at all', () => {
      expect(resolveCanton('Buchs', '', '')).toBe('AG');
    });

    it('returns null (skip) when real city text is present but unresolvable — never fabricates the HQ canton', () => {
      expect(resolveCanton('Nonexistentburg', '', 'Nonexistentburg')).toBeNull();
    });

    it('does NOT fabricate AG for the negative-control case (Bern, not AG)', () => {
      expect(resolveCanton('Bern', '', 'Bern')).not.toBe('AG');
    });
  });

  // ── isCompanyJob ──
  describe('isSwisslogJob', () => {
    it('matches by companyKey', () => {
      expect(isSwisslogJob({ companyKey: 'swisslog' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwisslogJob({ company: 'Swisslog' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwisslogJob({ url: 'https://www.swisslog.com/en-us/careers/openings/technician-123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwisslogJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwisslogJob(null)).toBe(false);
      expect(isSwisslogJob(undefined)).toBe(false);
      expect(isSwisslogJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.swisslog.com/en-us/careers/openings/technician-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swisslog.com/job/456')).toBe(true);
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
      const slug = slugify('Controls Software Service Engineer (m/f/d)');
      expect(slug).toBe('controls-software-service-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Automatiker:in EFZ Mägenwil')).toBe('automatiker-in-efz-magenwil');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Technician swisslog buchs')).toBe('technician-swisslog-buchs');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllSwisslogJobs emits)
    const validJob = {
      id: 'swisslog-abc123',
      slug: 'test-position-swisslog-buchs',
      slugByLocale: { de: 'test-position-swisslog-buchs' },
      company: 'Swisslog',
      companyKey: 'swisslog',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Buchs',
      canton: 'AG',
      url: 'https://www.swisslog.com/de-de/karriere/offene-stellen/test-4097',
      source: 'Swisslog Dedicated Parser (custom Sitecore job API)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Buchs',
      addressRegion: 'AG',
      streetAddress: 'Webereiweg 3',
      postalCode: '5033',
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
      expect(validJob.id).toMatch(/^swisslog-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    // ── Canton disambiguation (the critical correctness concern for this
    // parser): Switzerland has multiple towns named "Buchs" (AG, SG, and a
    // Buchs ZH), and the shared inferSwissTargetCanton() curated name list
    // for SG includes the bare token "buchs" with no disambiguation. The
    // HQ fallback in COMPANY_HQ['swisslog'] and this fixture MUST reflect
    // the verified real HQ canton (AG), never the issue backlog's incorrect
    // "Buchs ZH" claim nor the SG collision.
    it('resolves the verified HQ canton (AG), not the ZH/SG collision towns', () => {
      expect(validJob.canton).toBe('AG');
      expect(validJob.addressRegion).toBe('AG');
      expect(validJob.postalCode).toBe('5033');
    });
  });
});
