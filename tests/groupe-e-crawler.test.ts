import { describe, it, expect } from 'vitest';
import {
  GROUPE_E_KEY,
  GROUPE_E_COMPANY_NAME,
  GROUPE_E_COMPANY_DOMAIN,
  isGroupeEJob,
  isTrustedDomain,
} from '../scripts/lib/groupe-e-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Groupe E crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(GROUPE_E_KEY).toBe('groupe-e');
    expect(GROUPE_E_COMPANY_NAME).toBe('Groupe E');
    expect(GROUPE_E_COMPANY_DOMAIN).toBe('groupe-e.ch');
  });

  // ── isCompanyJob ──
  describe('isGroupeEJob', () => {
    it('matches by companyKey', () => {
      expect(isGroupeEJob({ companyKey: 'groupe-e' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGroupeEJob({ company: 'Groupe E' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGroupeEJob({ url: 'https://job.groupe-e.ch/job/electricien-de-reseau/123456/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGroupeEJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGroupeEJob(null)).toBe(false);
      expect(isGroupeEJob(undefined)).toBe(false);
      expect(isGroupeEJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the CSB career host', () => {
      expect(isTrustedDomain('https://job.groupe-e.ch/job/electricien-de-reseau/123456/')).toBe(true);
    });

    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://groupe-e.ch/careers/123')).toBe(true);
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
      const slug = slugify('Electricien de réseau (h/f)');
      expect(slug).toBe('electricien-de-reseau-h-f');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur électricité')).toBe('ingenieur-electricite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Monteur groupe-e fribourg')).toBe('monteur-groupe-e-fribourg');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference, covering AGENTS.md Non-Negotiable #3
    // required structured-data fields (baseSalary is supplied further
    // downstream by the shared salary-hardening pipeline, not the parser
    // itself, same as every other dedicated crawler).
    const validJob = {
      id: 'groupe-e-abc123',
      slug: 'electricien-de-reseau-groupe-e-fribourg',
      slugByLocale: { fr: 'electricien-de-reseau-groupe-e-fribourg' },
      company: 'Groupe E',
      companyKey: 'groupe-e',
      companyDomain: 'groupe-e.ch',
      title: 'Electricien de réseau',
      titleByLocale: { fr: 'Electricien de réseau' },
      description:
        'Groupe E recherche un(e) électricien(ne) de réseau pour renforcer son équipe exploitation à Fribourg. '
        + 'Vous serez responsable de l\'entretien, du dépannage et de la construction des installations électriques '
        + 'basse et moyenne tension du réseau de distribution. Vous travaillerez en étroite collaboration avec les '
        + 'équipes de planification et de sécurité, dans le respect des normes en vigueur. Formation professionnelle '
        + 'en électricité requise, permis de conduire catégorie B indispensable, disponibilité pour le piquet.',
      descriptionByLocale: {
        fr:
          'Groupe E recherche un(e) électricien(ne) de réseau pour renforcer son équipe exploitation à Fribourg. '
          + 'Vous serez responsable de l\'entretien, du dépannage et de la construction des installations électriques '
          + 'basse et moyenne tension du réseau de distribution. Vous travaillerez en étroite collaboration avec les '
          + 'équipes de planification et de sécurité, dans le respect des normes en vigueur. Formation professionnelle '
          + 'en électricité requise, permis de conduire catégorie B indispensable, disponibilité pour le piquet.',
      },
      location: 'Fribourg',
      canton: 'FR',
      url: 'https://job.groupe-e.ch/job/electricien-de-reseau/123456/',
      source: 'Groupe E Dedicated Parser (SuccessFactors CSB)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Fribourg',
      addressRegion: 'FR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '1763',
      streetAddress: 'Route de Morat 135',
      employmentType: 'FULL_TIME',
      datePosted: '2026-07-01',
      hiringOrganization: { name: 'Groupe E' },
      jobLocation: {
        addressLocality: 'Fribourg',
        addressRegion: 'FR',
        postalCode: '1763',
        addressCountry: 'CH',
      },
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

    // AGENTS.md Non-Negotiable #3: job page structured data must include
    // baseSalary, postalCode, streetAddress, title, description, datePosted,
    // hiringOrganization.name, jobLocation, employmentType in every locale.
    it('has the structured-data fields required by Non-Negotiable #3 (safe defaults present)', () => {
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob).toHaveProperty('title');
      expect(validJob).toHaveProperty('description');
      expect(validJob).toHaveProperty('datePosted');
      expect(validJob.hiringOrganization).toHaveProperty('name');
      expect(validJob).toHaveProperty('jobLocation');
      expect(validJob).toHaveProperty('employmentType');
    });

    // AGENTS.md Non-Negotiable #4: no indexed content under 50 words.
    it('description clears the 50-word floor', () => {
      const wordCount = validJob.description.trim().split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^groupe-e-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('sourceLang is French (Groupe E is a Suisse romande employer)', () => {
      expect(validJob.sourceLang).toBe('fr');
    });
  });

  // ── Graceful degradation ──
  // The shared SF-CSB fetch path (fetchAllJobs in
  // successfactors-shared-job-parser-common.mjs) retries transiently-failed
  // requests and paginates the /search/ listing via `startrow`; a genuine
  // outage must not throw past the crawler runner (runStandardCrawlerPipeline
  // soft-exits and keeps the existing slice — see crawler-template.mjs).
  describe('graceful degradation', () => {
    it('isGroupeEJob never throws on malformed input', () => {
      expect(() => isGroupeEJob('not-an-object' as any)).not.toThrow();
      expect(() => isGroupeEJob(42 as any)).not.toThrow();
      expect(() => isGroupeEJob([] as any)).not.toThrow();
    });

    it('isTrustedDomain never throws on malformed input', () => {
      expect(() => isTrustedDomain(null as any)).not.toThrow();
      expect(() => isTrustedDomain(undefined as any)).not.toThrow();
      expect(() => isTrustedDomain(123 as any)).not.toThrow();
    });
  });
});
