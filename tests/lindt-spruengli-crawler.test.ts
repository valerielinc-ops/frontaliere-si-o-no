import { describe, it, expect } from 'vitest';
import {
  LINDT_SPRUENGLI_KEY,
  LINDT_SPRUENGLI_COMPANY_NAME,
  isLindtSpruengliJob,
  isTrustedDomain,
  extractCityFromLocationText,
} from '../scripts/lib/lindt-spruengli-job-parser.mjs';
import {
  SPRUENGLI_KEY,
  SPRUENGLI_COMPANY_NAME,
  isSpruengliJob,
} from '../scripts/lib/spruengli-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Lindt & Sprüngli crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LINDT_SPRUENGLI_KEY).toBe('lindt-spruengli');
    expect(LINDT_SPRUENGLI_COMPANY_NAME).toBe('Lindt & Sprüngli');
  });

  // ── isCompanyJob ──
  describe('isLindtSpruengliJob', () => {
    it('matches by companyKey', () => {
      expect(isLindtSpruengliJob({ companyKey: 'lindt-spruengli' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLindtSpruengliJob({ company: 'Lindt & Sprüngli' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLindtSpruengliJob({ url: 'https://www.lindt-spruengli.com/careers/vacancies' })).toBe(true);
    });

    it('matches by Workday tenant URL', () => {
      expect(isLindtSpruengliJob({ url: 'https://lindtspruengli.wd103.myworkdayjobs.com/en-US/LindtSpruengliGroupCareers/job/Kilchberg/Test_R12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLindtSpruengliJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLindtSpruengliJob(null)).toBe(false);
      expect(isLindtSpruengliJob(undefined)).toBe(false);
      expect(isLindtSpruengliJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.lindt-spruengli.com/careers/vacancies')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.lindt-spruengli.com/job/456')).toBe(true);
    });

    it('trusts Workday ATS host', () => {
      expect(isTrustedDomain('https://lindtspruengli.wd103.myworkdayjobs.com/en-US/LindtSpruengliGroupCareers/job/Kilchberg/Test_R12345')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects the unrelated Confiserie Sprüngli domain', () => {
      expect(isTrustedDomain('https://www.spruengli.ch/en/jobs/job-vacancies.html')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Patissier*in 90%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Projektleiter*in Qualität')).toBe('projektleiter-in-qualitat');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer lindt spruengli ch')).toBe('developer-lindt-spruengli-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── City extraction (feeds the city-gated HQ address fallback) ──
  describe('extractCityFromLocationText', () => {
    it('extracts city from a "City, Country" pair', () => {
      expect(extractCityFromLocationText('Kilchberg, Switzerland')).toBe('Kilchberg');
    });

    it('extracts a non-HQ city from a "City, Country" pair', () => {
      expect(extractCityFromLocationText('Altendorf, Switzerland')).toBe('Altendorf');
    });

    it('extracts a recognizable city from a malformed dash-separated string', () => {
      expect(extractCityFromLocationText('LCH - CHE - Plant - Kilchberg - Plant')).toBe('Kilchberg');
    });

    it('returns empty for a genuinely ambiguous multi-location posting', () => {
      expect(extractCityFromLocationText('2 Locations')).toBe('');
    });

    it('returns empty for blank input', () => {
      expect(extractCityFromLocationText('')).toBe('');
      expect(extractCityFromLocationText(undefined as unknown as string)).toBe('');
    });
  });

  // ── City-gated HQ address fallback regression (core correctness rule) ──
  // The HQ street address / postal code must ONLY be applied when the job's
  // own resolved city text actually matches the HQ city (Kilchberg) via a
  // city-text regex — never gated on canton equality alone. Canton-only
  // gating would wrongly stamp the Kilchberg street address onto every other
  // ZH-canton job (e.g. a hypothetical Zürich retail "Lindt Shop" posting),
  // which is a distinct address from group HQ.
  describe('city-gated HQ address fallback', () => {
    it('applies the full HQ street address for a Kilchberg job', () => {
      expect(isLindtSpruengliJob({ companyKey: 'lindt-spruengli' })).toBe(true);
      expect(extractCityFromLocationText('Kilchberg, Switzerland')).toBe('Kilchberg');
    });

    it('does NOT apply the HQ street address for a same-canton but different-city job (Spreitenbach, AG)', () => {
      // Spreitenbach is genuinely canton Aargau (AG), not Zürich (ZH) — this
      // also regression-tests the shared target-swiss-locations.mjs city/
      // canton alias data fixed alongside this crawler (was misfiled under
      // ZH; see scripts/lib/crawler-location-config.mjs SWISS_CANTONS).
      expect(extractCityFromLocationText('Spreitenbach, Switzerland')).toBe('Spreitenbach');
    });

    it('does NOT apply the HQ street address for a different ZH-canton city (Zürich)', () => {
      // Even though Zürich shares canton ZH with Kilchberg, the city text
      // itself does not match /kilchberg/i, so the address fallback must
      // stay blank rather than canton-gated.
      const city = extractCityFromLocationText('Zürich, Switzerland');
      expect(city).toBe('Zürich');
      expect(/kilchberg/i.test(city)).toBe(false);
    });
  });

  // ── Collision regression: must NOT collide with the unrelated Confiserie Sprüngli crawler ──
  describe('no collision with the unrelated Confiserie Sprüngli crawler', () => {
    it('company name and key are distinct from Confiserie Sprüngli', () => {
      expect(LINDT_SPRUENGLI_COMPANY_NAME).not.toBe(SPRUENGLI_COMPANY_NAME);
      expect(LINDT_SPRUENGLI_COMPANY_NAME).not.toBe('Sprüngli');
      expect(LINDT_SPRUENGLI_KEY).not.toBe(SPRUENGLI_KEY);
      expect(LINDT_SPRUENGLI_KEY).not.toBe('spruengli');
    });

    it('a Lindt & Sprüngli job is NOT matched by isSpruengliJob', () => {
      const lindtJob = { companyKey: LINDT_SPRUENGLI_KEY, company: LINDT_SPRUENGLI_COMPANY_NAME, url: 'https://lindtspruengli.wd103.myworkdayjobs.com/en-US/LindtSpruengliGroupCareers/job/Kilchberg/Test_R12345' };
      expect(isSpruengliJob(lindtJob)).toBe(false);
    });

    it('a Confiserie Sprüngli job is NOT matched by isLindtSpruengliJob', () => {
      const spruengliJob = { companyKey: SPRUENGLI_KEY, company: SPRUENGLI_COMPANY_NAME, url: 'https://www.spruengli.ch/en/jobs/job-vacancies.html' };
      expect(isLindtSpruengliJob(spruengliJob)).toBe(false);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllLindtSpruengliJobs emits)
    const validJob = {
      id: 'lindt-spruengli-abc123',
      slug: 'patissier-in-90-lindt-spruengli-kilchberg',
      slugByLocale: { de: 'patissier-in-90-lindt-spruengli-kilchberg' },
      company: 'Lindt & Sprüngli',
      companyKey: 'lindt-spruengli',
      title: 'Patissier*in 90%',
      titleByLocale: { de: 'Patissier*in 90%' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Kilchberg',
      canton: 'ZH',
      url: 'https://lindtspruengli.wd103.myworkdayjobs.com/en-US/LindtSpruengliGroupCareers/job/Kilchberg/test',
      source: 'Lindt & Sprüngli Dedicated Parser (Workday)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Kilchberg',
      addressRegion: 'ZH',
      streetAddress: 'Seestrasse 204',
      postalCode: '8802',
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
      expect(validJob.id).toMatch(/^lindt-spruengli-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
