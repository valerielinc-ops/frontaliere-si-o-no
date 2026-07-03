import { describe, it, expect } from 'vitest';
import {
  CHOPARD_KEY,
  CHOPARD_COMPANY_NAME,
  isChopardJob,
  isTrustedDomain,
  resolveAddress,
} from '../scripts/lib/chopard-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Chopard crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CHOPARD_KEY).toBe('chopard');
    expect(CHOPARD_COMPANY_NAME).toBe('Chopard');
  });

  // ── isCompanyJob ──
  describe('isChopardJob', () => {
    it('matches by companyKey', () => {
      expect(isChopardJob({ companyKey: 'chopard' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChopardJob({ company: 'Chopard' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isChopardJob({ url: 'https://chopard.com/careers/job-123' })).toBe(true);
    });

    it('matches by CSOD tenant URL', () => {
      expect(
        isChopardJob({ url: 'https://chopard.csod.com/ux/ats/careersite/1/home/requisition/2529?c=chopard' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isChopardJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChopardJob(null)).toBe(false);
      expect(isChopardJob(undefined)).toBe(false);
      expect(isChopardJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://chopard.com/careers')).toBe(true);
      expect(isTrustedDomain('https://www.chopard.com/it-it/careers')).toBe(true);
    });

    it('trusts the CSOD career-site host', () => {
      expect(isTrustedDomain('https://chopard.csod.com/ux/ats/careersite/1/home')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.com/chopard')).toBe(false);
      expect(isTrustedDomain('not a url')).toBe(false);
    });
  });

  // ── resolveAddress — city-gated HQ fallback (regression guard) ──
  // CRITICAL: the fallback for postalCode/streetAddress must be gated on
  // whether the job's resolved CITY matches the HQ city (Meyrin), NEVER on
  // canton equality. Canton-gating incorrectly stamps the HQ's exact street
  // address onto every job anywhere in canton GE, even a different city.
  describe('resolveAddress (HQ fallback, city-gated not canton-gated)', () => {
    it('fills HQ street/postal code when city is empty', () => {
      const addr = resolveAddress('');
      expect(addr.city).toBe('Meyrin');
      expect(addr.postalCode).toBe('1217');
      expect(addr.streetAddress).toBe('Route de Veyrot 8');
    });

    it('fills HQ street/postal code when city IS Meyrin', () => {
      const addr = resolveAddress('Meyrin');
      expect(addr.postalCode).toBe('1217');
      expect(addr.streetAddress).toBe('Route de Veyrot 8');
    });

    it('does NOT fill HQ street/postal code for a different city in the SAME canton (GE)', () => {
      // Genève city is a different locality than Meyrin, even though both
      // are canton GE — this must NOT receive Chopard HQ's exact street.
      const addr = resolveAddress('Genève');
      expect(addr.city).toBe('Genève');
      expect(addr.postalCode).toBe('');
      expect(addr.streetAddress).toBe('');
    });

    it('does NOT fill HQ street/postal code for an unrelated city', () => {
      const addr = resolveAddress('Zürich');
      expect(addr.city).toBe('Zürich');
      expect(addr.postalCode).toBe('');
      expect(addr.streetAddress).toBe('');
    });
  });

  // ── ParsedJob shape contract ──
  describe('ParsedJob shape', () => {
    const validJob = {
      id: 'chopard-abc123def456',
      slug: slugify('Chef de Projet IT Chopard Meyrin'),
      slugByLocale: { fr: slugify('Chef de Projet IT Chopard Meyrin') },
      company: CHOPARD_COMPANY_NAME,
      companyKey: CHOPARD_KEY,
      title: 'Chef de Projet IT',
      titleByLocale: { fr: 'Chef de Projet IT' },
      description: 'Description of the role at Chopard in Meyrin, Switzerland.',
      descriptionByLocale: { fr: 'Description of the role at Chopard in Meyrin, Switzerland.' },
      location: 'Meyrin',
      canton: 'GE',
      url: 'https://chopard.csod.com/ux/ats/careersite/1/home/requisition/2529?c=chopard&lang=en-US',
      source: 'Chopard Dedicated Parser (Cornerstone OnDemand)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Meyrin',
      streetAddress: 'Route de Veyrot 8',
      postalCode: '1217',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey', 'title',
        'titleByLocale', 'description', 'descriptionByLocale', 'location',
        'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('has fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream with safe defaults;
      // per-job inputs are the parser's responsibility to supply.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^chopard-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
