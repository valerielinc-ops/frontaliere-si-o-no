import { describe, it, expect } from 'vitest';
import {
  CH_KEY,
  CH_COMPANY_NAME,
  isChJob,
  isTrustedDomain,
} from '../scripts/lib/ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Global Sana crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CH_KEY).toBe('ch');
    expect(CH_COMPANY_NAME).toBe('Global Sana');
  });

  // ── isCompanyJob ──
  describe('isChJob', () => {
    it('matches by companyKey', () => {
      expect(isChJob({ companyKey: 'ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChJob({ company: 'Global Sana' })).toBe(true);
    });

    it('matches the verified Global Sana source URL without an explicit identity', () => {
      expect(isChJob({ url: 'https://ch.talent.com/view?id=554547064889945322' })).toBe(true);
    });

    it('does not claim another employer on the shared Talent.com host', () => {
      expect(isChJob({
        companyKey: 'other',
        company: 'Other employer',
        url: 'https://ch.talent.com/view?id=other',
      })).toBe(false);
      expect(isChJob({ url: 'https://ch.talent.com/view?id=other' })).toBe(false);
      expect(isChJob({ url: 'https://ch.talent.com/jobs/123' })).toBe(false);
    });

    it('does not let a verified URL override a conflicting company identity', () => {
      expect(isChJob({
        companyKey: 'other',
        company: 'Other employer',
        url: 'https://ch.talent.com/view?id=554547064889945322',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChJob(null)).toBe(false);
      expect(isChJob(undefined)).toBe(false);
      expect(isChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ch.talent.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ch.talent.com/job/456')).toBe(true);
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
      expect(slugify('Developer ch ch')).toBe('developer-ch-ch');
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
      id: 'ch-abc123',
      slug: 'test-position-ch-ch',
      slugByLocale: { de: 'test-position-ch-ch' },
      company: 'Global Sana',
      companyKey: 'ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ch.talent.com/jobs/test',
      source: 'Global Sana Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
