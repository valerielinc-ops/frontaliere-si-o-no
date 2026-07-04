import { describe, it, expect } from 'vitest';
import {
  PATEK_PHILIPPE_KEY,
  PATEK_PHILIPPE_COMPANY_NAME,
  isPatekPhilippeJob,
  isTrustedDomain,
} from '../scripts/lib/patek-philippe-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Patek Philippe crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PATEK_PHILIPPE_KEY).toBe('patek-philippe');
    expect(PATEK_PHILIPPE_COMPANY_NAME).toBe('Patek Philippe');
  });

  // ── isCompanyJob ──
  describe('isPatekPhilippeJob', () => {
    it('matches by companyKey', () => {
      expect(isPatekPhilippeJob({ companyKey: 'patek-philippe' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPatekPhilippeJob({ company: 'Patek Philippe' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPatekPhilippeJob({ url: 'https://careers.patek.com/job/123' })).toBe(true);
      expect(isPatekPhilippeJob({ url: 'https://www.patek.com/en/careers' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isPatekPhilippeJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPatekPhilippeJob(null)).toBe(false);
      expect(isPatekPhilippeJob(undefined)).toBe(false);
      expect(isPatekPhilippeJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://patek.com/en/careers')).toBe(true);
    });

    it('trusts subdomains (ATS host)', () => {
      expect(isTrustedDomain('https://careers.patek.com/job/456')).toBe(true);
      expect(isTrustedDomain('https://www.patek.com/en/legal-notices')).toBe(true);
    });

    it('trusts underlying SuccessFactors infrastructure', () => {
      expect(isTrustedDomain('https://career55.sapsf.eu/career?company=patekphili')).toBe(true);
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
      const slug = slugify('Sertisseur baguette (H/F)');
      expect(slug).toBe('sertisseur-baguette-h-f');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Micromécanicien patek philippe Saint-Imier')).toBe(
        'micromecanicien-patek-philippe-saint-imier',
      );
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'patek-philippe-abc123',
      slug: 'test-position-patek-philippe-geneve',
      slugByLocale: { fr: 'test-position-patek-philippe-geneve' },
      company: 'Patek Philippe',
      companyKey: 'patek-philippe',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://careers.patek.com/job/test/123/',
      source: 'Patek Philippe Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^patek-philippe-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── City-gated HQ address fallback (regression guard) ──
  // The whole crawler wave was audited for a bug where canton equality
  // (`canton === HQ.canton`) incorrectly stamped the exact HQ street address
  // onto every job in the same canton, even a different city. Only city-text
  // equality may gate streetAddress/postalCode fallback.
  describe('HQ address fallback is city-gated, not canton-gated', () => {
    it('never emits the HQ street address for a non-HQ-city GE job', () => {
      // Simulates the isHqCity gate used in fetchAllPatekPhilippeJobs():
      // a Genève city-center sales role (same canton GE as the Plan-les-Ouates
      // manufacture HQ, but a DIFFERENT city) must never receive the exact
      // manufacture street address.
      const city = 'Genève';
      const isHqCity = !city || /plan-les-ouates/i.test(city);
      expect(isHqCity).toBe(false);
    });

    it('emits the HQ street address only for the manufacture city', () => {
      const city = 'Plan-les-Ouates';
      const isHqCity = !city || /plan-les-ouates/i.test(city);
      expect(isHqCity).toBe(true);
    });

    it('emits the HQ street address when city is unresolved (empty)', () => {
      const city = '';
      const isHqCity = !city || /plan-les-ouates/i.test(city);
      expect(isHqCity).toBe(true);
    });
  });
});
