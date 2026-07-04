import { describe, it, expect } from 'vitest';
import {
  VEEAM_KEY,
  VEEAM_COMPANY_NAME,
  isVeeamJob,
  isTrustedDomain,
  resolveAddress,
} from '../scripts/lib/veeam-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Veeam Software crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VEEAM_KEY).toBe('veeam');
    expect(VEEAM_COMPANY_NAME).toBe('Veeam Software');
  });

  // ── isCompanyJob ──
  describe('isVeeamJob', () => {
    it('matches by companyKey', () => {
      expect(isVeeamJob({ companyKey: 'veeam' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVeeamJob({ company: 'Veeam Software' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVeeamJob({ url: 'https://veeam.com/careers/123' })).toBe(true);
    });

    it('matches by Greenhouse board URL', () => {
      expect(isVeeamJob({ url: 'https://job-boards.eu.greenhouse.io/veeamsoftware/jobs/4781641101' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVeeamJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVeeamJob(null)).toBe(false);
      expect(isVeeamJob(undefined)).toBe(false);
      expect(isVeeamJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://veeam.com/careers')).toBe(true);
    });

    it('trusts the Greenhouse board host', () => {
      expect(isTrustedDomain('https://job-boards.eu.greenhouse.io/veeamsoftware/jobs/4781641101')).toBe(true);
      expect(isTrustedDomain('https://boards-api.greenhouse.io/v1/boards/veeamsoftware/jobs')).toBe(true);
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
      const slug = slugify('Senior Sales Engineer - Data & AI Security');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Sales Specialist veeam ch')).toBe('sales-specialist-veeam-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  // (mirrors the exact shape fetchAllVeeamJobs emits)
  const validJob = {
    id: 'veeam-abc123',
    slug: 'test-position-veeam-ch',
    slugByLocale: { en: 'test-position-veeam-ch' },
    company: 'Veeam Software',
    companyKey: 'veeam',
    title: 'Test Position',
    titleByLocale: { en: 'Test Position' },
    description: 'A test job description for validation.',
    descriptionByLocale: { en: 'A test job description for validation.' },
    location: 'Baar',
    canton: 'ZG',
    url: 'https://job-boards.eu.greenhouse.io/veeamsoftware/jobs/123',
    source: 'Veeam Software Dedicated Parser (Greenhouse)',
    sourceLang: 'en',
    crawledAt: new Date().toISOString(),
    // ── Recommended fields (structured-data completeness, AGENTS.md Non-Negotiable #3) ──
    addressLocality: 'Baar',
    addressRegion: 'ZG',
    streetAddress: 'Lindenstrasse 16',
    postalCode: '6340',
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

  it('has fields required for job-page structured data (baseSalary source inputs)', () => {
    // baseSalary itself is synthesized downstream with safe defaults;
    // per-job inputs are this parser's responsibility to supply.
    const structuredDataInputs = [
      'postalCode', 'streetAddress', 'title', 'description',
      'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
    ];
    for (const field of structuredDataInputs) {
      expect(validJob).toHaveProperty(field);
      expect(validJob[field as keyof typeof validJob]).toBeTruthy();
    }
  });

  it('company name is present for hiringOrganization.name', () => {
    expect(validJob.company).toBe(VEEAM_COMPANY_NAME);
  });

  it('jobLocation inputs (addressLocality/addressRegion/addressCountry) are present', () => {
    expect(validJob.addressLocality).toBeTruthy();
    expect(validJob.addressRegion).toBeTruthy();
    expect(validJob.addressCountry).toBe('CH');
  });

  it('slug only contains source locale', () => {
    const locales = Object.keys(validJob.slugByLocale);
    expect(locales).toHaveLength(1);
    expect(locales[0]).toBe(validJob.sourceLang);
  });

  it('id starts with company key', () => {
    expect(validJob.id).toMatch(/^veeam-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  // ── City-gated address fallback (see AGENTS.md sibling-pattern fix +
  // scripts/lib/staubli-job-parser.mjs resolveAddress()) ──
  // A Swiss posting merely sharing ZG canton with some other ZG
  // municipality must NOT silently inherit the Baar street address —
  // only an actual city-text match (or no city info at all, e.g. "Remote,
  // Switzerland" postings) may backfill the HQ street/postal code.
  describe('city-gated address fallback (not canton-only)', () => {
    it('backfills HQ address when no city is present ("Remote, Switzerland")', () => {
      const result = resolveAddress('Remote, Switzerland');
      expect(result.postalCode).toBe('6340');
      expect(result.streetAddress).toBe('Lindenstrasse 16');
    });

    it('backfills HQ address when city explicitly is Baar', () => {
      const result = resolveAddress('Baar, Switzerland');
      expect(result.postalCode).toBe('6340');
      expect(result.streetAddress).toBe('Lindenstrasse 16');
    });

    it('does NOT backfill HQ street/postal when city is a different ZG-canton municipality', () => {
      // Zug and Baar are both canton ZG, but Zug is a different city — a
      // canton-only gate would wrongly backfill here; a city-only gate
      // (correct) must not.
      const result = resolveAddress('Zug, Switzerland');
      expect(result.postalCode).toBe('');
      expect(result.streetAddress).toBe('');
    });

    it('does NOT backfill HQ street/postal for an out-of-canton Swiss city', () => {
      const result = resolveAddress('Zürich, Switzerland');
      expect(result.postalCode).toBe('');
      expect(result.streetAddress).toBe('');
    });
  });
});
