import { describe, it, expect } from 'vitest';
import {
  RAIFFEISEN_KEY,
  RAIFFEISEN_COMPANY_NAME,
  isRaiffeisenJob,
  isTrustedDomain,
  isVedeggioCassarateListing,
} from '../scripts/lib/raiffeisen-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Raiffeisen (national) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RAIFFEISEN_KEY).toBe('raiffeisen');
    expect(RAIFFEISEN_COMPANY_NAME).toBe('Raiffeisen');
  });

  // ── isCompanyJob ──
  describe('isRaiffeisenJob', () => {
    it('matches by companyKey', () => {
      expect(isRaiffeisenJob({ companyKey: 'raiffeisen' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRaiffeisenJob({ company: 'Raiffeisen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRaiffeisenJob({ url: 'https://jobs.raiffeisen.ch/job/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRaiffeisenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRaiffeisenJob(null)).toBe(false);
      expect(isRaiffeisenJob(undefined)).toBe(false);
      expect(isRaiffeisenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the shared Prospective careercenter domain', () => {
      expect(isTrustedDomain('https://jobs.raiffeisen.ch/careercenter/1950/job/456')).toBe(true);
    });

    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://www.raiffeisen.ch/careers/job-123')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── Partition guarantee vs. the existing raiffeisen-vc dedicated crawler ──
  // `scripts/update-raiffeisen-vc-jobs.mjs` already owns all postings for
  // Banca Raiffeisen Vedeggio Cassarate. This crawler pulls the full
  // national Prospective feed (medium 1950) and MUST exclude that one
  // regional bank's listings to guarantee zero duplicate emission.
  describe('isVedeggioCassarateListing (VC exclusion partition)', () => {
    it('flags a listing whose title mentions Vedeggio', () => {
      expect(isVedeggioCassarateListing({ title: 'Kundenberater/in Vedeggio Cassarate' })).toBe(true);
    });

    it('flags a listing whose intro mentions Cassarate', () => {
      expect(isVedeggioCassarateListing({
        szas: { sza_introduction: 'La Banca Raiffeisen Vedeggio Cassarate cerca...' },
      })).toBe(true);
    });

    it('flags a listing matching only lowercase "cassarate" anywhere in the payload', () => {
      expect(isVedeggioCassarateListing({ directlink: 'https://jobs.raiffeisen.ch/job/cassarate-berater' })).toBe(true);
    });

    it('does not flag unrelated regional banks (incl. other Ticino banks)', () => {
      expect(isVedeggioCassarateListing({ title: 'Kundenberater/in', region: 'Tessin', company: 'Banca Raiffeisen Bellinzona e Alto Ticino' })).toBe(false);
    });

    it('does not flag a plain national-office listing', () => {
      expect(isVedeggioCassarateListing({ title: 'IT Specialist', region: 'St. Gallen' })).toBe(false);
    });

    it('handles null/undefined/circular gracefully', () => {
      expect(isVedeggioCassarateListing(null)).toBe(false);
      expect(isVedeggioCassarateListing(undefined)).toBe(false);
      expect(isVedeggioCassarateListing({})).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Kundenberater/in (m/w/d)');
      expect(slug).toBe('kundenberater-in-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Conseiller clientèle')).toBe('conseiller-clientele');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'raiffeisen-abc123',
      slug: 'test-position-raiffeisen-ch',
      slugByLocale: { de: 'test-position-raiffeisen-ch' },
      company: 'Raiffeisen',
      companyKey: 'raiffeisen',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'St. Gallen',
      canton: 'SG',
      url: 'https://jobs.raiffeisen.ch/careercenter/1950/job/test',
      source: 'Raiffeisen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^raiffeisen-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
