import { describe, it, expect } from 'vitest';
import {
  DE_KEY,
  DE_COMPANY_NAME,
  isDeJob,
  isTrustedDomain,
} from '../scripts/lib/de-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('MPI AGE crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DE_KEY).toBe('de');
    expect(DE_COMPANY_NAME).toBe('MPI AGE');
  });

  // ── isCompanyJob ──
  describe('isDeJob', () => {
    it('matches by companyKey', () => {
      expect(isDeJob({ companyKey: 'de' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDeJob({ company: 'MPI AGE' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDeJob({ url: 'https://mpi-age.de.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDeJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDeJob(null)).toBe(false);
      expect(isDeJob(undefined)).toBe(false);
      expect(isDeJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://mpi-age.de.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.mpi-age.de.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer de ch')).toBe('developer-de-ch');
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
      id: 'de-abc123',
      slug: 'test-position-de-ch',
      slugByLocale: { de: 'test-position-de-ch' },
      company: 'MPI AGE',
      companyKey: 'de',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://mpi-age.de.umantis.com/jobs/test',
      source: 'MPI AGE Dedicated Parser',
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
      expect(validJob.id).toMatch(/^de-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
