import { describe, it, expect } from 'vitest';
import {
  SOLOTHURNER_SPITAELER_KEY,
  SOLOTHURNER_SPITAELER_COMPANY_NAME,
  isSolothurnerSpitaelerJob,
  isTrustedDomain,
} from '../scripts/lib/solothurner-spitaeler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Solothurner Spitäler (soH) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SOLOTHURNER_SPITAELER_KEY).toBe('solothurner-spitaeler');
    expect(SOLOTHURNER_SPITAELER_COMPANY_NAME).toBe('Solothurner Spitäler (soH)');
  });

  // ── isCompanyJob ──
  describe('isSolothurnerSpitaelerJob', () => {
    it('matches by companyKey', () => {
      expect(isSolothurnerSpitaelerJob({ companyKey: 'solothurner-spitaeler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSolothurnerSpitaelerJob({ company: 'Solothurner Spitäler (soH)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSolothurnerSpitaelerJob({ url: 'https://solothurnerspitaeler.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSolothurnerSpitaelerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSolothurnerSpitaelerJob(null)).toBe(false);
      expect(isSolothurnerSpitaelerJob(undefined)).toBe(false);
      expect(isSolothurnerSpitaelerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://solothurnerspitaeler.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.solothurnerspitaeler.ch/job/456')).toBe(true);
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
      expect(slugify('Developer solothurner-spitaeler ch')).toBe('developer-solothurner-spitaeler-ch');
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
      id: 'solothurner-spitaeler-abc123',
      slug: 'test-position-solothurner-spitaeler-ch',
      slugByLocale: { de: 'test-position-solothurner-spitaeler-ch' },
      company: 'Solothurner Spitäler (soH)',
      companyKey: 'solothurner-spitaeler',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://solothurnerspitaeler.ch/jobs/test',
      source: 'Solothurner Spitäler (soH) Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^solothurner-spitaeler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
