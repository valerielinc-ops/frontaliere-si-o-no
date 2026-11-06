import { describe, it, expect } from 'vitest';
import {
  TALAN_KEY,
  TALAN_COMPANY_NAME,
  isTalanJob,
  isTrustedDomain,
} from '../scripts/lib/talan-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Talan crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TALAN_KEY).toBe('talan');
    expect(TALAN_COMPANY_NAME).toBe('Talan');
  });

  // ── isCompanyJob ──
  describe('isTalanJob', () => {
    it('matches by companyKey', () => {
      expect(isTalanJob({ companyKey: 'talan' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTalanJob({ company: 'Talan' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isTalanJob({ url: 'https://talan.com/jobs/123' })).toBe(true);
    });

    it('matches by SmartRecruiters URL', () => {
      expect(isTalanJob({ url: 'https://jobs.smartrecruiters.com/Talan/744000135283150' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isTalanJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTalanJob(null)).toBe(false);
      expect(isTalanJob(undefined)).toBe(false);
      expect(isTalanJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://talan.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.talan.com/job/456')).toBe(true);
    });

    it('trusts SmartRecruiters posting URLs', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/Talan/744000135283150')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects other SmartRecruiters tenants', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/OtherCompany/123')).toBe(false);
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
      expect(slugify('Developer talan ch')).toBe('developer-talan-ch');
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
      id: 'talan-abc123',
      slug: 'test-position-talan-geneve',
      slugByLocale: { fr: 'test-position-talan-geneve' },
      company: 'Talan',
      companyKey: 'talan',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://jobs.smartrecruiters.com/Talan/test',
      source: 'Talan Dedicated Parser',
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
      expect(validJob.id).toMatch(/^talan-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
