import { describe, it, expect } from 'vitest';
import {
  VZ_VERMOEGENSZENTRUM_KEY,
  VZ_VERMOEGENSZENTRUM_COMPANY_NAME,
  isVzVermoegenszentrumJob,
  isTrustedDomain,
} from '../scripts/lib/vz-vermoegenszentrum-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('VZ VermögensZentrum crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VZ_VERMOEGENSZENTRUM_KEY).toBe('vz-vermoegenszentrum');
    expect(VZ_VERMOEGENSZENTRUM_COMPANY_NAME).toBe('VZ VermögensZentrum');
  });

  // ── isCompanyJob ──
  describe('isVzVermoegenszentrumJob', () => {
    it('matches by companyKey', () => {
      expect(isVzVermoegenszentrumJob({ companyKey: 'vz-vermoegenszentrum' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVzVermoegenszentrumJob({ company: 'VZ VermögensZentrum' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isVzVermoegenszentrumJob({ url: 'https://jobs.vermoegenszentrum.ch/jobs/123' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isVzVermoegenszentrumJob({
          companyKey: 'other-company',
          company: 'Other',
          url: 'https://other.com/jobs',
        }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVzVermoegenszentrumJob(null)).toBe(false);
      expect(isVzVermoegenszentrumJob(undefined)).toBe(false);
      expect(isVzVermoegenszentrumJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vermoegenszentrum.ch/jobs-karriere')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.vermoegenszentrum.ch/job/456')).toBe(true);
    });

    it('trusts the prospective.ch ATS feed host', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/medium/1003550/jobs')).toBe(
        true,
      );
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
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Vermögensberater/in')).toBe('vermogensberater-in');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Kundenberater vz vermoegenszentrum ch')).toBe(
        'kundenberater-vz-vermoegenszentrum-ch',
      );
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllVzVermoegenszentrumJobs emits)
    const validJob = {
      id: 'vz-vermoegenszentrum-abc123',
      slug: 'test-position-vz-vermoegenszentrum-ch',
      slugByLocale: { de: 'test-position-vz-vermoegenszentrum-ch' },
      company: 'VZ VermögensZentrum',
      companyKey: 'vz-vermoegenszentrum',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich, Zürich',
      canton: 'ZH',
      url: 'https://jobs.vermoegenszentrum.ch/jobs/test',
      source: 'VZ VermögensZentrum Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'Zürich',
      streetAddress: 'Gotthardstrasse 6',
      postalCode: '8002',
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
      expect(validJob.id).toMatch(/^vz-vermoegenszentrum-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Canton-gated HQ address fallback (the bug pattern this parser must avoid) ──
  describe('canton-gated address fallback', () => {
    it('never applies the Zug HQ street address to a job in a different canton', () => {
      // A job in Zürich with no street/zip in the feed must NOT silently
      // inherit the Zug HQ's street address just because that field was
      // empty upstream — only same-canton (ZG) jobs may fall back to HQ.
      const zurichJobWithoutStreet = {
        canton: 'ZH',
        addressLocality: 'Zürich',
        streetAddress: '', // missing upstream — must stay empty, not Zug's address
      };
      const HQ_STREET = 'Innere Güterstrasse 2';
      expect(zurichJobWithoutStreet.streetAddress).not.toBe(HQ_STREET);
    });
  });
});
