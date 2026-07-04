import { describe, it, expect } from 'vitest';
import {
  PLANZER_KEY,
  PLANZER_COMPANY_NAME,
  isPlanzerJob,
  isTrustedDomain,
  resolveAddress,
} from '../scripts/lib/planzer-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Planzer crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PLANZER_KEY).toBe('planzer');
    expect(PLANZER_COMPANY_NAME).toBe('Planzer');
  });

  // ── isCompanyJob ──
  describe('isPlanzerJob', () => {
    it('matches by companyKey', () => {
      expect(isPlanzerJob({ companyKey: 'planzer' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPlanzerJob({ company: 'Planzer' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPlanzerJob({ url: 'https://www.planzer.ch/de/jobs/' })).toBe(true);
    });

    it('matches by Solique tenant URL', () => {
      expect(isPlanzerJob({ url: 'https://live.solique.ch/planzer/job/details/4029958' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPlanzerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPlanzerJob(null)).toBe(false);
      expect(isPlanzerJob(undefined)).toBe(false);
      expect(isPlanzerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.planzer.ch/de/jobs/')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.planzer.ch/job/456')).toBe(true);
    });

    it('trusts the Solique tenant host', () => {
      expect(isTrustedDomain('https://live.solique.ch/planzer/job/details/4029958')).toBe(true);
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
      const slug = slugify('Chauffeur Kat. CE (m/w/d)');
      expect(slug).toBe('chauffeur-kat-ce-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Mühleäulistrasse')).toBe('muhleaulistrasse');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Disponent planzer dietikon')).toBe('disponent-planzer-dietikon');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── resolveAddress — the real exported implementation, not a copy ──
  describe('resolveAddress (real exported implementation)', () => {
    it('parses street + postal + city from a per-job detail-page location block', () => {
      const addr = resolveAddress('Härkingen', 'Pfannenstiel 12\n4624 Härkingen');
      expect(addr.city).toBe('Härkingen');
      expect(addr.postalCode).toBe('4624');
      expect(addr.streetAddress).toBe('Pfannenstiel 12');
    });

    it('parses the HQ site\'s own detail-page location block (Dietikon)', () => {
      const addr = resolveAddress('Dietikon', 'Lerzenstrasse 14\n8953 Dietikon');
      expect(addr.city).toBe('Dietikon');
      expect(addr.postalCode).toBe('8953');
      expect(addr.streetAddress).toBe('Lerzenstrasse 14');
    });

    it('falls back to the Dietikon HQ address ONLY when the resolved city text is Dietikon', () => {
      const addr = resolveAddress('Dietikon', '');
      expect(addr.city).toBe('Dietikon');
      expect(addr.postalCode).toBe('8953');
      expect(addr.streetAddress).toBe('Lerzenstrasse 14');
    });

    it('never attaches the HQ street to a different city, even with no detail text available', () => {
      const addr = resolveAddress('Villmergen', '');
      expect(addr.city).toBe('Villmergen');
      expect(addr.postalCode).toBe('');
      expect(addr.streetAddress).toBe('');
    });

    it('never attaches the HQ street to a SAME-CANTON (ZH) city that is not Dietikon — canton match alone must not trigger the fallback', () => {
      // Wetzikon is a real ZH-canton town, same canton as the Dietikon HQ,
      // but a completely different city. The gate must be city-TEXT based
      // (per AGENTS.md Non-Negotiable #3), never canton-based, so this must
      // NOT inherit the Lerzenstrasse 14 / 8953 HQ address.
      const addr = resolveAddress('Wetzikon', '');
      expect(addr.city).toBe('Wetzikon');
      expect(addr.postalCode).not.toBe('8953');
      expect(addr.streetAddress).toBe('');
    });

    it('handles the <span class="street"> wrapped detail-page markup variant', () => {
      // Real Planzer markup sometimes wraps the street line in a span:
      // <span class="street">Mühleäulistrasse 6<br></span>9470 Buchs
      const addr = resolveAddress('Buchs', 'Mühleäulistrasse 6\n9470 Buchs');
      expect(addr.city).toBe('Buchs');
      expect(addr.postalCode).toBe('9470');
      expect(addr.streetAddress).toBe('Mühleäulistrasse 6');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllPlanzerJobs emits)
    const validJob = {
      id: 'planzer-abc123',
      slug: 'chauffeur-kat-ce-planzer-dietikon',
      slugByLocale: { de: 'chauffeur-kat-ce-planzer-dietikon' },
      company: 'Planzer',
      companyKey: 'planzer',
      title: 'Chauffeur Kat. CE (m/w/d)',
      titleByLocale: { de: 'Chauffeur Kat. CE (m/w/d)' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Dietikon',
      canton: 'ZH',
      url: 'https://live.solique.ch/planzer/job/details/4029961',
      source: 'Planzer Dedicated Parser (Solique)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Dietikon',
      addressRegion: 'ZH',
      streetAddress: 'Lerzenstrasse 14',
      postalCode: '8953',
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
      expect(validJob.id).toMatch(/^planzer-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
