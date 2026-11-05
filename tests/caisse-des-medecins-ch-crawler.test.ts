import { describe, it, expect } from 'vitest';
import {
  CAISSE_DES_MEDECINS_CH_KEY,
  CAISSE_DES_MEDECINS_CH_COMPANY_NAME,
  isCaisseDesMedecinsChJob,
  isTrustedDomain,
} from '../scripts/lib/caisse-des-medecins-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Caisse des médecins crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CAISSE_DES_MEDECINS_CH_KEY).toBe('caisse-des-medecins-ch');
    expect(CAISSE_DES_MEDECINS_CH_COMPANY_NAME).toBe('Caisse des médecins');
  });

  // ── isCompanyJob ──
  describe('isCaisseDesMedecinsChJob', () => {
    it('matches by companyKey', () => {
      expect(isCaisseDesMedecinsChJob({ companyKey: 'caisse-des-medecins-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCaisseDesMedecinsChJob({ company: 'Caisse des médecins' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCaisseDesMedecinsChJob({ url: 'https://caisse-des-medecins.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCaisseDesMedecinsChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCaisseDesMedecinsChJob(null)).toBe(false);
      expect(isCaisseDesMedecinsChJob(undefined)).toBe(false);
      expect(isCaisseDesMedecinsChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://caisse-des-medecins.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.caisse-des-medecins.ch/job/456')).toBe(true);
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
      expect(slugify('Developer caisse-des-medecins-ch ch')).toBe('developer-caisse-des-medecins-ch-ch');
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
      id: 'caisse-des-medecins-ch-abc123',
      slug: 'test-position-caisse-des-medecins-ch-ch',
      slugByLocale: { fr: 'test-position-caisse-des-medecins-ch-ch' },
      company: 'Caisse des médecins',
      companyKey: 'caisse-des-medecins-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://caisse-des-medecins.ch/jobs/test',
      source: 'Caisse des médecins Dedicated Parser',
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
      expect(validJob.id).toMatch(/^caisse-des-medecins-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
