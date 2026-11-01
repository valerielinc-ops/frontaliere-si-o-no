import { describe, it, expect } from 'vitest';
import {
  BODMERFISCHER_CH_KEY,
  BODMERFISCHER_CH_COMPANY_NAME,
  isBodmerfischerChJob,
  isTrustedDomain,
} from '../scripts/lib/bodmerfischer-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('BodmerFischer AG – Rechtsanwälte crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BODMERFISCHER_CH_KEY).toBe('bodmerfischer-ch');
    expect(BODMERFISCHER_CH_COMPANY_NAME).toBe('BodmerFischer AG – Rechtsanwälte');
  });

  // ── isCompanyJob ──
  describe('isBodmerfischerChJob', () => {
    it('matches by companyKey', () => {
      expect(isBodmerfischerChJob({ companyKey: 'bodmerfischer-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBodmerfischerChJob({ company: 'BodmerFischer AG – Rechtsanwälte' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBodmerfischerChJob({ url: 'https://weblaw.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBodmerfischerChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBodmerfischerChJob(null)).toBe(false);
      expect(isBodmerfischerChJob(undefined)).toBe(false);
      expect(isBodmerfischerChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://weblaw.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.weblaw.ch/job/456')).toBe(true);
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
      expect(slugify('Developer bodmerfischer-ch ch')).toBe('developer-bodmerfischer-ch-ch');
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
      id: 'bodmerfischer-ch-abc123',
      slug: 'test-position-bodmerfischer-ch-ch',
      slugByLocale: { de: 'test-position-bodmerfischer-ch-ch' },
      company: 'BodmerFischer AG – Rechtsanwälte',
      companyKey: 'bodmerfischer-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://weblaw.ch/jobs/test',
      source: 'BodmerFischer AG – Rechtsanwälte Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bodmerfischer-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
