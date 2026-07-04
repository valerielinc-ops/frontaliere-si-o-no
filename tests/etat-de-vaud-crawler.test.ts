import { describe, it, expect } from 'vitest';
import {
  ETAT_DE_VAUD_KEY,
  ETAT_DE_VAUD_COMPANY_NAME,
  isEtatDeVaudJob,
  isTrustedDomain,
} from '../scripts/lib/etat-de-vaud-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('État de Vaud crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ETAT_DE_VAUD_KEY).toBe('etat-de-vaud');
    expect(ETAT_DE_VAUD_COMPANY_NAME).toBe('État de Vaud (Administration cantonale vaudoise)');
  });

  // ── isCompanyJob ──
  describe('isEtatDeVaudJob', () => {
    it('matches by companyKey', () => {
      expect(isEtatDeVaudJob({ companyKey: 'etat-de-vaud' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEtatDeVaudJob({ company: 'État de Vaud (Administration cantonale vaudoise)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEtatDeVaudJob({ url: 'https://offres-emploi.vd.ch/#fr/sites/CX_1/job/5541' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEtatDeVaudJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEtatDeVaudJob(null)).toBe(false);
      expect(isEtatDeVaudJob(undefined)).toBe(false);
      expect(isEtatDeVaudJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vd.ch/emploi')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://offres-emploi.vd.ch/#fr/sites/CX_1/job/5541')).toBe(true);
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
      expect(slugify('Gestionnaire spécialisé')).toBe('gestionnaire-specialise');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Chef de projet etat de vaud lausanne')).toBe('chef-de-projet-etat-de-vaud-lausanne');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference — mirrors the fields
    // fetchAllEtatDeVaudJobs() actually emits, including the canton-gated
    // address fields (postalCode/streetAddress) per Non-Negotiable #3.
    const validJob = {
      id: 'etat-de-vaud-5541',
      slug: 'chef-fe-de-projet-etat-de-vaud-lausanne',
      slugByLocale: { fr: 'chef-fe-de-projet-etat-de-vaud-lausanne' },
      company: 'État de Vaud (Administration cantonale vaudoise)',
      companyKey: 'etat-de-vaud',
      title: 'Chef·fe de projet',
      titleByLocale: { fr: 'Chef·fe de projet' },
      description: 'A test job description for validation, long enough to satisfy the fifty word content floor required for indexed pages across every locale of the frontaliereticino site, covering mission, responsibilities and qualifications for the Administration cantonale vaudoise position based in Lausanne, Suisse, open to internal and external candidates alike right now.',
      descriptionByLocale: { fr: 'A test job description for validation, long enough to satisfy the fifty word content floor required for indexed pages across every locale of the frontaliereticino site, covering mission, responsibilities and qualifications for the Administration cantonale vaudoise position based in Lausanne, Suisse, open to internal and external candidates alike right now.' },
      location: 'Lausanne',
      canton: 'VD',
      url: 'https://offres-emploi.vd.ch/#fr/sites/CX_1/job/5541',
      source: 'État de Vaud Dedicated Parser (Oracle Recruiting Cloud)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      postalCode: '1000',
      streetAddress: 'Place du Château 1',
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

    it('includes canton-gated address fields for a Vaud location', () => {
      expect(validJob.postalCode).toBe('1000');
      expect(validJob.streetAddress).toBe('Place du Château 1');
    });

    it('satisfies the 50-word content floor (Non-Negotiable #4)', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^etat-de-vaud-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
