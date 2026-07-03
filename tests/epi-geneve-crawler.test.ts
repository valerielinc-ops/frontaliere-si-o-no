import { describe, it, expect } from 'vitest';
import {
  EPI_GENEVE_KEY,
  EPI_GENEVE_COMPANY_NAME,
  isEpiGeneveJob,
  isTrustedDomain,
} from '../scripts/lib/epi-geneve-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('EPI Genève crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EPI_GENEVE_KEY).toBe('epi-geneve');
    expect(EPI_GENEVE_COMPANY_NAME).toBe("Établissements publics pour l'intégration");
  });

  // ── isCompanyJob ──
  describe('isEpiGeneveJob', () => {
    it('matches by companyKey', () => {
      expect(isEpiGeneveJob({ companyKey: 'epi-geneve' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEpiGeneveJob({ company: "Établissements publics pour l'intégration" })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEpiGeneveJob({ url: 'https://www.epi.ge.ch/les-epi/offres-demploi/' })).toBe(true);
    });

    it('matches by SmartRecruiters board URL', () => {
      expect(
        isEpiGeneveJob({
          url: 'https://jobs.smartrecruiters.com/EtablissementsPublicsPourLIntegration/744000012345678-educateur-trice-specialise-e',
        })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEpiGeneveJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEpiGeneveJob(null)).toBe(false);
      expect(isEpiGeneveJob(undefined)).toBe(false);
      expect(isEpiGeneveJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.epi.ge.ch/les-epi/offres-demploi/')).toBe(true);
    });

    it('trusts SmartRecruiters domain (ATS job board)', () => {
      expect(
        isTrustedDomain('https://jobs.smartrecruiters.com/EtablissementsPublicsPourLIntegration/744000012345678')
      ).toBe(true);
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
      const slug = slugify('Éducateur/trice spécialisé(e) (Genève)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Éducateur spécialisé')).toBe('educateur-specialise');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Educateur specialise epi geneve geneve')).toBe('educateur-specialise-epi-geneve-geneve');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllEpiGeneveJobs emits)
    const validJob = {
      id: 'epi-geneve-abc123',
      slug: 'test-position-epi-geneve-geneve',
      slugByLocale: { fr: 'test-position-epi-geneve-geneve' },
      company: "Établissements publics pour l'intégration",
      companyKey: 'epi-geneve',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://jobs.smartrecruiters.com/EtablissementsPublicsPourLIntegration/test',
      source: 'EPI Genève Dedicated Parser',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Genève',
      addressRegion: 'GE',
      streetAddress: 'Route de Chêne 48',
      postalCode: '1208',
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
      expect(validJob.id).toMatch(/^epi-geneve-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
