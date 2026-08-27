import { describe, it, expect } from 'vitest';
import {
  KZU_RECRUITING_KEY,
  KZU_RECRUITING_COMPANY_NAME,
  isKzuRecruitingJob,
  isTrustedDomain,
} from '../scripts/lib/kzu-recruiting-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('KZU Recruiting crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KZU_RECRUITING_KEY).toBe('kzu-recruiting');
    expect(KZU_RECRUITING_COMPANY_NAME).toBe('KZU Recruiting');
  });

  // ── isCompanyJob ──
  describe('isKzuRecruitingJob', () => {
    it('matches by companyKey', () => {
      expect(isKzuRecruitingJob({ companyKey: 'kzu-recruiting' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKzuRecruitingJob({ company: 'KZU Recruiting' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKzuRecruitingJob({ url: 'https://recruitingapp-1251.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKzuRecruitingJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKzuRecruitingJob(null)).toBe(false);
      expect(isKzuRecruitingJob(undefined)).toBe(false);
      expect(isKzuRecruitingJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-1251.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-1251.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer kzu-recruiting ch')).toBe('developer-kzu-recruiting-ch');
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
      id: 'kzu-recruiting-abc123',
      slug: 'test-position-kzu-recruiting-ch',
      slugByLocale: { de: 'test-position-kzu-recruiting-ch' },
      company: 'KZU Recruiting',
      companyKey: 'kzu-recruiting',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-1251.umantis.com/jobs/test',
      source: 'KZU Recruiting Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kzu-recruiting-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
