import { describe, it, expect } from 'vitest';
import {
  FAVRESA_CH_KEY,
  FAVRESA_CH_COMPANY_NAME,
  isFavresaChJob,
  isTrustedDomain,
} from '../scripts/lib/favresa-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Favre SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FAVRESA_CH_KEY).toBe('favresa-ch');
    expect(FAVRESA_CH_COMPANY_NAME).toBe('Favre SA');
  });

  // ── isCompanyJob ──
  describe('isFavresaChJob', () => {
    it('matches by companyKey', () => {
      expect(isFavresaChJob({ companyKey: 'favresa-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFavresaChJob({ company: 'Favre SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFavresaChJob({ url: 'https://groupe-r.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFavresaChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFavresaChJob(null)).toBe(false);
      expect(isFavresaChJob(undefined)).toBe(false);
      expect(isFavresaChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://groupe-r.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.groupe-r.ch/job/456')).toBe(true);
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
      expect(slugify('Developer favresa-ch ch')).toBe('developer-favresa-ch-ch');
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
      id: 'favresa-ch-abc123',
      slug: 'test-position-favresa-ch-ch',
      slugByLocale: { fr: 'test-position-favresa-ch-ch' },
      company: 'Favre SA',
      companyKey: 'favresa-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://groupe-r.ch/jobs/test',
      source: 'Favre SA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^favresa-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
