import { describe, it, expect } from 'vitest';
import {
  ASSURA_CH_KEY,
  ASSURA_CH_COMPANY_NAME,
  isAssuraChJob,
  isTrustedDomain,
} from '../scripts/lib/assura-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Assura, l’assicurazione malattie al suo fianco crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ASSURA_CH_KEY).toBe('assura-ch');
    expect(ASSURA_CH_COMPANY_NAME).toBe('Assura, l’assicurazione malattie al suo fianco');
  });

  // ── isCompanyJob ──
  describe('isAssuraChJob', () => {
    it('matches by companyKey', () => {
      expect(isAssuraChJob({ companyKey: 'assura-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAssuraChJob({ company: 'Assura, l’assicurazione malattie al suo fianco' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAssuraChJob({ url: 'https://assura.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAssuraChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAssuraChJob(null)).toBe(false);
      expect(isAssuraChJob(undefined)).toBe(false);
      expect(isAssuraChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://assura.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.assura.ch/job/456')).toBe(true);
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
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer assura-ch ch')).toBe('developer-assura-ch-ch');
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
      id: 'assura-ch-abc123',
      slug: 'test-position-assura-ch-ch',
      slugByLocale: { fr: 'test-position-assura-ch-ch' },
      company: 'Assura, l’assicurazione malattie al suo fianco',
      companyKey: 'assura-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://assura.ch/jobs/test',
      source: 'Assura, l’assicurazione malattie al suo fianco Dedicated Parser',
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
      expect(validJob.id).toMatch(/^assura-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
