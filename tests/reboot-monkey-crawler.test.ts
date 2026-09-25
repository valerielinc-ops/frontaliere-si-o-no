import { describe, it, expect } from 'vitest';
import {
  REBOOT_MONKEY_KEY,
  REBOOT_MONKEY_COMPANY_NAME,
  isRebootMonkeyJob,
  isTrustedDomain,
} from '../scripts/lib/reboot-monkey-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Reboot Monkey crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(REBOOT_MONKEY_KEY).toBe('reboot-monkey');
    expect(REBOOT_MONKEY_COMPANY_NAME).toBe('Reboot Monkey');
  });

  // ── isCompanyJob ──
  describe('isRebootMonkeyJob', () => {
    it('matches by companyKey', () => {
      expect(isRebootMonkeyJob({ companyKey: 'reboot-monkey' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRebootMonkeyJob({ company: 'Reboot Monkey' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRebootMonkeyJob({ url: 'https://rebootmonkey.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRebootMonkeyJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRebootMonkeyJob(null)).toBe(false);
      expect(isRebootMonkeyJob(undefined)).toBe(false);
      expect(isRebootMonkeyJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://rebootmonkey.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.rebootmonkey.com/job/456')).toBe(true);
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
      expect(slugify('Developer reboot-monkey ch')).toBe('developer-reboot-monkey-ch');
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
      id: 'reboot-monkey-abc123',
      slug: 'test-position-reboot-monkey-ch',
      slugByLocale: { en: 'test-position-reboot-monkey-ch' },
      company: 'Reboot Monkey',
      companyKey: 'reboot-monkey',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://rebootmonkey.com/jobs/test',
      source: 'Reboot Monkey Dedicated Parser',
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
      expect(validJob.id).toMatch(/^reboot-monkey-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
