import { describe, it, expect } from 'vitest';
import {
  MIGROS_HQ_KEY,
  MIGROS_HQ_COMPANY_NAME,
  isMigrosHqJob,
  isTrustedDomain,
} from '../scripts/lib/migros-hq-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Migros HQ Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MIGROS_HQ_KEY).toBe('migros-hq');
    expect(MIGROS_HQ_COMPANY_NAME).toBe('Migros HQ Zürich');
  });

  // ── isCompanyJob ──
  describe('isMigrosHqJob', () => {
    it('matches by companyKey', () => {
      expect(isMigrosHqJob({ companyKey: 'migros-hq' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMigrosHqJob({ company: 'Migros HQ Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMigrosHqJob({ url: 'https://migros.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMigrosHqJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMigrosHqJob(null)).toBe(false);
      expect(isMigrosHqJob(undefined)).toBe(false);
      expect(isMigrosHqJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://migros.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.migros.ch/job/456')).toBe(true);
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
      expect(slugify('Developer migros-hq ch')).toBe('developer-migros-hq-ch');
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
      id: 'migros-hq-abc123',
      slug: 'test-position-migros-hq-ch',
      slugByLocale: { de: 'test-position-migros-hq-ch' },
      company: 'Migros HQ Zürich',
      companyKey: 'migros-hq',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://migros.ch/jobs/test',
      source: 'Migros HQ Zürich Dedicated Parser',
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
      expect(validJob.id).toMatch(/^migros-hq-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
