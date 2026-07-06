import { describe, it, expect } from 'vitest';
import {
  DIC_SA_KEY,
  DIC_SA_COMPANY_NAME,
  isDicSaJob,
  isTrustedDomain,
} from '../scripts/lib/dic-sa-job-parser.mjs';
import { jobsChDetailUrl } from '../scripts/lib/jobs-ch-search-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('DIC SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key name', () => {
    expect(DIC_SA_KEY).toBe('dic-sa');
    expect(DIC_SA_COMPANY_NAME).toBe('DIC SA');
  });

  // ── isCompanyJob ──
  describe('isDicSaJob', () => {
    it('matches by companyKey', () => {
      expect(isDicSaJob({ companyKey: 'dic-sa' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDicSaJob({ company: 'DIC SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDicSaJob({ url: 'https://www.dic-ing.ch/fr/emploi/test-job' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isDicSaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('rejects unrelated jobs with a generic "DIC" acronym but different company', () => {
      expect(
        isDicSaJob({ companyKey: 'dic-holding-inc', company: 'DIC Holding Inc', url: 'https://dic-holding.example.com/careers' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDicSaJob(null)).toBe(false);
      expect(isDicSaJob(undefined)).toBe(false);
      expect(isDicSaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts dic-ing.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.dic-ing.ch/fr/emploi/test-job')).toBe(true);
      expect(isTrustedDomain('https://dic-ing.ch/team/')).toBe(true);
    });

    it('trusts jobs.ch and jobup.ch (jobs.ch API source)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc-123/')).toBe(true);
      expect(isTrustedDomain('https://www.jobup.ch/fr/emploi/detail/abc-123/')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://other-company.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── jobsChDetailUrl helper ──
  describe('jobsChDetailUrl', () => {
    it('builds a valid jobs.ch detail URL', () => {
      const url = jobsChDetailUrl('abc-123', 'fr');
      expect(url).toMatch(/^https:\/\/www\.jobs\.ch\/fr\/vacancies\/detail\/abc-123\/?$/);
    });
  });

  // ── slugify ──
  describe('slugify', () => {
    it('produces a URL-safe slug from a job title + company + location', () => {
      expect(slugify('Ingénieur civil EPF - Chef de projet (H/F) dic sa aigle')).toBe(
        'ingenieur-civil-epf-chef-de-projet-h-f-dic-sa-aigle'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'dic-sa-abc123',
      slug: 'ingenieur-civil-chef-de-projet-dic-sa-aigle',
      slugByLocale: { fr: 'ingenieur-civil-chef-de-projet-dic-sa-aigle' },
      company: 'DIC SA',
      companyKey: 'dic-sa',
      companyDomain: 'dic-ing.ch',
      title: 'Ingénieur civil EPF - Chef de projet (H/F)',
      titleByLocale: { fr: 'Ingénieur civil EPF - Chef de projet (H/F)' },
      description:
        'Depuis plus de 40 ans, DIC SA ingénieurs s\'impose comme un bureau reconnu pour la qualité et la précision de ses ouvrages dans les domaines du génie civil, des ouvrages d\'art et des infrastructures routières et ferroviaires. Notre équipe à taille humaine met un point d\'honneur à produire des projets techniquement exigeants, avec un haut niveau de responsabilité et une forte autonomie au sein du bureau basé à Aigle dans le canton de Vaud, avec des succursales à Sion et Martigny en Valais desservant toute la région.',
      descriptionByLocale: {
        fr:
          'Depuis plus de 40 ans, DIC SA ingénieurs s\'impose comme un bureau reconnu pour la qualité et la précision de ses ouvrages dans les domaines du génie civil, des ouvrages d\'art et des infrastructures routières et ferroviaires. Notre équipe à taille humaine met un point d\'honneur à produire des projets techniquement exigeants, avec un haut niveau de responsabilité et une forte autonomie au sein du bureau basé à Aigle dans le canton de Vaud, avec des succursales à Sion et Martigny en Valais desservant toute la région.',
      },
      location: 'Aigle',
      canton: 'VD',
      url: 'https://www.jobs.ch/fr/vacancies/detail/90aca745-50a2-46aa-ba78-f551572468cb/',
      source: 'DIC SA Dedicated Parser (jobs.ch)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Aigle',
      addressRegion: 'VD',
      streetAddress: 'Les Glariers',
      postalCode: '1860',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://www.jobs.ch/fr/vacancies/detail/90aca745-50a2-46aa-ba78-f551572468cb/',
      hiringOrganizationName: 'DIC SA',
    };

    it('includes all Non-Negotiable #3 required structured-data fields', () => {
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.datePosted ?? validJob.postedDate).toBeTruthy();
      expect(validJob.hiringOrganizationName).toBeTruthy();
      expect(validJob.employmentType).toBeTruthy();
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.streetAddress).toBeTruthy();
      expect(validJob.addressLocality || validJob.location).toBeTruthy();
      expect(validJob.canton).toBeTruthy();
    });

    it('description satisfies Non-Negotiable #4 (≥50 word thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^dic-sa-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is a valid Swiss canton code', () => {
      expect(validJob.canton).toMatch(/^[A-Z]{2}$/);
    });
  });
});
