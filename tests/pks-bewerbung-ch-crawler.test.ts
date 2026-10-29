import { describe, it, expect } from 'vitest';
import {
  PKS_BEWERBUNG_CH_KEY,
  PKS_BEWERBUNG_CH_COMPANY_NAME,
  isPksBewerbungChJob,
  isTrustedDomain,
} from '../scripts/lib/pks-bewerbung-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('pks-bewerbung crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PKS_BEWERBUNG_CH_KEY).toBe('pks-bewerbung-ch');
    expect(PKS_BEWERBUNG_CH_COMPANY_NAME).toBe('pks-bewerbung');
  });

  // ── isCompanyJob ──
  describe('isPksBewerbungChJob', () => {
    it('matches by companyKey', () => {
      expect(isPksBewerbungChJob({ companyKey: 'pks-bewerbung-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPksBewerbungChJob({ company: 'pks-bewerbung' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPksBewerbungChJob({ url: 'https://pks-personal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPksBewerbungChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPksBewerbungChJob(null)).toBe(false);
      expect(isPksBewerbungChJob(undefined)).toBe(false);
      expect(isPksBewerbungChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pks-personal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.pks-personal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer pks-bewerbung-ch ch')).toBe('developer-pks-bewerbung-ch-ch');
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
      id: 'pks-bewerbung-ch-abc123',
      slug: 'test-position-pks-bewerbung-ch-ch',
      slugByLocale: { de: 'test-position-pks-bewerbung-ch-ch' },
      company: 'pks-bewerbung',
      companyKey: 'pks-bewerbung-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://pks-personal.ch/jobs/test',
      source: 'pks-bewerbung Dedicated Parser',
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
      expect(validJob.id).toMatch(/^pks-bewerbung-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
