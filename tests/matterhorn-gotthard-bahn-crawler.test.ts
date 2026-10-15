import { describe, it, expect } from 'vitest';
import {
  MATTERHORN_GOTTHARD_BAHN_KEY,
  MATTERHORN_GOTTHARD_BAHN_COMPANY_NAME,
  isMatterhornGotthardBahnJob,
  isTrustedDomain,
} from '../scripts/lib/matterhorn-gotthard-bahn-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Matterhorn Gotthard Bahn crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MATTERHORN_GOTTHARD_BAHN_KEY).toBe('matterhorn-gotthard-bahn');
    expect(MATTERHORN_GOTTHARD_BAHN_COMPANY_NAME).toBe('Matterhorn Gotthard Bahn');
  });

  // ── isCompanyJob ──
  describe('isMatterhornGotthardBahnJob', () => {
    it('matches by companyKey', () => {
      expect(isMatterhornGotthardBahnJob({ companyKey: 'matterhorn-gotthard-bahn' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMatterhornGotthardBahnJob({ company: 'Matterhorn Gotthard Bahn' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMatterhornGotthardBahnJob({ url: 'https://bvzholding.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMatterhornGotthardBahnJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMatterhornGotthardBahnJob(null)).toBe(false);
      expect(isMatterhornGotthardBahnJob(undefined)).toBe(false);
      expect(isMatterhornGotthardBahnJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bvzholding.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bvzholding.ch/job/456')).toBe(true);
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
      expect(slugify('Developer matterhorn-gotthard-bahn ch')).toBe('developer-matterhorn-gotthard-bahn-ch');
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
      id: 'matterhorn-gotthard-bahn-abc123',
      slug: 'test-position-matterhorn-gotthard-bahn-ch',
      slugByLocale: { de: 'test-position-matterhorn-gotthard-bahn-ch' },
      company: 'Matterhorn Gotthard Bahn',
      companyKey: 'matterhorn-gotthard-bahn',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bvzholding.ch/jobs/test',
      source: 'Matterhorn Gotthard Bahn Dedicated Parser',
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
      expect(validJob.id).toMatch(/^matterhorn-gotthard-bahn-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
