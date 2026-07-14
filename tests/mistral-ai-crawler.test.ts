import { describe, it, expect } from 'vitest';
import {
  MISTRAL_AI_KEY,
  MISTRAL_AI_COMPANY_NAME,
  isMistralAiJob,
  isTrustedDomain,
  isSwissAshbyJob,
  pickSwissLocationLabel,
  ashbyLocationEntries,
} from '../scripts/lib/mistral-ai-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Mistral AI crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MISTRAL_AI_KEY).toBe('mistral-ai');
    expect(MISTRAL_AI_COMPANY_NAME).toBe('Mistral AI');
  });

  // ── isCompanyJob ──
  describe('isMistralAiJob', () => {
    it('matches by companyKey', () => {
      expect(isMistralAiJob({ companyKey: 'mistral-ai' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMistralAiJob({ company: 'Mistral AI' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMistralAiJob({ url: 'https://mistral.ai/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMistralAiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMistralAiJob(null)).toBe(false);
      expect(isMistralAiJob(undefined)).toBe(false);
      expect(isMistralAiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://mistral.ai/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.mistral.ai/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('trusts the Ashby job board (post-Lever migration, #4145)', () => {
      expect(
        isTrustedDomain('https://jobs.ashbyhq.com/mistral.ai/865fced4-d279-4073-848d-f078c0053155'),
      ).toBe(true);
      expect(isTrustedDomain('https://jobs.ashbyhq.com/mistral.ai')).toBe(true);
    });

    it('rejects a different company on the same Ashby host', () => {
      expect(isTrustedDomain('https://jobs.ashbyhq.com/openai/abc')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── Ashby Swiss-location filtering (post-Lever migration, #4145) ──
  describe('Swiss location filtering', () => {
    const zurichPrimary = {
      title: 'AI Scientist',
      location: 'Zurich',
      secondaryLocations: [],
      address: { postalAddress: { addressCountry: 'Switzerland' } },
    };
    const zurichSecondary = {
      title: 'Research Engineer, Machine Learning',
      location: 'Paris',
      address: { postalAddress: { addressCountry: 'France', addressLocality: 'Paris' } },
      secondaryLocations: [
        { location: 'Zurich', address: { postalAddress: { addressCountry: 'Switzerland' } } },
        { location: 'Warsaw', address: { postalAddress: { addressCountry: 'Poland' } } },
      ],
    };
    const parisOnly = {
      title: 'Software Engineer',
      location: 'Paris',
      address: { postalAddress: { addressCountry: 'France', addressLocality: 'Paris' } },
      secondaryLocations: [
        { location: 'London', address: { postalAddress: { addressCountry: 'United Kingdom' } } },
      ],
    };

    it('matches a role whose PRIMARY location is Swiss', () => {
      expect(isSwissAshbyJob(zurichPrimary)).toBe(true);
    });

    it('matches a role whose SECONDARY office is Swiss', () => {
      expect(isSwissAshbyJob(zurichSecondary)).toBe(true);
    });

    it('rejects a role with no Swiss office', () => {
      expect(isSwissAshbyJob(parisOnly)).toBe(false);
      expect(isSwissAshbyJob({})).toBe(false);
    });

    it('surfaces the Swiss location label over a non-Swiss primary', () => {
      expect(pickSwissLocationLabel(zurichSecondary)).toBe('Zurich');
      expect(pickSwissLocationLabel(zurichPrimary)).toBe('Zurich');
    });

    it('flattens primary + secondary locations in order', () => {
      const entries = ashbyLocationEntries(zurichSecondary);
      expect(entries.map((e) => e.location)).toEqual(['Paris', 'Zurich', 'Warsaw']);
    });

    it('matches a Swiss location by city text when address country is absent', () => {
      expect(isSwissAshbyJob({ location: 'Lausanne', secondaryLocations: [] })).toBe(true);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer mistral-ai ch')).toBe('developer-mistral-ai-ch');
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
      id: 'mistral-ai-abc123',
      slug: 'test-position-mistral-ai-ch',
      slugByLocale: { en: 'test-position-mistral-ai-ch' },
      company: 'Mistral AI',
      companyKey: 'mistral-ai',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://mistral.ai/jobs/test',
      source: 'Mistral AI Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^mistral-ai-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
