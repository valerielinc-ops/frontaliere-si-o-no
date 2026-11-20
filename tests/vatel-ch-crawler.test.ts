import { describe, it, expect } from 'vitest';
import {
  VATEL_CH_KEY,
  VATEL_CH_COMPANY_NAME,
  isVatelChJob,
  isTrustedDomain,
} from '../scripts/lib/vatel-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Restaurant & Hôtel Vatel crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VATEL_CH_KEY).toBe('vatel-ch');
    expect(VATEL_CH_COMPANY_NAME).toBe('Restaurant & Hôtel Vatel');
  });

  // ── isCompanyJob ──
  describe('isVatelChJob', () => {
    it('matches by companyKey', () => {
      expect(isVatelChJob({ companyKey: 'vatel-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVatelChJob({ company: 'Restaurant & Hôtel Vatel' })).toBe(true);
    });

    it('requires an exact normalized company identity', () => {
      expect(isVatelChJob({ company: 'restaurant & hotel vatel', url: 'https://jobs.example/1' })).toBe(true);
      expect(isVatelChJob({ company: 'Not Restaurant & Hôtel Vatel', url: 'https://jobs.example/1' })).toBe(false);
      expect(isVatelChJob({ company: 'Restaurant & Hôtel Vatel Hospitality', url: 'https://jobs.example/1' })).toBe(false);
      expect(isVatelChJob({ companyKey: 'vatel-ch-unrelated', url: 'https://jobs.example/1' })).toBe(false);
    });

    it('matches by URL domain', () => {
      expect(isVatelChJob({ url: 'https://vatel.ch/jobs/123' })).toBe(true);
    });

    it('rejects URL lookalikes outside the trusted domain', () => {
      expect(isVatelChJob({ url: 'https://notvatel.ch/jobs/1' })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isVatelChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVatelChJob(null)).toBe(false);
      expect(isVatelChJob(undefined)).toBe(false);
      expect(isVatelChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vatel.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vatel.ch/job/456')).toBe(true);
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
      expect(slugify('Developer vatel-ch ch')).toBe('developer-vatel-ch-ch');
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
      id: 'vatel-ch-abc123',
      slug: 'test-position-vatel-ch-ch',
      slugByLocale: { en: 'test-position-vatel-ch-ch' },
      company: 'Restaurant & Hôtel Vatel',
      companyKey: 'vatel-ch',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vatel.ch/jobs/test',
      source: 'Restaurant & Hôtel Vatel Dedicated Parser',
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
      expect(validJob.id).toMatch(/^vatel-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
