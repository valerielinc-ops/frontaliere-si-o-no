import { describe, it, expect } from 'vitest';
import {
  ETH_ZURICH_KEY,
  ETH_ZURICH_COMPANY_NAME,
  isEthZurichJob,
  isTrustedDomain,
} from '../scripts/lib/eth-zurich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('ETH Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ETH_ZURICH_KEY).toBe('eth-zurich');
    expect(ETH_ZURICH_COMPANY_NAME).toBe('ETH Zürich');
  });

  // ── isCompanyJob ──
  describe('isEthZurichJob', () => {
    it('matches by companyKey', () => {
      expect(isEthZurichJob({ companyKey: 'eth-zurich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEthZurichJob({ company: 'ETH Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEthZurichJob({ url: 'https://ethzurich.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEthZurichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEthZurichJob(null)).toBe(false);
      expect(isEthZurichJob(undefined)).toBe(false);
      expect(isEthZurichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ethzurich.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ethzurich.ch/job/456')).toBe(true);
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
      expect(slugify('Developer eth-zurich ch')).toBe('developer-eth-zurich-ch');
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
      id: 'eth-zurich-abc123',
      slug: 'test-position-eth-zurich-ch',
      slugByLocale: { it: 'test-position-eth-zurich-ch' },
      company: 'ETH Zürich',
      companyKey: 'eth-zurich',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ethzurich.ch/jobs/test',
      source: 'ETH Zürich Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^eth-zurich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
