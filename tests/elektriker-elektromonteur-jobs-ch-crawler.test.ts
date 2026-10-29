import { describe, it, expect } from 'vitest';
import {
  ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_KEY,
  ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_COMPANY_NAME,
  isElektrikerElektromonteurJobsChJob,
  isTrustedDomain,
} from '../scripts/lib/elektriker-elektromonteur-jobs-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('elektriker-elektromonteur-jobs crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_KEY).toBe('elektriker-elektromonteur-jobs-ch');
    expect(ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_COMPANY_NAME).toBe('elektriker-elektromonteur-jobs');
  });

  // ── isCompanyJob ──
  describe('isElektrikerElektromonteurJobsChJob', () => {
    it('matches by companyKey', () => {
      expect(isElektrikerElektromonteurJobsChJob({ companyKey: 'elektriker-elektromonteur-jobs-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isElektrikerElektromonteurJobsChJob({ company: 'elektriker-elektromonteur-jobs' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isElektrikerElektromonteurJobsChJob({ url: 'https://pks-personal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isElektrikerElektromonteurJobsChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isElektrikerElektromonteurJobsChJob(null)).toBe(false);
      expect(isElektrikerElektromonteurJobsChJob(undefined)).toBe(false);
      expect(isElektrikerElektromonteurJobsChJob({})).toBe(false);
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
      expect(slugify('Developer elektriker-elektromonteur-jobs-ch ch')).toBe('developer-elektriker-elektromonteur-jobs-ch-ch');
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
      id: 'elektriker-elektromonteur-jobs-ch-abc123',
      slug: 'test-position-elektriker-elektromonteur-jobs-ch-ch',
      slugByLocale: { de: 'test-position-elektriker-elektromonteur-jobs-ch-ch' },
      company: 'elektriker-elektromonteur-jobs',
      companyKey: 'elektriker-elektromonteur-jobs-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://pks-personal.ch/jobs/test',
      source: 'elektriker-elektromonteur-jobs Dedicated Parser',
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
      expect(validJob.id).toMatch(/^elektriker-elektromonteur-jobs-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
