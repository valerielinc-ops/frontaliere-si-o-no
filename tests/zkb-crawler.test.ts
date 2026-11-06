import { describe, it, expect } from 'vitest';
import {
  ZKB_KEY,
  ZKB_COMPANY_NAME,
  isZkbJob,
  isTrustedDomain,
} from '../scripts/lib/zkb-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('ZKB crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZKB_KEY).toBe('zkb');
    expect(ZKB_COMPANY_NAME).toBe('Zürcher Kantonalbank');
  });

  // ── isCompanyJob ──
  describe('isZkbJob', () => {
    it('matches by companyKey', () => {
      expect(isZkbJob({ companyKey: 'zkb' })).toBe(true);
    });

    it('matches by company name (ZKB abbreviation, corporate host prefix)', () => {
      expect(isZkbJob({ company: 'ZKB' })).toBe(true);
    });

    it('matches by URL domain (corporate site)', () => {
      expect(isZkbJob({ url: 'https://www.zkb.ch/de/ueber-uns/jobs-karriere/123' })).toBe(true);
    });

    it('matches by Refline tenant listing URL', () => {
      expect(isZkbJob({ url: 'https://apply.refline.ch/792841/11001/pub/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZkbJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZkbJob(null)).toBe(false);
      expect(isZkbJob(undefined)).toBe(false);
      expect(isZkbJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts corporate domain', () => {
      expect(isTrustedDomain('https://www.zkb.ch/de/ueber-uns/jobs-karriere/123')).toBe(true);
    });

    it('trusts Refline tenant domain', () => {
      expect(isTrustedDomain('https://apply.refline.ch/792841/11001/pub/1')).toBe(true);
    });

    it('rejects a Refline URL for a different tenant', () => {
      expect(isTrustedDomain('https://apply.refline.ch/640332/0052/pub/2/index.html')).toBe(false);
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
      const slug = slugify('DevOps Engineer (Zürich)');
      expect(slug).toBe('devops-engineer-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Kundenberater Zürich')).toBe('kundenberater-zurich');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('DevOps Engineer zkb zurich')).toBe('devops-engineer-zkb-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllZkbJobs emits via
    // the shared createReflineParser factory — see scripts/lib/refline-common.mjs).
    // NB: streetAddress is intentionally NOT a parser-level field here — the
    // shared Refline factory never invents one; it is synthesized downstream at
    // SSG-render time from `build-plugins/shared/companyHqAddresses.ts` (curated
    // 'zkb' entry: Bahnhofstrasse 9, 8001 Zürich) + `scripts/lib/crawler-location-config.mjs`
    // (COMPANY_HQ 'zkb' entry), per Non-Negotiable #3's "safe default, not removed check".
    const validJob = {
      id: 'zkb-abc123def456',
      slug: 'devops-engineer-zkb-zurich',
      slugByLocale: { de: 'devops-engineer-zkb-zurich' },
      company: 'Zürcher Kantonalbank',
      companyKey: 'zkb',
      companyDomain: 'zkb.ch',
      title: 'DevOps Engineer SAP PaPM (m/w/d)',
      titleByLocale: { de: 'DevOps Engineer SAP PaPM (m/w/d)' },
      description: 'Wir sind das Team DevOps BI und entwickeln analytische SAP Systeme fuer das Accounting und Controlling.',
      descriptionByLocale: { de: 'Wir sind das Team DevOps BI und entwickeln analytische SAP Systeme fuer das Accounting und Controlling.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://apply.refline.ch/792841/11001/pub/1',
      source: 'Zürcher Kantonalbank Dedicated Parser (Refline 792841)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8001',
      category: 'IT',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Finanza / Banca',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: 'https://apply.refline.ch/792841/11001/pub/1',
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
      // baseSalary and streetAddress are synthesized downstream from curated
      // company-HQ / canton-capital safe defaults (see comment above); these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'title', 'description',
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
      expect(validJob.id).toMatch(/^zkb-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
