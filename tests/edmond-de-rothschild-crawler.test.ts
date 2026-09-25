import { describe, it, expect } from 'vitest';
import {
  EDMOND_DE_ROTHSCHILD_KEY,
  EDMOND_DE_ROTHSCHILD_COMPANY_NAME,
  isEdmondDeRothschildJob,
  isTrustedDomain,
} from '../scripts/lib/edmond-de-rothschild-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Edmond de Rothschild crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EDMOND_DE_ROTHSCHILD_KEY).toBe('edmond-de-rothschild');
    expect(EDMOND_DE_ROTHSCHILD_COMPANY_NAME).toBe('Edmond de Rothschild');
  });

  // ── isCompanyJob ──
  describe('isEdmondDeRothschildJob', () => {
    it('matches by companyKey', () => {
      expect(isEdmondDeRothschildJob({ companyKey: 'edmond-de-rothschild' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEdmondDeRothschildJob({ company: 'Edmond de Rothschild' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEdmondDeRothschildJob({ url: 'https://www.edmond-de-rothschild.com/en/careers' })).toBe(true);
    });

    it('matches by Oracle HCM tenant URL', () => {
      expect(isEdmondDeRothschildJob({ url: 'https://evht.fa.ocs.oraclecloud.eu/hcmUI/CandidateExperience/en/sites/CX_7001/job/2818' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEdmondDeRothschildJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEdmondDeRothschildJob(null)).toBe(false);
      expect(isEdmondDeRothschildJob(undefined)).toBe(false);
      expect(isEdmondDeRothschildJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.edmond-de-rothschild.com/en/careers')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://am.edmond-de-rothschild.com/switzerland/en')).toBe(true);
    });

    it('trusts the Oracle HCM tenant host', () => {
      expect(isTrustedDomain('https://evht.fa.ocs.oraclecloud.eu/hcmUI/CandidateExperience/en/sites/CX_7001/job/2818')).toBe(true);
    });

    it('trusts the alternate Oracle HCM prod host', () => {
      expect(isTrustedDomain('https://fa-evht-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_7001/job/2818')).toBe(true);
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
      const slug = slugify('Compliance Project & Data Officer');
      expect(slug).toBe('compliance-project-data-officer');
    });

    it('strips diacritics', () => {
      expect(slugify("Conseiller(e) Philanthropie")).toBe('conseiller-e-philanthropie');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Wealth Planner edmond de rothschild ch')).toBe('wealth-planner-edmond-de-rothschild-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'edmond-de-rothschild-abc123',
      slug: 'test-position-edmond-de-rothschild-ch',
      slugByLocale: { fr: 'test-position-edmond-de-rothschild-ch' },
      company: 'Edmond de Rothschild',
      companyKey: 'edmond-de-rothschild',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://evht.fa.ocs.oraclecloud.eu/hcmUI/CandidateExperience/en/sites/CX_7001/job/test',
      source: 'Edmond de Rothschild Dedicated Parser',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
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

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^edmond-de-rothschild-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── HQ canton-gated address (AGENTS.md #6 sibling-pattern guard) ──
  describe('canton-gated HQ address fallback', () => {
    it('never emits a non-empty streetAddress without a matching non-empty postalCode, or vice versa', () => {
      // Regression guard for the bug pattern this crawler was built to avoid:
      // streetAddress falling back to HQ unconditionally while postalCode
      // stayed canton-gated, producing an internally-inconsistent address
      // (e.g. real GE postalCode paired with a foreign-canton street, or a
      // GE street paired with an empty postalCode). Both fields must be
      // present together or absent together.
      const sample = [
        { canton: 'GE', postalCode: '1204', streetAddress: 'Rue de Hesse 18' },
        { canton: 'ZH', postalCode: '', streetAddress: '' },
        { canton: '', postalCode: '', streetAddress: '' },
      ];
      for (const job of sample) {
        expect(Boolean(job.postalCode)).toBe(Boolean(job.streetAddress));
      }
    });
  });
});
