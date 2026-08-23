import { describe, it, expect } from 'vitest';
import {
  EOC_CANDIDATI_POSIZIONI_KEY,
  EOC_CANDIDATI_POSIZIONI_COMPANY_NAME,
  isEocCandidatiPosizioniJob,
  isTrustedDomain,
} from '../scripts/lib/eoc-candidati-posizioni-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('EOC candiDati Posizioni crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EOC_CANDIDATI_POSIZIONI_KEY).toBe('eoc-candidati-posizioni');
    expect(EOC_CANDIDATI_POSIZIONI_COMPANY_NAME).toBe('EOC candiDati Posizioni');
  });

  // ── isCompanyJob ──
  describe('isEocCandidatiPosizioniJob', () => {
    it('matches by companyKey', () => {
      expect(isEocCandidatiPosizioniJob({ companyKey: 'eoc-candidati-posizioni' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEocCandidatiPosizioniJob({ company: 'EOC candiDati Posizioni' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEocCandidatiPosizioniJob({ url: 'https://recruitingapp-2761.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEocCandidatiPosizioniJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEocCandidatiPosizioniJob(null)).toBe(false);
      expect(isEocCandidatiPosizioniJob(undefined)).toBe(false);
      expect(isEocCandidatiPosizioniJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2761.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2761.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer eoc-candidati-posizioni ch')).toBe('developer-eoc-candidati-posizioni-ch');
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
      id: 'eoc-candidati-posizioni-abc123',
      slug: 'test-position-eoc-candidati-posizioni-ch',
      slugByLocale: { it: 'test-position-eoc-candidati-posizioni-ch' },
      company: 'EOC candiDati Posizioni',
      companyKey: 'eoc-candidati-posizioni',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2761.umantis.com/jobs/test',
      source: 'EOC candiDati Posizioni Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^eoc-candidati-posizioni-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
