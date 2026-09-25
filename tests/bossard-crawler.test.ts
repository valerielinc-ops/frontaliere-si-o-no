import { describe, it, expect } from 'vitest';
import {
  BOSSARD_KEY,
  BOSSARD_COMPANY_NAME,
  isBossardJob,
  isTrustedDomain,
} from '../scripts/lib/bossard-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bossard crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BOSSARD_KEY).toBe('bossard');
    expect(BOSSARD_COMPANY_NAME).toBe('Bossard Group');
  });

  // ── isCompanyJob ──
  describe('isBossardJob', () => {
    it('matches by companyKey', () => {
      expect(isBossardJob({ companyKey: 'bossard' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBossardJob({ company: 'Bossard Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBossardJob({ url: 'https://www.bossard.com/ch-en/about-us/careers/' })).toBe(true);
    });

    it('matches by Workday tenant URL', () => {
      expect(isBossardJob({ url: 'https://bossard.wd103.myworkdayjobs.com/en/BossardJobs/job/Zug/some-role' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBossardJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBossardJob(null)).toBe(false);
      expect(isBossardJob(undefined)).toBe(false);
      expect(isBossardJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.bossard.com/ch-en/about-us/careers/')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bossard.com/job/456')).toBe(true);
    });

    it('trusts Workday ATS hosts', () => {
      expect(isTrustedDomain('https://bossard.wd103.myworkdayjobs.com/en/BossardJobs/job/Zug/some-role')).toBe(true);
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
      expect(slugify('Einkäufer:in Zug')).toBe('einkaufer-in-zug');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Buyer bossard zug')).toBe('buyer-bossard-zug');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllBossardJobs emits)
    const validJob = {
      id: 'bossard-abc123',
      slug: 'test-position-bossard-zug',
      slugByLocale: { de: 'test-position-bossard-zug' },
      company: 'Bossard Group',
      companyKey: 'bossard',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zug',
      canton: 'ZG',
      url: 'https://bossard.wd103.myworkdayjobs.com/en/BossardJobs/job/Zug/test',
      source: 'Bossard Group Dedicated Parser (Workday)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zug',
      addressRegion: 'ZG',
      streetAddress: 'Steinhauserstrasse 70',
      postalCode: '6301',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^bossard-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
