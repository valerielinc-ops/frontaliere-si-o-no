import { describe, it, expect } from 'vitest';
import {
  OMEGA_KEY,
  OMEGA_COMPANY_NAME,
  isOmegaJob,
  isTrustedDomain,
} from '../scripts/lib/omega-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('OMEGA SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OMEGA_KEY).toBe('omega');
    expect(OMEGA_COMPANY_NAME).toBe('OMEGA SA');
  });

  // ── isCompanyJob ──
  describe('isOmegaJob', () => {
    it('matches by companyKey', () => {
      expect(isOmegaJob({ companyKey: 'omega' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOmegaJob({ company: 'OMEGA SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOmegaJob({ url: 'https://www.omegawatches.com/careers/view/258050/de' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOmegaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOmegaJob(null)).toBe(false);
      expect(isOmegaJob(undefined)).toBe(false);
      expect(isOmegaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://omegawatches.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://www.omegawatches.com/careers/view/258050/de')).toBe(true);
    });

    it('trusts Lumesse TalentLink apply URLs', () => {
      expect(isTrustedDomain('https://apply5.lumessetalentlink.com/apply-app/pages/application-form?jobId=123')).toBe(true);
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
      expect(slugify('Developer omega ch')).toBe('developer-omega-ch');
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
      id: 'omega-abc123',
      slug: 'test-position-omega-ch',
      slugByLocale: { en: 'test-position-omega-ch' },
      company: 'OMEGA SA',
      companyKey: 'omega',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://omegawatches.com/jobs/test',
      source: 'OMEGA SA Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^omega-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
