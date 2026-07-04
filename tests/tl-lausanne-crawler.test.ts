import { describe, it, expect } from 'vitest';
import {
  TL_LAUSANNE_KEY,
  TL_LAUSANNE_COMPANY_NAME,
  TL_LAUSANNE_COMPANY_DOMAIN,
  isTlLausanneJob,
  isTrustedDomain,
} from '../scripts/lib/tl-lausanne-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('tl (Lausanne) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(TL_LAUSANNE_KEY).toBe('tl-lausanne');
    expect(TL_LAUSANNE_COMPANY_NAME).toContain('Transports publics de la région lausannoise');
    expect(TL_LAUSANNE_COMPANY_DOMAIN).toBe('t-l.ch');
  });

  // ── isCompanyJob ──
  describe('isTlLausanneJob', () => {
    it('matches by companyKey', () => {
      expect(isTlLausanneJob({ companyKey: 'tl-lausanne' })).toBe(true);
    });

    it('matches by full company name', () => {
      expect(isTlLausanneJob({ company: TL_LAUSANNE_COMPANY_NAME })).toBe(true);
    });

    it('matches by exact short brand "tl"', () => {
      expect(isTlLausanneJob({ company: 'tl' })).toBe(true);
    });

    it('matches by corporate domain URL', () => {
      expect(isTlLausanneJob({ url: 'https://www.t-l.ch/carrieres/job-123' })).toBe(true);
    });

    it('matches by career (RMK) subdomain URL', () => {
      expect(isTlLausanneJob({ url: 'https://carrieres.t-l.ch/job/Conductrice/123456/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isTlLausanneJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTlLausanneJob(null)).toBe(false);
      expect(isTlLausanneJob(undefined)).toBe(false);
      expect(isTlLausanneJob({})).toBe(false);
    });

    // ── Collision guard ──────────────────────────────────────────────
    // "tl" is a very common 2-letter substring. The shared SuccessFactors
    // CSB factory (successfactors-shared-job-parser-common.mjs) derives a
    // fuzzy brand token from companyDomain ('t-l.ch' -> 't-l' -> 't l')
    // and matches via company.includes(brandSpaced) — that would
    // misclassify any employer whose normalized name contains "t l" as a
    // substring. isTlLausanneJob deliberately does NOT reuse that fuzzy
    // matcher (exact key / exact name / explicit domain only), so these
    // real sibling companies must never be claimed as tl (Lausanne) jobs.
    it('does NOT match Volksschule Stadt Luzern (name normalizes to "volksschule stadt luzern", which contains the substring "t l")', () => {
      expect(
        isTlLausanneJob({
          companyKey: 'volksschule-luzern',
          company: 'Volksschule Stadt Luzern',
          url: 'https://www.stadtluzern.ch/jobs/lehrperson-123',
        }),
      ).toBe(false);
    });

    it('does NOT match Nestlé (name contains the bare substring "tl": "Nes-tl-é")', () => {
      expect(
        isTlLausanneJob({ companyKey: 'nestle', company: 'Nestlé', url: 'https://www.nestle.com/jobs/123' }),
      ).toBe(false);
    });

    it('does NOT match a URL that merely contains "tl" as a path/host substring', () => {
      expect(isTlLausanneJob({ url: 'https://jobs.example-hotl.ch/tl/123' })).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://www.t-l.ch/carrieres')).toBe(true);
      expect(isTrustedDomain('https://t-l.ch/carrieres')).toBe(true);
    });

    it('trusts the RMK career subdomain', () => {
      expect(isTrustedDomain('https://carrieres.t-l.ch/job/Conductrice/123456/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects a lookalike domain containing "t-l" as a substring elsewhere', () => {
      expect(isTrustedDomain('https://www.stadtluzern.ch/jobs')).toBe(false);
      expect(isTrustedDomain('https://www.nestle.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Conductrices et conducteurs de bus et trolleybus');
      expect(slug).toBe('conductrices-et-conducteurs-de-bus-et-trolleybus');
    });

    it('strips diacritics', () => {
      expect(slugify('Agent·e de terrain')).toMatch(/^[a-z0-9-]+$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Conducteur tl lausanne ch')).toBe('conducteur-tl-lausanne-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'tl-lausanne-abc123',
      slug: 'test-position-tl-lausanne-ch',
      slugByLocale: { fr: 'test-position-tl-lausanne-ch' },
      company: TL_LAUSANNE_COMPANY_NAME,
      companyKey: 'tl-lausanne',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lausanne',
      canton: 'VD',
      url: 'https://carrieres.t-l.ch/job/test/123456/',
      source: 'tl (Transports publics de la région lausannoise) Dedicated Parser',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      postalCode: '1020',
      streetAddress: 'Chemin du Closel 15-17',
      employmentType: 'FULL_TIME',
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

    it('includes the job-page structured-data fields (postalCode/streetAddress/employmentType)', () => {
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob).toHaveProperty('employmentType');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^tl-lausanne-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
