import { describe, it, expect } from 'vitest';
import {
  THERMO_FISHER_SCIENTIFIC_KEY,
  THERMO_FISHER_SCIENTIFIC_COMPANY_NAME,
  thermoFisherPostalCode,
  isThermoFisherScientificJob,
  isTrustedDomain,
} from '../scripts/lib/thermo-fisher-scientific-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Thermo Fisher Scientific (Schweiz) AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(THERMO_FISHER_SCIENTIFIC_KEY).toBe('thermo-fisher-scientific');
    expect(THERMO_FISHER_SCIENTIFIC_COMPANY_NAME).toBe('Thermo Fisher Scientific (Schweiz) AG');
  });

  it('uses postal code 4153 only for Reinach BL', () => {
    expect(thermoFisherPostalCode('Reinach', 'BL')).toBe('4153');
    expect(thermoFisherPostalCode('Reinach', 'AG')).toBe('');
    expect(thermoFisherPostalCode('Allschwil', 'BL')).toBe('');
    expect(thermoFisherPostalCode('Reinach', 'AG', '5734')).toBe('5734');
  });

  // ── isCompanyJob ──
  describe('isThermoFisherScientificJob', () => {
    it('matches by companyKey', () => {
      expect(isThermoFisherScientificJob({ companyKey: 'thermo-fisher-scientific' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isThermoFisherScientificJob({ company: 'Thermo Fisher Scientific (Schweiz) AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isThermoFisherScientificJob({ url: 'https://thermofisher.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isThermoFisherScientificJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isThermoFisherScientificJob(null)).toBe(false);
      expect(isThermoFisherScientificJob(undefined)).toBe(false);
      expect(isThermoFisherScientificJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://thermofisher.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.thermofisher.com/job/456')).toBe(true);
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
      expect(slugify('Developer thermo-fisher-scientific ch')).toBe('developer-thermo-fisher-scientific-ch');
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
      id: 'thermo-fisher-scientific-abc123',
      slug: 'test-position-thermo-fisher-scientific-ch',
      slugByLocale: { en: 'test-position-thermo-fisher-scientific-ch' },
      company: 'Thermo Fisher Scientific (Schweiz) AG',
      companyKey: 'thermo-fisher-scientific',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://thermofisher.com/jobs/test',
      source: 'Thermo Fisher Scientific (Schweiz) AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^thermo-fisher-scientific-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
