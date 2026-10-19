import { describe, it, expect } from 'vitest';
import {
  MEDIMEO_CH_KEY,
  MEDIMEO_CH_COMPANY_NAME,
  isMedimeoChJob,
  isMedimeoChExpectedDetailFilter,
  resolveMedimeoChGeography,
  isTrustedDomain,
} from '../scripts/lib/medimeo-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Medimeo AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MEDIMEO_CH_KEY).toBe('medimeo-ch');
    expect(MEDIMEO_CH_COMPANY_NAME).toBe('Medimeo AG');
  });

  // ── isCompanyJob ──
  describe('isMedimeoChJob', () => {
    it('matches by companyKey', () => {
      expect(isMedimeoChJob({ companyKey: 'medimeo-ch' })).toBe(true);
    });

    it('rejects the sibling crawler key even with shared company metadata', () => {
      expect(isMedimeoChJob({
        companyKey: 'medimeo',
        company: 'Medimeo AG',
        url: 'https://medimeo.ch/jobs/123',
      })).toBe(false);
    });

    it('rejects ambiguous company and URL fallbacks', () => {
      expect(isMedimeoChJob({ company: 'Medimeo AG' })).toBe(false);
      expect(isMedimeoChJob({ url: 'https://medimeo.ch/jobs/123' })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isMedimeoChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMedimeoChJob(null)).toBe(false);
      expect(isMedimeoChJob(undefined)).toBe(false);
      expect(isMedimeoChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://medimeo.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.medimeo.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('isMedimeoChExpectedDetailFilter', () => {
    it('classifies mixed Swiss/Liechtenstein geography as an expected filter', () => {
      expect(isMedimeoChExpectedDetailFilter({
        reason: 'geography',
        decision: { explicitlyForeign: true, geography: null },
      })).toBe(true);
    });

    it('keeps missing geography evidence in the completeness denominator', () => {
      expect(isMedimeoChExpectedDetailFilter({
        reason: 'geography',
        decision: { explicitlyForeign: false, geography: null },
      })).toBe(false);
    });

    it('does not classify transport or tenant failures as expected filters', () => {
      expect(isMedimeoChExpectedDetailFilter({
        reason: 'detail',
        decision: { explicitlyForeign: true, geography: null },
      })).toBe(false);
    });
  });

  describe('resolveMedimeoChGeography', () => {
    it('keeps a broad source region when structured locality repeats the display label', () => {
      expect(resolveMedimeoChGeography({
        location: 'Region Basel',
        addressLocality: 'Region Basel',
        addressRegion: 'BS',
        addressCountry: 'CH',
      })).toMatchObject({ location: 'Region Basel', canton: 'BS', addressCountry: 'CH' });
    });

    it('resolves broad Swiss regions without inventing a municipality', () => {
      expect(resolveMedimeoChGeography({
        location: 'Region Zürich',
        addressLocality: 'Region Zürich',
        addressRegion: 'ZH',
        addressCountry: 'CH',
      })).toMatchObject({ location: 'Region Zürich', canton: 'ZH', addressCountry: 'CH' });
    });

    it('does not bypass a foreign structured-region conflict through the fallback', () => {
      expect(resolveMedimeoChGeography({
        location: 'Region Basel',
        addressLocality: 'Region Basel',
        addressRegion: 'Lombardy',
        addressCountry: 'CH',
      })).toBeNull();
    });

    it('rejects contradictory country fields before preferring addressCountry', () => {
      expect(resolveMedimeoChGeography({
        location: 'Lugano',
        addressCountry: 'CH',
        country: 'Italy',
        addressRegion: 'ZH',
      })).toBeNull();
    });

    it('rejects a structured canton that conflicts with the source locality', () => {
      expect(resolveMedimeoChGeography({
        location: 'Lugano',
        addressCountry: 'CH',
        addressRegion: 'ZH',
      })).toBeNull();
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
      expect(slugify('Developer medimeo-ch ch')).toBe('developer-medimeo-ch-ch');
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
      id: 'medimeo-ch-abc123',
      slug: 'test-position-medimeo-ch-ch',
      slugByLocale: { de: 'test-position-medimeo-ch-ch' },
      company: 'Medimeo AG',
      companyKey: 'medimeo-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://medimeo.ch/jobs/test',
      source: 'Medimeo AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^medimeo-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
