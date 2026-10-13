import { describe, it, expect } from 'vitest';
import {
  OPUS_PERSONAL_KEY,
  OPUS_PERSONAL_COMPANY_NAME,
  isOpusPersonalJob,
  isTrustedDomain,
} from '../scripts/lib/opus-personal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Opus Personal AG, Zweigniederlassung Altdorf crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OPUS_PERSONAL_KEY).toBe('opus-personal');
    expect(OPUS_PERSONAL_COMPANY_NAME).toBe('Opus Personal AG, Zweigniederlassung Altdorf');
  });

  // ── isCompanyJob ──
  describe('isOpusPersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isOpusPersonalJob({ companyKey: 'opus-personal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOpusPersonalJob({ company: 'Opus Personal AG, Zweigniederlassung Altdorf' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOpusPersonalJob({ url: 'https://opus-personal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOpusPersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOpusPersonalJob(null)).toBe(false);
      expect(isOpusPersonalJob(undefined)).toBe(false);
      expect(isOpusPersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://opus-personal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.opus-personal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer opus-personal ch')).toBe('developer-opus-personal-ch');
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
      id: 'opus-personal-abc123',
      slug: 'test-position-opus-personal-ch',
      slugByLocale: { de: 'test-position-opus-personal-ch' },
      company: 'Opus Personal AG, Zweigniederlassung Altdorf',
      companyKey: 'opus-personal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://opus-personal.ch/jobs/test',
      source: 'Opus Personal AG, Zweigniederlassung Altdorf Dedicated Parser',
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
      expect(validJob.id).toMatch(/^opus-personal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
