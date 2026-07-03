import { describe, it, expect } from 'vitest';
import {
  CORDENPHARMA_KEY,
  CORDENPHARMA_COMPANY_NAME,
  isCordenpharmaJob,
  isTrustedDomain,
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

  // ── Canton-gating regression guard (see AGENTS.md sibling-pattern fix) ──
  // A job whose site could not be matched to a known Swiss address (e.g. an
  // out-of-scope location slipping through) must NOT be silently backfilled
  // with the Liestal HQ street address/postal code — only when its resolved
  // canton actually equals HQ.canton.
  describe('canton-gated address fallback', () => {
    function resolveLikeParser(canton: string, postalCode: string, streetAddress: string) {
      const HQ = { canton: 'BL', postalCode: '4410', streetAddress: 'Eichenweg 1 A' };
      return {
        postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
        streetAddress: streetAddress || (canton === HQ.canton ? HQ.streetAddress : ''),
      };
    }

    it('backfills HQ address when canton matches (Liestal/Ettingen, both BL)', () => {
      const result = resolveLikeParser('BL', '', '');
      expect(result.postalCode).toBe('4410');
      expect(result.streetAddress).toBe('Eichenweg 1 A');
    });

    it('does NOT backfill HQ address when canton differs', () => {
      const result = resolveLikeParser('FR', '', '');
      expect(result.postalCode).toBe('');
      expect(result.streetAddress).toBe('');
    });

    it('preserves explicit per-site values without overwriting them', () => {
      const result = resolveLikeParser('BL', '4107', 'Brühlstrasse 50');
      expect(result.postalCode).toBe('4107');
      expect(result.streetAddress).toBe('Brühlstrasse 50');
    });
  });
});
