import { describe, it, expect } from 'vitest';
import {
  PRIVATKLINIK_OBACH_KEY,
  PRIVATKLINIK_OBACH_COMPANY_NAME,
  isPrivatklinikObachJob,
  isTrustedDomain,
  matchesPrivatklinikObachPosting,
} from '../scripts/lib/privatklinik-obach-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Privatklinik Obach crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PRIVATKLINIK_OBACH_KEY).toBe('privatklinik-obach');
    expect(PRIVATKLINIK_OBACH_COMPANY_NAME).toBe('Privatklinik Obach');
  });

  describe('matchesPrivatklinikObachPosting', () => {
    it('owns postings carrying the exact Obach department label', () => {
      expect(matchesPrivatklinikObachPosting({
        id: '744000146478439',
        location: { city: 'Solothurn' },
        department: { label: 'Privatklinik Obach' },
        customField: [{ fieldLabel: 'Department', valueLabel: 'Privatklinik Obach' }],
      })).toBe(true);
    });

    it('does not claim other SMN clinics sharing the tenant', () => {
      expect(matchesPrivatklinikObachPosting({
        id: '744000100000000',
        location: { city: 'Genolier' },
        department: { label: 'Clinique de Genolier' },
      })).toBe(false);
    });
  });

  // ── isCompanyJob ──
  describe('isPrivatklinikObachJob', () => {
    it('matches by companyKey', () => {
      expect(isPrivatklinikObachJob({ companyKey: 'privatklinik-obach' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPrivatklinikObachJob({ company: 'Privatklinik Obach' })).toBe(true);
    });

    it('matches SmartRecruiters job carrying the companyKey', () => {
      expect(
        isPrivatklinikObachJob({
          companyKey: 'privatklinik-obach',
          url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/744000128471410-test',
        }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPrivatklinikObachJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPrivatklinikObachJob(null)).toBe(false);
      expect(isPrivatklinikObachJob(undefined)).toBe(false);
      expect(isPrivatklinikObachJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swissmedical.net/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swissmedical.net/job/456')).toBe(true);
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
      expect(slugify('Developer privatklinik-obach ch')).toBe('developer-privatklinik-obach-ch');
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
      id: 'privatklinik-obach-abc123',
      slug: 'test-position-privatklinik-obach-ch',
      slugByLocale: { de: 'test-position-privatklinik-obach-ch' },
      company: 'Privatklinik Obach',
      companyKey: 'privatklinik-obach',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://swissmedical.net/jobs/test',
      source: 'Privatklinik Obach Dedicated Parser',
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
      expect(validJob.id).toMatch(/^privatklinik-obach-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
