import { describe, it, expect } from 'vitest';
import {
  POLICELAVAUX_CH_KEY,
  POLICELAVAUX_CH_COMPANY_NAME,
  isPolicelavauxChJob,
  isTrustedDomain,
} from '../scripts/lib/policelavaux-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Police Lavaux crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(POLICELAVAUX_CH_KEY).toBe('policelavaux-ch');
    expect(POLICELAVAUX_CH_COMPANY_NAME).toBe('Police Lavaux');
  });

  // ── isCompanyJob ──
  describe('isPolicelavauxChJob', () => {
    it('matches by companyKey', () => {
      expect(isPolicelavauxChJob({ companyKey: 'policelavaux-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPolicelavauxChJob({ company: 'Police Lavaux' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPolicelavauxChJob({ url: 'https://policelavaux.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPolicelavauxChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPolicelavauxChJob(null)).toBe(false);
      expect(isPolicelavauxChJob(undefined)).toBe(false);
      expect(isPolicelavauxChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://policelavaux.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.policelavaux.ch/job/456')).toBe(true);
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
      expect(slugify('Developer policelavaux-ch ch')).toBe('developer-policelavaux-ch-ch');
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
      id: 'policelavaux-ch-abc123',
      slug: 'test-position-policelavaux-ch-ch',
      slugByLocale: { fr: 'test-position-policelavaux-ch-ch' },
      company: 'Police Lavaux',
      companyKey: 'policelavaux-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://policelavaux.ch/jobs/test',
      source: 'Police Lavaux Dedicated Parser',
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
      expect(validJob.id).toMatch(/^policelavaux-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
