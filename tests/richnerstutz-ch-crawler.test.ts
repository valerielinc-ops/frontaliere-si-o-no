import { describe, it, expect } from 'vitest';
import {
  RICHNERSTUTZ_CH_KEY,
  RICHNERSTUTZ_CH_COMPANY_NAME,
  isRichnerstutzChJob,
  isTrustedDomain,
} from '../scripts/lib/richnerstutz-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Richnerstutz AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RICHNERSTUTZ_CH_KEY).toBe('richnerstutz-ch');
    expect(RICHNERSTUTZ_CH_COMPANY_NAME).toBe('Richnerstutz AG');
  });

  // ── isCompanyJob ──
  describe('isRichnerstutzChJob', () => {
    it('matches by companyKey', () => {
      expect(isRichnerstutzChJob({ companyKey: 'richnerstutz-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRichnerstutzChJob({ company: 'Richnerstutz AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRichnerstutzChJob({ url: 'https://richnerstutz.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRichnerstutzChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRichnerstutzChJob(null)).toBe(false);
      expect(isRichnerstutzChJob(undefined)).toBe(false);
      expect(isRichnerstutzChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://richnerstutz.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.richnerstutz.ch/job/456')).toBe(true);
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
      expect(slugify('Developer richnerstutz-ch ch')).toBe('developer-richnerstutz-ch-ch');
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
      id: 'richnerstutz-ch-abc123',
      slug: 'test-position-richnerstutz-ch-ch',
      slugByLocale: { de: 'test-position-richnerstutz-ch-ch' },
      company: 'Richnerstutz AG',
      companyKey: 'richnerstutz-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://richnerstutz.ch/jobs/test',
      source: 'Richnerstutz AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^richnerstutz-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
