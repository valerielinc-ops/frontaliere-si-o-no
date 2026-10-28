import { describe, it, expect } from 'vitest';
import {
  GRUND_AG_CH_KEY,
  GRUND_AG_CH_COMPANY_NAME,
  isGrundAgChJob,
  isTrustedDomain,
} from '../scripts/lib/grund-ag-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Grund AG Fahrzeuge crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GRUND_AG_CH_KEY).toBe('grund-ag-ch');
    expect(GRUND_AG_CH_COMPANY_NAME).toBe('Grund AG Fahrzeuge');
  });

  // ── isCompanyJob ──
  describe('isGrundAgChJob', () => {
    it('matches by companyKey', () => {
      expect(isGrundAgChJob({ companyKey: 'grund-ag-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGrundAgChJob({ company: 'Grund AG Fahrzeuge' })).toBe(true);
    });

    it('matches by source vacancy URL', () => {
      expect(isGrundAgChJob({
        url: 'https://www.yousty.ch/de-CH/lehrstellen/profile/8804712-automobil-fachmann-frau-efz-nutzfahrzeuge-triengen-lu-grund-ag-fahrzeuge',
      })).toBe(true);
    });

    it('rejects unrelated vacancies on the shared source host', () => {
      expect(isGrundAgChJob({
        companyKey: 'other',
        company: 'Other',
        url: 'https://yousty.ch/jobs/other',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isGrundAgChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGrundAgChJob(null)).toBe(false);
      expect(isGrundAgChJob(undefined)).toBe(false);
      expect(isGrundAgChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://yousty.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.yousty.ch/job/456')).toBe(true);
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
      expect(slugify('Developer grund-ag-ch ch')).toBe('developer-grund-ag-ch-ch');
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
      id: 'grund-ag-ch-abc123',
      slug: 'test-position-grund-ag-ch-ch',
      slugByLocale: { de: 'test-position-grund-ag-ch-ch' },
      company: 'Grund AG Fahrzeuge',
      companyKey: 'grund-ag-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://yousty.ch/jobs/test',
      source: 'Grund AG Fahrzeuge Dedicated Parser',
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
      expect(validJob.id).toMatch(/^grund-ag-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
