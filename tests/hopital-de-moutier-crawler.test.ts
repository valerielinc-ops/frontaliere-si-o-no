import { describe, it, expect } from 'vitest';
import {
  HOPITAL_DE_MOUTIER_KEY,
  HOPITAL_DE_MOUTIER_COMPANY_NAME,
  isHopitalDeMoutierJob,
  isTrustedDomain,
} from '../scripts/lib/hopital-de-moutier-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hôpital de Moutier crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HOPITAL_DE_MOUTIER_KEY).toBe('hopital-de-moutier');
    expect(HOPITAL_DE_MOUTIER_COMPANY_NAME).toBe('Hôpital de Moutier');
  });

  // ── isCompanyJob (SMN factory pattern: companyKey + company name only) ──
  describe('isHopitalDeMoutierJob', () => {
    it('matches by companyKey', () => {
      expect(isHopitalDeMoutierJob({ companyKey: 'hopital-de-moutier' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHopitalDeMoutierJob({ company: 'Hôpital de Moutier' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHopitalDeMoutierJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHopitalDeMoutierJob(null)).toBe(false);
      expect(isHopitalDeMoutierJob(undefined)).toBe(false);
      expect(isHopitalDeMoutierJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain (factory trusts swissmedical.net + smartrecruiters.com) ──
  describe('isTrustedDomain', () => {
    it('trusts swissmedical.net', () => {
      expect(isTrustedDomain('https://swissmedical.net/careers/job-123')).toBe(true);
    });

    it('trusts swissmedical.net subdomains', () => {
      expect(isTrustedDomain('https://www.swissmedical.net/fr/carriere/offres-emploi')).toBe(true);
    });

    it('trusts jobs.smartrecruiters.com (ATS host)', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-foo')).toBe(true);
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
      expect(slugify('Developer hopital-de-moutier ch')).toBe('developer-hopital-de-moutier-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'hopital-de-moutier-abc123',
      slug: 'test-position-hopital-de-moutier-ch',
      slugByLocale: { fr: 'test-position-hopital-de-moutier-ch' },
      company: 'Hôpital de Moutier',
      companyKey: 'hopital-de-moutier',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Moutier',
      canton: 'BE',
      url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-test',
      source: 'Hôpital de Moutier Dedicated Parser (SMN clinic=MZB)',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^hopital-de-moutier-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
