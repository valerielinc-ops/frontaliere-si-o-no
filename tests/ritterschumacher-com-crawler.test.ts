import { describe, it, expect } from 'vitest';
import {
  RITTERSCHUMACHER_COM_KEY,
  RITTERSCHUMACHER_COM_COMPANY_NAME,
  isRitterschumacherComJob,
  isTrustedDomain,
} from '../scripts/lib/ritterschumacher-com-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Ritter Schumacher AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RITTERSCHUMACHER_COM_KEY).toBe('ritterschumacher-com');
    expect(RITTERSCHUMACHER_COM_COMPANY_NAME).toBe('Ritter Schumacher AG');
  });

  // ── isCompanyJob ──
  describe('isRitterschumacherComJob', () => {
    it('matches by companyKey', () => {
      expect(isRitterschumacherComJob({ companyKey: 'ritterschumacher-com' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRitterschumacherComJob({ company: 'Ritter Schumacher AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRitterschumacherComJob({ url: 'https://ritterschumacher.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRitterschumacherComJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRitterschumacherComJob(null)).toBe(false);
      expect(isRitterschumacherComJob(undefined)).toBe(false);
      expect(isRitterschumacherComJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ritterschumacher.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ritterschumacher.com/job/456')).toBe(true);
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
      expect(slugify('Developer ritterschumacher-com ch')).toBe('developer-ritterschumacher-com-ch');
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
      id: 'ritterschumacher-com-abc123',
      slug: 'test-position-ritterschumacher-com-ch',
      slugByLocale: { de: 'test-position-ritterschumacher-com-ch' },
      company: 'Ritter Schumacher AG',
      companyKey: 'ritterschumacher-com',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ritterschumacher.com/jobs/test',
      source: 'Ritter Schumacher AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ritterschumacher-com-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
