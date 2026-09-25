import { describe, it, expect } from 'vitest';
import {
  SONARSOURCE_KEY,
  SONARSOURCE_COMPANY_NAME,
  isSonarsourceJob,
  isTrustedDomain,
} from '../scripts/lib/sonarsource-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SonarSource (Sonar) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SONARSOURCE_KEY).toBe('sonarsource');
    expect(SONARSOURCE_COMPANY_NAME).toBe('SonarSource (Sonar)');
  });

  // ── isCompanyJob ──
  describe('isSonarsourceJob', () => {
    it('matches by companyKey', () => {
      expect(isSonarsourceJob({ companyKey: 'sonarsource' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSonarsourceJob({ company: 'SonarSource (Sonar)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSonarsourceJob({ url: 'https://sonarsource.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSonarsourceJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSonarsourceJob(null)).toBe(false);
      expect(isSonarsourceJob(undefined)).toBe(false);
      expect(isSonarsourceJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://sonarsource.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.sonarsource.com/job/456')).toBe(true);
    });

    it('trusts the Lever-hosted applicant URL (jobs.lever.co)', () => {
      expect(isTrustedDomain('https://jobs.lever.co/sonarsource/abc-123-def')).toBe(true);
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
      expect(slugify('Developer sonarsource ch')).toBe('developer-sonarsource-ch');
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
      id: 'sonarsource-abc123',
      slug: 'test-position-sonarsource-ch',
      slugByLocale: { en: 'test-position-sonarsource-ch' },
      company: 'SonarSource (Sonar)',
      companyKey: 'sonarsource',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://sonarsource.com/jobs/test',
      source: 'SonarSource (Sonar) Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^sonarsource-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
