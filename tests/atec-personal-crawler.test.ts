import { describe, it, expect } from 'vitest';
import {
  ATEC_PERSONAL_KEY,
  ATEC_PERSONAL_COMPANY_NAME,
  isAtecPersonalJob,
  isTrustedDomain,
} from '../scripts/lib/atec-personal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('ATEC Personal AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ATEC_PERSONAL_KEY).toBe('atec-personal');
    expect(ATEC_PERSONAL_COMPANY_NAME).toBe('ATEC Personal AG');
  });

  // ── isCompanyJob ──
  describe('isAtecPersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isAtecPersonalJob({ companyKey: 'atec-personal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAtecPersonalJob({ company: 'ATEC Personal AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAtecPersonalJob({ url: 'https://atec-personal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAtecPersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAtecPersonalJob(null)).toBe(false);
      expect(isAtecPersonalJob(undefined)).toBe(false);
      expect(isAtecPersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://atec-personal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.atec-personal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer atec-personal ch')).toBe('developer-atec-personal-ch');
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
      id: 'atec-personal-abc123',
      slug: 'test-position-atec-personal-ch',
      slugByLocale: { de: 'test-position-atec-personal-ch' },
      company: 'ATEC Personal AG',
      companyKey: 'atec-personal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://atec-personal.ch/jobs/test',
      source: 'ATEC Personal AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^atec-personal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
