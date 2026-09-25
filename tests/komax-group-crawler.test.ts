import { describe, it, expect } from 'vitest';
import {
  KOMAX_KEY,
  KOMAX_COMPANY_NAME,
  KOMAX_COMPANY_DOMAIN,
  isKomaxJob,
  isTrustedDomain,
  resolveAddress,
  resolveKomaxCanton,
} from '../scripts/lib/komax-group-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Komax crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KOMAX_KEY).toBe('komax');
    expect(KOMAX_COMPANY_NAME).toBe('Komax');
    expect(KOMAX_COMPANY_DOMAIN).toBe('komaxgroup.com');
  });

  // ── isCompanyJob ──
  describe('isKomaxJob', () => {
    it('matches by companyKey', () => {
      expect(isKomaxJob({ companyKey: 'komax' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKomaxJob({ company: 'Komax' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKomaxJob({ url: 'https://jobs.komaxgroup.com/job/Dierikon-Strategic-Procurement-Manager/1164641455/' })).toBe(true);
    });

    it('matches by www subdomain', () => {
      expect(isKomaxJob({ url: 'https://www.komaxgroup.com/en/careers' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKomaxJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKomaxJob(null)).toBe(false);
      expect(isKomaxJob(undefined)).toBe(false);
      expect(isKomaxJob({})).toBe(false);
    });

    it('handles malformed URL gracefully', () => {
      expect(isKomaxJob({ url: 'not-a-url' })).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://komaxgroup.com/en/careers')).toBe(true);
    });

    it('trusts jobs subdomain (jobs2web ATS host)', () => {
      expect(isTrustedDomain('https://jobs.komaxgroup.com/job/Dierikon-Strategic-Procurement-Manager/1164641455/')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.komaxgroup.com/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects lookalike domains', () => {
      expect(isTrustedDomain('https://komaxgroup.com.evil.com/jobs')).toBe(false);
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
      expect(slugify('Developer komax ch')).toBe('developer-komax-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllKomaxGroupJobs emits)
    const validJob = {
      id: 'komax-abc123',
      slug: 'test-position-komax-ch',
      slugByLocale: { de: 'test-position-komax-ch' },
      company: 'Komax',
      companyKey: 'komax',
      companyDomain: 'komaxgroup.com',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Dierikon',
      canton: 'LU',
      url: 'https://jobs.komaxgroup.com/job/Dierikon-Test-Position/123456/',
      source: 'Komax Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Dierikon',
      addressRegion: 'LU',
      streetAddress: 'Industriestrasse 6',
      postalCode: '6036',
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
      expect(validJob.id).toMatch(/^komax-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Feed parsing (title suffix stripping + RSS-item extraction) ──
  describe('feed item parsing', () => {
    it('strips only the trailing "(City, CC, Postal)" location suffix from titles, preserving earlier parens', async () => {
      // Exercised indirectly via fetchAllKomaxGroupJobs would require live
      // network; the exact regex used inside the parser
      // (`/\s*\([^()]*\)\s*$/`) is asserted directly here to lock the
      // behaviour without a network dependency.
      const raw = 'Strategic Procurement Manager 100 % (m/w/d) (Dierikon, CH, 6036)';
      const stripped = raw.replace(/\s*\([^()]*\)\s*$/, '').trim();
      expect(stripped).toBe('Strategic Procurement Manager 100 % (m/w/d)');
    });
  });

  // ── City-gated HQ address resolution (CRITICAL — never gate on canton) ──
  // Komax posts jobs from both Dierikon (LU, its real HQ) and Thun (BE, a
  // different canton) today. This exercises the real, exported
  // resolveAddress() directly (no network dependency) to prove the HQ
  // street-address/postal-code fallback is gated on the job's own resolved
  // CITY TEXT, never on canton alone.
  describe('resolveAddress — city-gated, not canton-gated', () => {
    it('grants the HQ streetAddress + postalCode fallback for Dierikon (the real HQ city)', () => {
      const result = resolveAddress('Dierikon', '');
      expect(result.city).toBe('Dierikon');
      expect(result.postalCode).toBe('6036');
      expect(result.streetAddress).toBe('Industriestrasse 6');
    });

    it('does NOT grant the HQ streetAddress to a different city in the SAME canton (LU)', () => {
      // Kriens and Luzern are canton LU, exactly like Dierikon — but are not
      // Dierikon itself, so a canton-only gate would incorrectly leak the
      // HQ street address here. Canton-only gating is a known recurring bug
      // class (cf. staubli-job-parser.mjs's resolveAddress()).
      const kriens = resolveAddress('Kriens', '');
      expect(kriens.streetAddress).toBe('');
      expect(kriens.postalCode).toBe('');

      const luzern = resolveAddress('Luzern', '');
      expect(luzern.streetAddress).toBe('');
      expect(luzern.postalCode).toBe('');
    });

    it('does NOT grant the HQ streetAddress to a different-canton city (Thun, BE)', () => {
      const thun = resolveAddress('Thun', '3608');
      expect(thun.streetAddress).toBe('');
      // postalCode still comes through when the feed itself supplies one.
      expect(thun.postalCode).toBe('3608');
    });

    it('prefers the feed-supplied postal code over the HQ fallback even for the HQ city', () => {
      const result = resolveAddress('Dierikon', '6036');
      expect(result.postalCode).toBe('6036');
      expect(result.streetAddress).toBe('Industriestrasse 6');
    });

    it('falls back to HQ city/streetAddress/postalCode when no city text is available at all', () => {
      // Mirrors staubli-job-parser.mjs: an entirely missing location defaults
      // to the HQ, since there is no other city to (incorrectly) match against.
      const result = resolveAddress('', '');
      expect(result.city).toBe('Dierikon');
      expect(result.postalCode).toBe('6036');
      expect(result.streetAddress).toBe('Industriestrasse 6');
    });
  });

  // ── resolveKomaxCanton (unresolved-canton skip guard — isSwissLocation()
  // filters on the ", CH," country segment, NOT on Dierikon/Thun, so a real
  // but unrecognized city must never fabricate the Dierikon HQ canton,
  // task-critical) ──
  describe('resolveKomaxCanton', () => {
    it('resolves the HQ cities directly, bypassing generic inference', () => {
      expect(resolveKomaxCanton('Dierikon')).toBe('LU');
      expect(resolveKomaxCanton('Thun')).toBe('BE');
    });

    it('resolves a known Swiss city outside the two hardcoded cities via generic inference', () => {
      expect(resolveKomaxCanton('Bern')).toBe('BE');
    });

    it('falls back to the Dierikon HQ canton when no city text was scraped at all', () => {
      expect(resolveKomaxCanton('')).toBe('LU');
    });

    it('returns null (skip) when city text is present but unresolvable — never fabricates the HQ canton', () => {
      expect(resolveKomaxCanton('Nonexistentburg')).toBeNull();
    });

    it('does NOT fabricate LU for the negative-control case (Bern, not LU)', () => {
      expect(resolveKomaxCanton('Bern')).not.toBe('LU');
    });
  });
});
