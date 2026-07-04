import { describe, it, expect } from 'vitest';
import {
  CORDENPHARMA_KEY,
  CORDENPHARMA_COMPANY_NAME,
  isCordenpharmaJob,
  isTrustedDomain,
  resolveAddress,
} from '../scripts/lib/cordenpharma-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CordenPharma crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CORDENPHARMA_KEY).toBe('cordenpharma');
    expect(CORDENPHARMA_COMPANY_NAME).toBe('CordenPharma');
  });

  // ── isCompanyJob ──
  describe('isCordenpharmaJob', () => {
    it('matches by companyKey', () => {
      expect(isCordenpharmaJob({ companyKey: 'cordenpharma' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCordenpharmaJob({ company: 'CordenPharma' })).toBe(true);
    });

    it('matches by company name variant with space', () => {
      expect(isCordenpharmaJob({ company: 'Corden Pharma International' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCordenpharmaJob({ url: 'https://career.cordenpharma.com/en/p/liestal/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCordenpharmaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCordenpharmaJob(null)).toBe(false);
      expect(isCordenpharmaJob(undefined)).toBe(false);
      expect(isCordenpharmaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://cordenpharma.com/careers')).toBe(true);
    });

    it('trusts the d.vinci career subdomain', () => {
      expect(isTrustedDomain('https://career.cordenpharma.com/en/p/liestal/jobs')).toBe(true);
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
      const slug = slugify('Process Engineer (m/f/d)');
      expect(slug).toBe('process-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Operator cordenpharma liestal')).toBe('operator-cordenpharma-liestal');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllCordenpharmaJobs emits)
    const validJob = {
      id: 'cordenpharma-abc123',
      slug: 'test-position-cordenpharma-liestal',
      slugByLocale: { de: 'test-position-cordenpharma-liestal' },
      company: 'CordenPharma',
      companyKey: 'cordenpharma',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Liestal',
      canton: 'BL',
      url: 'https://career.cordenpharma.com/en/p/liestal/jobs/123/test-position',
      source: 'CordenPharma Dedicated Parser (d.vinci)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Liestal',
      addressRegion: 'BL',
      streetAddress: 'Eichenweg 1 A',
      postalCode: '4410',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^cordenpharma-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Site-id-gated address fallback (see AGENTS.md sibling-pattern fix) ──
  // Both Swiss sites are known ground truth, keyed by the d.vinci
  // `locations[].id`. A job whose site id doesn't match a known Swiss
  // worksite (e.g. an out-of-scope location slipping through the
  // location-filtered fetch) must NOT be silently backfilled with the
  // Liestal/Ettingen address — it falls through to whatever the listing
  // itself reported, never a wrong site's ground truth.
  describe('site-id-gated address fallback', () => {
    it('resolves the known Liestal site by id', () => {
      const result = resolveAddress({ id: 'LIESTAL' });
      expect(result.city).toBe('Liestal');
      expect(result.canton).toBe('BL');
      expect(result.postalCode).toBe('4410');
      expect(result.streetAddress).toBe('Eichenweg 1 A');
    });

    it('resolves the known Ettingen site by id, case-insensitively', () => {
      const result = resolveAddress({ id: 'ettingen' });
      expect(result.city).toBe('Ettingen');
      expect(result.canton).toBe('BL');
      expect(result.postalCode).toBe('4107');
      expect(result.streetAddress).toBe('Brühlstrasse 50');
    });

    it('does NOT backfill a known site address for an unrecognised site id', () => {
      // An out-of-scope location that slipped through must fall back to
      // whatever the listing itself reported, not the Liestal/Ettingen HQ.
      const result = resolveAddress({ id: 'PARIS', city: 'Paris', postalCode: '75001', streetAddress: 'Rue Something' });
      expect(result.city).toBe('Paris');
      expect(result.canton).toBe('');
      expect(result.postalCode).toBe('75001');
      expect(result.streetAddress).toBe('Rue Something');
    });

    it('returns empty fields when neither the site id nor raw location carries an address', () => {
      const result = resolveAddress({});
      expect(result.city).toBe('');
      expect(result.canton).toBe('');
      expect(result.postalCode).toBe('');
      expect(result.streetAddress).toBe('');
    });
  });
});
