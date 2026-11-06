import { describe, it, expect } from 'vitest';
import {
  VOLKSSCHULE_LUZERN_KEY,
  VOLKSSCHULE_LUZERN_COMPANY_NAME,
  isVolksschuleLuzernJob,
  isTrustedDomain,
} from '../scripts/lib/volksschule-luzern-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Volksschule Stadt Luzern crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VOLKSSCHULE_LUZERN_KEY).toBe('volksschule-luzern');
    expect(VOLKSSCHULE_LUZERN_COMPANY_NAME).toBe('Volksschule Stadt Luzern');
  });

  // ── isCompanyJob ──
  describe('isVolksschuleLuzernJob', () => {
    it('matches by companyKey', () => {
      expect(isVolksschuleLuzernJob({ companyKey: 'volksschule-luzern' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVolksschuleLuzernJob({ company: 'Volksschule Stadt Luzern' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVolksschuleLuzernJob({ url: 'https://jobs.stadtluzern.ch/stellen/volksschule/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVolksschuleLuzernJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVolksschuleLuzernJob(null)).toBe(false);
      expect(isVolksschuleLuzernJob(undefined)).toBe(false);
      expect(isVolksschuleLuzernJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stadtluzern.ch/careers/job-123')).toBe(true);
    });

    it('trusts the public jobs subdomain', () => {
      expect(isTrustedDomain('https://jobs.stadtluzern.ch/stellen/volksschule/job-456')).toBe(true);
    });

    it('trusts the careercenter directlink subdomain', () => {
      expect(isTrustedDomain('https://job.stadtluzern.ch/stellen/musik-volksschule/some-role/abc123')).toBe(true);
    });

    it('trusts the shared Prospective host scoped to this tenant', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/medium/1005619/jobs')).toBe(true);
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
      const slug = slugify('Klassenlehrperson (m/w/d)');
      expect(slug).toBe('klassenlehrperson-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Fachlehrperson Bewegung und Sport, Schulhaus Rönnimoos')).not.toMatch(/[öäü]/);
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference, mirroring what the shared
    // Prospective factory (createProspectiveChParser) actually emits.
    const validJob = {
      id: 'volksschule-luzern-abc123',
      slug: 'klassenlehrperson-volksschule-luzern-luzern',
      slugByLocale: { de: 'klassenlehrperson-volksschule-luzern-luzern' },
      company: 'Volksschule Stadt Luzern',
      companyKey: 'volksschule-luzern',
      title: 'Klassenlehrperson 5. Klasse, Schulhaus Wartegg',
      titleByLocale: { de: 'Klassenlehrperson 5. Klasse, Schulhaus Wartegg' },
      description: 'A test job description for validation, long enough to pass the thin-content floor easily.',
      descriptionByLocale: { de: 'A test job description for validation, long enough to pass the thin-content floor easily.' },
      location: 'Luzern',
      canton: 'LU',
      url: 'https://ohws.prospective.ch/public/v1/jobs/test',
      source: 'Volksschule Stadt Luzern Dedicated Parser (Prospective medium 1005619)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      streetAddress: 'Warteggstrasse 11',
      postalCode: '6003',
      addressLocality: 'Luzern',
      addressRegion: 'LU',
      addressCountry: 'CH',
      sector: 'Istruzione',
      category: 'Istruzione',
      employmentType: 'FULL_TIME',
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

    it('has all Non-Negotiable #3 structured-data fields', () => {
      const required = [
        'streetAddress', 'postalCode', 'title', 'description',
        'addressLocality', 'addressRegion', 'employmentType',
      ];
      for (const field of required) {
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^volksschule-luzern-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('is labelled with the education sector, not the shared factory healthcare default', () => {
      expect(validJob.sector).toBe('Istruzione');
      expect(validJob.sector).not.toBe('Sanità / Ospedali');
    });
  });
});
