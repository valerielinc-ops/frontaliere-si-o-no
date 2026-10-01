import { describe, it, expect } from 'vitest';
import {
  PANTR_CH_KEY,
  PANTR_CH_COMPANY_NAME,
  PANTR_CH_SECTOR,
  isPantrChJob,
  isTrustedDomain,
  buildPantrChJobFromListing,
} from '../scripts/lib/pantr-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Pantr GmbH crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PANTR_CH_KEY).toBe('pantr-ch');
    expect(PANTR_CH_COMPANY_NAME).toBe('Pantr GmbH');
  });

  // ── isCompanyJob ──
  describe('isPantrChJob', () => {
    it('matches by companyKey', () => {
      expect(isPantrChJob({ companyKey: 'pantr-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPantrChJob({ company: 'Pantr GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPantrChJob({ url: 'https://pantr.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPantrChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPantrChJob(null)).toBe(false);
      expect(isPantrChJob(undefined)).toBe(false);
      expect(isPantrChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pantr.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.pantr.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('job slug identity', () => {
    const validDescription = Array.from({ length: 50 }, (_, index) => `description${index + 1}`).join(' ');

    const listing = (url: string) => ({
      title: 'Software Engineer',
      description: validDescription,
      location: 'Lugano, TI',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      addressCountry: 'CH',
      url,
    });

    it('rejects descriptions below the 50-word source floor', () => {
      const thinDescription = Array.from({ length: 49 }, (_, index) => `word${index + 1}`).join(' ');

      expect(buildPantrChJobFromListing({
        ...listing('https://pantr.ch/jobs/thin-description'),
        description: thinDescription,
      })).toBeNull();
    });

    it('disambiguates repeated titles at one location with a stable URL suffix', () => {
      const first = buildPantrChJobFromListing(listing('https://pantr.ch/jobs/role-101'));
      const second = buildPantrChJobFromListing(listing('https://pantr.ch/jobs/role-202'));
      const rerun = buildPantrChJobFromListing(listing('https://pantr.ch/jobs/role-101'));

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.slug).not.toBe(second?.slug);
      expect(first?.slugByLocale[first?.sourceLang || 'de'])
        .not.toBe(second?.slugByLocale[second?.sourceLang || 'de']);
      expect(first?.slugByLocale).toEqual({ [first?.sourceLang || 'de']: first?.slug });
      expect(rerun?.slug).toBe(first?.slug);
      expect(rerun?.slugByLocale).toEqual(first?.slugByLocale);
      expect(first?.slugDisambiguator).toBe(rerun?.slugDisambiguator);
    });

    it('does not classify ordinary it/sr prefixes as job levels and retains the evidenced sector', () => {
      const italian = buildPantrChJobFromListing({
        ...listing('https://pantr.ch/jobs/italian-specialist'),
        title: 'Italian Product Specialist',
      });
      const sriracha = buildPantrChJobFromListing({
        ...listing('https://pantr.ch/jobs/sriracha-specialist'),
        title: 'Sriracha Product Specialist',
      });

      expect(italian?.category).toBe('Altro');
      expect(sriracha?.experienceLevel).toBe('mid');
      expect(italian?.sector).toBe(PANTR_CH_SECTOR);
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
      expect(slugify('Developer pantr-ch ch')).toBe('developer-pantr-ch-ch');
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
      id: 'pantr-ch-abc123',
      slug: 'test-position-pantr-ch-ch',
      slugByLocale: { de: 'test-position-pantr-ch-ch' },
      company: 'Pantr GmbH',
      companyKey: 'pantr-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://pantr.ch/jobs/test',
      source: 'Pantr GmbH Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^pantr-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
