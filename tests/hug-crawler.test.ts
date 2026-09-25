import { describe, it, expect } from 'vitest';
import {
  HUG_KEY,
  HUG_COMPANY_NAME,
  isHugJob,
  isTrustedDomain,
} from '../scripts/lib/hug-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('HUG (Hôpitaux Universitaires de Genève) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HUG_KEY).toBe('hug');
    expect(HUG_COMPANY_NAME).toBe('HUG');
  });

  // ── isCompanyJob ──
  describe('isHugJob', () => {
    it('matches by companyKey', () => {
      expect(isHugJob({ companyKey: 'hug' })).toBe(true);
    });

    it('matches by short company name', () => {
      expect(isHugJob({ company: 'HUG' })).toBe(true);
    });

    it('matches by full French name', () => {
      expect(isHugJob({ company: 'Hôpitaux Universitaires de Genève' })).toBe(true);
    });

    it('matches by hug.ch URL', () => {
      expect(isHugJob({ url: 'https://hug.ch/jobs/123' })).toBe(true);
    });

    it('matches by SmartRecruiters tenant URL', () => {
      expect(isHugJob({ url: 'https://jobs.smartrecruiters.com/HUG/123-abc' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHugJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('rejects jobs that contain the substring "hug" in another word', () => {
      expect(isHugJob({ companyKey: 'hugo-boss', company: 'Hugo Boss', url: 'https://group.hugoboss.com/' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHugJob(null)).toBe(false);
      expect(isHugJob(undefined)).toBe(false);
      expect(isHugJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary hug.ch domain', () => {
      expect(isTrustedDomain('https://hug.ch/careers/job-123')).toBe(true);
    });

    it('trusts hug.ch subdomains', () => {
      expect(isTrustedDomain('https://careers.hug.ch/job/456')).toBe(true);
    });

    it('trusts the SmartRecruiters tenant URL (jobs.smartrecruiters.com/HUG/...)', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/HUG/abc-123')).toBe(true);
    });

    it('trusts the SmartRecruiters API path for HUG', () => {
      expect(isTrustedDomain('https://api.smartrecruiters.com/v1/companies/HUG/postings')).toBe(true);
    });

    it('rejects another tenant on smartrecruiters.com', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/Schindler/abc-123')).toBe(false);
    });

    it('rejects unrelated domains', () => {
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
      const slug = slugify('Infirmier·ère diplômé·e');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Médecin pédiatre')).toBe('medecin-pediatre');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Infirmier hug geneve')).toBe('infirmier-hug-geneve');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'hug-abc123',
      slug: 'medecin-hug-geneve',
      slugByLocale: { fr: 'medecin-hug-geneve' },
      company: 'HUG',
      companyKey: 'hug',
      title: 'Médecin pédiatre',
      titleByLocale: { fr: 'Médecin pédiatre' },
      description: 'Une description de poste.',
      descriptionByLocale: { fr: 'Une description de poste.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://jobs.smartrecruiters.com/HUG/abc-123',
      source: 'HUG Dedicated Parser (SmartRecruiters API)',
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
      expect(validJob.id).toMatch(/^hug-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('default canton is GE for HUG (Geneva HQ)', () => {
      expect(validJob.canton).toBe('GE');
    });
  });
});
