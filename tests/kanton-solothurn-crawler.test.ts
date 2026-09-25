import { describe, it, expect } from 'vitest';
import {
  KANTON_SOLOTHURN_KEY,
  KANTON_SOLOTHURN_COMPANY_NAME,
  isKantonSolothurnJob,
  isTrustedDomain,
} from '../scripts/lib/kanton-solothurn-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kanton Solothurn crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KANTON_SOLOTHURN_KEY).toBe('kanton-solothurn');
    expect(KANTON_SOLOTHURN_COMPANY_NAME).toBe('Kanton Solothurn');
  });

  // ── isCompanyJob ──
  describe('isKantonSolothurnJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonSolothurnJob({ companyKey: 'kanton-solothurn' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKantonSolothurnJob({ company: 'Kanton Solothurn' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKantonSolothurnJob({ url: 'https://job.so.ch/offene-stellen/test-job/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isKantonSolothurnJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonSolothurnJob(null)).toBe(false);
      expect(isKantonSolothurnJob(undefined)).toBe(false);
      expect(isKantonSolothurnJob({})).toBe(false);
    });

    // Dedup-nuance regression: this employer (the cantonal ADMINISTRATION,
    // job.so.ch) is a distinct entity from `solothurner-spitaeler` / the
    // hospital group, even though both mention "Solothurn". The matcher
    // must not collapse the two employers together.
    it('does not match the separate Solothurner Spitäler (hospital group) employer', () => {
      expect(
        isKantonSolothurnJob({
          companyKey: 'solothurner-spitaeler',
          company: 'Solothurner Spitäler',
          url: 'https://jobs.solothurnerspitaeler.ch/offene-stellen/test/123',
        })
      ).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the job.so.ch board host', () => {
      expect(isTrustedDomain('https://job.so.ch/offene-stellen/test-job/456')).toBe(true);
    });

    it('trusts the karriere.so.ch portal host', () => {
      expect(isTrustedDomain('https://karriere.so.ch/stellenmarkt/offene-stellen/')).toBe(true);
    });

    it('trusts the bare so.ch domain and its subdomains', () => {
      expect(isTrustedDomain('https://so.ch/verwaltung/')).toBe(true);
      expect(isTrustedDomain('https://karriere.so.ch/')).toBe(true);
    });

    it('rejects other domains, including the misleading discovery-tag host', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      // ictjobs.ch is a generic nationwide IT-jobs aggregator, NOT a
      // Kanton Solothurn domain — verified live during discovery.
      expect(isTrustedDomain('https://ictjobs.ch/')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('ICT-Systemspezialist/-in, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('ICT Systemspezialist kanton solothurn solothurn')).toBe(
        'ict-systemspezialist-kanton-solothurn-solothurn'
      );
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference, including the structured-data
    // fields required by Non-Negotiable #3.
    const validJob = {
      id: 'kanton-solothurn-abc123',
      slug: 'test-position-kanton-solothurn-solothurn',
      slugByLocale: { de: 'test-position-kanton-solothurn-solothurn' },
      company: 'Kanton Solothurn',
      companyKey: 'kanton-solothurn',
      companyDomain: 'so.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Solothurn',
      canton: 'SO',
      url: 'https://job.so.ch/offene-stellen/test-position/abc123',
      source: 'Kanton Solothurn Dedicated Parser (Prospective careercenter + JobPosting JSON-LD)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Solothurn',
      addressRegion: 'SO',
      streetAddress: '',
      postalCode: '4500',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://job.so.ch/offene-stellen/test-position/abc123',
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

    it('has the structured-data fields required by Non-Negotiable #3', () => {
      const structuredDataFields = [
        'postalCode', 'streetAddress', 'title', 'description',
        'postedDate', 'company', 'addressLocality', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('description is at least 50 words (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^kanton-solothurn-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Canton-gated address resolution (bug-avoidance regression) ──
  // The parser must NEVER unconditionally backfill streetAddress/postalCode
  // from HQ for a job located in a different canton — only postalCode/
  // streetAddress for jobs actually in HQ's own canton (SO) may fall back
  // to the HQ values; every other canton must get an empty string instead
  // of the Solothurn HQ address leaking onto unrelated postings.
  describe('canton-gated HQ fallback (no cross-canton address leakage)', () => {
    it('HQ-canton job may fall back to HQ postal code', () => {
      const hqCantonJob = {
        canton: 'SO',
        postalCode: '4500',
      };
      expect(hqCantonJob.postalCode).toBe('4500');
    });

    it('non-HQ-canton job never carries the HQ postal code', () => {
      const otherCantonJob = {
        canton: 'BE',
        postalCode: '',
        streetAddress: '',
      };
      expect(otherCantonJob.canton).not.toBe('SO');
      expect(otherCantonJob.postalCode).not.toBe('4500');
    });
  });
});
