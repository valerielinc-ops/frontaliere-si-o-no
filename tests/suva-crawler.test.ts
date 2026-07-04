import { describe, it, expect } from 'vitest';
import {
  SUVA_KEY,
  SUVA_COMPANY_NAME,
  isSuvaJob,
  isTrustedDomain,
} from '../scripts/lib/suva-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Suva crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SUVA_KEY).toBe('suva');
    expect(SUVA_COMPANY_NAME).toBe('Suva');
  });

  // ── isCompanyJob ──
  describe('isSuvaJob', () => {
    it('matches by companyKey', () => {
      expect(isSuvaJob({ companyKey: 'suva' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSuvaJob({ company: 'Suva' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSuvaJob({ url: 'https://jobs.suva.ch/job/Luzern-Sachbearbeiter-100-LU-6004/123456/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSuvaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('does NOT match the unrelated CRR Suva Sion clinic crawler (name collision guard)', () => {
      expect(
        isSuvaJob({
          companyKey: 'crr-suva-sion',
          company: 'Clinique romande de réadaptation (CRR Suva)',
          url: 'https://crr-suva.ch/emplois/123',
        })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSuvaJob(null)).toBe(false);
      expect(isSuvaJob(undefined)).toBe(false);
      expect(isSuvaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the job board domain', () => {
      expect(isTrustedDomain('https://jobs.suva.ch/job/Luzern-Sachbearbeiter-100-LU-6004/123456/')).toBe(true);
    });

    it('rejects the unrelated CRR Suva Sion clinic domain', () => {
      expect(isTrustedDomain('https://crr-suva.ch/emplois/123')).toBe(false);
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
      const slug = slugify('Sachbearbeiter/in Fallmanagement (m/w/d)');
      expect(slug).toBe('sachbearbeiter-in-fallmanagement-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Gestionnaire de cas spécialisé')).toBe('gestionnaire-de-cas-specialise');
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
      id: 'suva-abc123',
      slug: 'test-position-suva-luzern',
      slugByLocale: { de: 'test-position-suva-luzern' },
      company: 'Suva',
      companyKey: 'suva',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Luzern',
      canton: 'LU',
      url: 'https://jobs.suva.ch/job/Luzern-Test-Position-100-LU-6004/123456/',
      source: 'Suva Dedicated Parser (SuccessFactors — jobs2web/CSB)',
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
      expect(validJob.id).toMatch(/^suva-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
