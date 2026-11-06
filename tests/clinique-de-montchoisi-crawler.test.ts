import { describe, it, expect } from 'vitest';
import {
  CLINIQUE_DE_MONTCHOISI_KEY,
  CLINIQUE_DE_MONTCHOISI_COMPANY_NAME,
  isCliniqueDeMontchoisiJob,
  isTrustedDomain,
} from '../scripts/lib/clinique-de-montchoisi-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Clinique de Montchoisi crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CLINIQUE_DE_MONTCHOISI_KEY).toBe('clinique-de-montchoisi');
    expect(CLINIQUE_DE_MONTCHOISI_COMPANY_NAME).toBe('Clinique de Montchoisi');
  });

  // ── isCompanyJob (SMN factory pattern: companyKey + company name only) ──
  describe('isCliniqueDeMontchoisiJob', () => {
    it('matches by companyKey', () => {
      expect(isCliniqueDeMontchoisiJob({ companyKey: 'clinique-de-montchoisi' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCliniqueDeMontchoisiJob({ company: 'Clinique de Montchoisi' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCliniqueDeMontchoisiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCliniqueDeMontchoisiJob(null)).toBe(false);
      expect(isCliniqueDeMontchoisiJob(undefined)).toBe(false);
      expect(isCliniqueDeMontchoisiJob({})).toBe(false);
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
      expect(slugify('Developer clinique-de-montchoisi ch')).toBe('developer-clinique-de-montchoisi-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'clinique-de-montchoisi-abc123',
      slug: 'test-position-clinique-de-montchoisi-ch',
      slugByLocale: { fr: 'test-position-clinique-de-montchoisi-ch' },
      company: 'Clinique de Montchoisi',
      companyKey: 'clinique-de-montchoisi',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lausanne',
      canton: 'VD',
      url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-test',
      source: 'Clinique de Montchoisi Dedicated Parser (SMN clinic=CDM)',
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
      expect(validJob.id).toMatch(/^clinique-de-montchoisi-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
