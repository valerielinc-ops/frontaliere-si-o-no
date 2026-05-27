import { describe, it, expect } from 'vitest';
import {
  BCVS_KEY,
  BCVS_COMPANY_NAME,
  isBcvsJob,
  isTrustedDomain,
} from '../scripts/lib/bcvs-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Banque Cantonale du Valais crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BCVS_KEY).toBe('bcvs');
    expect(BCVS_COMPANY_NAME).toBe('Banque Cantonale du Valais');
  });

  // ── isCompanyJob ──
  describe('isBcvsJob', () => {
    it('matches by companyKey', () => {
      expect(isBcvsJob({ companyKey: 'bcvs' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBcvsJob({ company: 'Banque Cantonale du Valais' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBcvsJob({ url: 'https://bcvs.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBcvsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBcvsJob(null)).toBe(false);
      expect(isBcvsJob(undefined)).toBe(false);
      expect(isBcvsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bcvs.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bcvs.ch/job/456')).toBe(true);
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
      expect(slugify('Developer bcvs ch')).toBe('developer-bcvs-ch');
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
      id: 'bcvs-abc123',
      slug: 'test-position-bcvs-ch',
      slugByLocale: { fr: 'test-position-bcvs-ch' },
      company: 'Banque Cantonale du Valais',
      companyKey: 'bcvs',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bcvs.ch/jobs/test',
      source: 'Banque Cantonale du Valais Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bcvs-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
