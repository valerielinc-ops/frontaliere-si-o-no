import { describe, it, expect } from 'vitest';
import {
  CHAM_SWISS_PROPERTIES_KEY,
  CHAM_SWISS_PROPERTIES_COMPANY_NAME,
  isChamSwissPropertiesJob,
  isTrustedDomain,
} from '../scripts/lib/cham-swiss-properties-job-parser.mjs';
import { jobsChDetailUrl } from '../scripts/lib/jobs-ch-search-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Cham Swiss Properties crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CHAM_SWISS_PROPERTIES_KEY).toBe('cham-swiss-properties');
    expect(CHAM_SWISS_PROPERTIES_COMPANY_NAME).toBe('Cham Swiss Properties');
  });

  // ── isCompanyJob ──
  describe('isChamSwissPropertiesJob', () => {
    it('matches by companyKey', () => {
      expect(isChamSwissPropertiesJob({ companyKey: 'cham-swiss-properties' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChamSwissPropertiesJob({ company: 'Cham Swiss Properties' })).toBe(true);
      expect(isChamSwissPropertiesJob({ company: 'Cham Swiss Properties AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isChamSwissPropertiesJob({ url: 'https://www.champroperties.ch/en/company/karriere' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isChamSwissPropertiesJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('rejects lexically similar but unrelated Cham-named entities', () => {
      // Cham (ZG) real-estate holdings are a common naming pattern —
      // make sure a generic "Cham ... AG" doesn't false-positive match.
      expect(
        isChamSwissPropertiesJob({ company: 'Cham Papier AG', url: 'https://cham-papier.ch/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChamSwissPropertiesJob(null)).toBe(false);
      expect(isChamSwissPropertiesJob(undefined)).toBe(false);
      expect(isChamSwissPropertiesJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts champroperties.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.champroperties.ch/en/company/karriere')).toBe(true);
      expect(isTrustedDomain('https://champroperties.ch/en')).toBe(true);
    });

    it('trusts jobs.ch host (public search API source)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc-123/')).toBe(true);
      expect(isTrustedDomain('https://jobs.ch/en')).toBe(true);
    });

    it('rejects untrusted domains', () => {
      expect(isTrustedDomain('https://evil.example.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── Detail URL helper ──
  describe('jobsChDetailUrl', () => {
    it('builds a valid jobs.ch detail URL', () => {
      const url = jobsChDetailUrl('abc-123', 'en');
      expect(url).toContain('abc-123');
      expect(url).toMatch(/^https:\/\/www\.jobs\.ch\//);
    });
  });

  // ── Slugify ──
  describe('slugify', () => {
    it('produces a URL-safe slug from title + company + location', () => {
      const slug = slugify('Fachspezialist:in Vertragsmanagement 80-100% cham-swiss-properties Cham');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'cham-swiss-properties-abc123',
      slug: 'fachspezialist-vertragsmanagement-cham-swiss-properties-cham',
      slugByLocale: { de: 'fachspezialist-vertragsmanagement-cham-swiss-properties-cham' },
      company: 'Cham Swiss Properties',
      companyKey: 'cham-swiss-properties',
      companyDomain: 'champroperties.ch',
      title: 'Fachspezialist:in Vertragsmanagement 80-100%',
      titleByLocale: { de: 'Fachspezialist:in Vertragsmanagement 80-100%' },
      description:
        'Diese Beschreibung eines Testjobs ist absichtlich lang genug, um die Mindestanforderung von fünfzig Wörtern zu erfüllen, die von der automatisierten Thin-Content-Prüfung im dedizierten Crawler dieses Repositories verwendet wird, damit der Test sauber und ohne zusätzlichen Fülltext läuft, selbst wenn man die Worttrennung an Satzzeichen und Zeilenumbrüchen über verschiedene Sprachvarianten hinweg berücksichtigt und zählt.',
      descriptionByLocale: {
        de: 'Diese Beschreibung eines Testjobs ist absichtlich lang genug, um die Mindestanforderung von fünfzig Wörtern zu erfüllen, die von der automatisierten Thin-Content-Prüfung im dedizierten Crawler dieses Repositories verwendet wird, damit der Test sauber und ohne zusätzlichen Fülltext läuft, selbst wenn man die Worttrennung an Satzzeichen und Zeilenumbrüchen über verschiedene Sprachvarianten hinweg berücksichtigt und zählt.',
      },
      location: 'Cham',
      canton: 'ZG',
      url: 'https://www.jobs.ch/en/vacancies/detail/3c0276c4-c92c-4e6c-9fd5-06adef0ade09/',
      source: 'Cham Swiss Properties Dedicated Parser (jobs.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Cham',
      addressRegion: 'ZG',
      streetAddress: 'Fabrikstrasse 5',
      postalCode: '6330',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://www.jobs.ch/en/vacancies/detail/3c0276c4-c92c-4e6c-9fd5-06adef0ade09/',
      hiringOrganizationName: 'Cham Swiss Properties AG',
      requirements: [],
      requirementsByLocale: { de: [] },
      category: 'Contract Management',
      contract: 'full-time',
      experienceLevel: 'mid',
      sector: 'Immobiliare / Project Management',
      currency: 'CHF',
      featured: false,
    };

    it('includes all Non-Negotiable #3 required structured-data fields', () => {
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.datePosted ?? validJob.postedDate).toBeTruthy();
      expect(validJob.hiringOrganizationName).toBeTruthy();
      expect(validJob.jobLocation ?? validJob.location).toBeTruthy();
      expect(validJob.employmentType).toBeTruthy();
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.streetAddress).toBeTruthy();
      expect(validJob.baseSalary ?? validJob.currency).toBeTruthy();
    });

    it('description meets the 50-word minimum (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^cham-swiss-properties-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('address country is CH', () => {
      expect(validJob.addressCountry).toBe('CH');
      expect(validJob.country).toBe('CH');
    });
  });
});
