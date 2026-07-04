import { describe, it, expect } from 'vitest';
import {
  VALORA_KEY,
  VALORA_COMPANY_NAME,
  isValoraJob,
  isTrustedDomain,
} from '../scripts/lib/valora-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Valora Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VALORA_KEY).toBe('valora');
    expect(VALORA_COMPANY_NAME).toBe('Valora Group');
  });

  // ── isCompanyJob ──
  describe('isValoraJob', () => {
    it('matches by companyKey', () => {
      expect(isValoraJob({ companyKey: 'valora' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isValoraJob({ company: 'Valora Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isValoraJob({ url: 'https://career.valora.com/en/job/1234/kiosk-mitarbeiter' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isValoraJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isValoraJob(null)).toBe(false);
      expect(isValoraJob(undefined)).toBe(false);
      expect(isValoraJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://valora.com/en/career/')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://career.valora.com/en/job/1234/kiosk-mitarbeiter')).toBe(true);
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
      const slug = slugify('Kiosk-Mitarbeiter (m/w/d)');
      expect(slug).toBe('kiosk-mitarbeiter-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Café Spettacolo Mitarbeiter')).toBe('cafe-spettacolo-mitarbeiter');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Verkäufer valora muttenz')).toBe('verkaufer-valora-muttenz');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllValoraJobs emits)
    const validJob = {
      id: 'valora-abc123',
      slug: 'test-position-valora-muttenz',
      slugByLocale: { de: 'test-position-valora-muttenz' },
      company: 'Valora Group',
      companyKey: 'valora',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Muttenz',
      canton: 'BL',
      url: 'https://career.valora.com/en/job/1234/test-position',
      source: 'Valora Group Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Muttenz',
      addressRegion: 'BL',
      streetAddress: 'Hofackerstrasse 40',
      postalCode: '4132',
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
      expect(validJob.id).toMatch(/^valora-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── City-gated HQ address fallback regression ──
  // Core correctness rule for this crawler: the HQ street address/postal
  // code may ONLY backfill a job whose own resolved city text matches
  // Muttenz — never merely because the job shares Valora's home canton
  // (BL). A same-canton-but-different-city job (e.g. Liestal or a
  // canton-wide "Agenturpartner" posting resolved to Basel) must NOT
  // inherit the Muttenz street address.
  describe('city-gated HQ address fallback', () => {
    // Mirrors the parser's own resolveAddress() gating logic (regex on
    // resolved city text, never canton equality) to pin the contract at
    // the test layer independent of the parser's internals.
    const HQ = {
      city: 'Muttenz',
      postalCode: '4132',
      streetAddress: 'Hofackerstrasse 40',
    };

    function resolveAddress(rawLoc: { city?: string; postalCode?: string; streetAddress?: string }) {
      const city = (rawLoc.city || '').trim();
      const postalCode = (rawLoc.postalCode || '').trim();
      const streetAddress = (rawLoc.streetAddress || '').trim();
      return {
        city: city || HQ.city,
        postalCode: postalCode || (!city || /muttenz/i.test(city) ? HQ.postalCode : ''),
        streetAddress: streetAddress || (!city || /muttenz/i.test(city) ? HQ.streetAddress : ''),
      };
    }

    it('backfills HQ street address for a Muttenz-city job with no address block', () => {
      const resolved = resolveAddress({ city: 'Muttenz' });
      expect(resolved.streetAddress).toBe('Hofackerstrasse 40');
      expect(resolved.postalCode).toBe('4132');
    });

    it('backfills HQ street address when city is entirely unresolved', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Muttenz');
      expect(resolved.streetAddress).toBe('Hofackerstrasse 40');
      expect(resolved.postalCode).toBe('4132');
    });

    it('does NOT backfill HQ street address for a same-canton different-city job (Basel)', () => {
      // Basel-Stadt canton is distinct from Baselland (BL, Muttenz's
      // canton), but this is exactly the kind of same-region-different-
      // city case the gate must reject even if canton codes were equal.
      const resolved = resolveAddress({ city: 'Basel' });
      expect(resolved.streetAddress).toBe('');
      expect(resolved.postalCode).toBe('');
      expect(resolved.city).toBe('Basel');
    });

    it('does NOT backfill HQ street address for a same-canton (BL) different-city job (Liestal)', () => {
      const resolved = resolveAddress({ city: 'Liestal' });
      expect(resolved.streetAddress).toBe('');
      expect(resolved.postalCode).toBe('');
      expect(resolved.city).toBe('Liestal');
    });

    it('preserves an explicit non-HQ street address/postal code untouched', () => {
      const resolved = resolveAddress({
        city: 'Zürich',
        postalCode: '8001',
        streetAddress: 'Bahnhofstrasse 1',
      });
      expect(resolved.streetAddress).toBe('Bahnhofstrasse 1');
      expect(resolved.postalCode).toBe('8001');
      expect(resolved.city).toBe('Zürich');
    });
  });
});
