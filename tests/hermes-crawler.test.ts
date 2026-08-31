import { describe, it, expect } from 'vitest';
import {
  HERMES_KEY,
  HERMES_COMPANY_NAME,
  hermesAddressFields,
  isHermesJob,
  isTrustedDomain,
} from '../scripts/lib/hermes-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hermès crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HERMES_KEY).toBe('hermes');
    expect(HERMES_COMPANY_NAME).toBe('Hermès');
  });

  it('uses postal code 1204 only for the exact Genève HQ locality', () => {
    expect(hermesAddressFields('Genève, GE', 'GE')).toMatchObject({
      addressLocality: 'Genève', postalCode: '1204', addressRegion: 'Genève',
    });
    expect(hermesAddressFields('Meyrin, GE', 'GE')).toMatchObject({
      addressLocality: 'Meyrin', postalCode: undefined, addressRegion: 'GE',
    });
    expect(hermesAddressFields('Genève, VD', 'VD').postalCode).toBeUndefined();
  });

  // ── isCompanyJob ──
  describe('isHermesJob', () => {
    it('matches by companyKey', () => {
      expect(isHermesJob({ companyKey: 'hermes' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHermesJob({ company: 'Hermès' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHermesJob({ url: 'https://hermes.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHermesJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    // Collision guard: 'thermo-fisher-scientific' and 'bosch-thermotechnik-ag'
    // both contain the bare substring 'herm' (t-HERM-o / thermo-tecHnik) — if
    // isHermesJob ever regresses to a naive 'herm' substring check instead of
    // exact key/'hermès'/'hermes.com' matching, these two crawlers would
    // false-positive as Hermès jobs.
    it('does not fuzzy-match Thermo Fisher Scientific (substring "herm" in "thermo")', () => {
      expect(
        isHermesJob({
          companyKey: 'thermo-fisher-scientific',
          company: 'Thermo Fisher Scientific',
          url: 'https://jobs.thermofisher.com/global/en/job/123',
        })
      ).toBe(false);
    });

    it('does not fuzzy-match Bosch Thermotechnik AG (substring "herm" in "thermotechnik")', () => {
      expect(
        isHermesJob({
          companyKey: 'bosch-thermotechnik-ag',
          company: 'Bosch Thermotechnik AG',
          url: 'https://www.bosch.com/careers/job/456',
        })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHermesJob(null)).toBe(false);
      expect(isHermesJob(undefined)).toBe(false);
      expect(isHermesJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hermes.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hermes.com/job/456')).toBe(true);
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
      expect(slugify('Developer hermes ch')).toBe('developer-hermes-ch');
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
      id: 'hermes-abc123',
      slug: 'test-position-hermes-ch',
      slugByLocale: { fr: 'test-position-hermes-ch' },
      company: 'Hermès',
      companyKey: 'hermes',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hermes.com/jobs/test',
      source: 'Hermès Dedicated Parser',
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
      expect(validJob.id).toMatch(/^hermes-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
