import { describe, it, expect } from 'vitest';
import {
  BRACK_ALLTRON_KEY,
  BRACK_ALLTRON_COMPANY_NAME,
  isBrackAlltronJob,
  isTrustedDomain,
} from '../scripts/lib/brack-alltron-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Brack.Alltron AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BRACK_ALLTRON_KEY).toBe('brack-alltron');
    expect(BRACK_ALLTRON_COMPANY_NAME).toBe('Brack.Alltron AG');
  });

  // ── isCompanyJob ──
  describe('isBrackAlltronJob', () => {
    it('matches by companyKey', () => {
      expect(isBrackAlltronJob({ companyKey: 'brack-alltron' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBrackAlltronJob({ company: 'Brack.Alltron AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBrackAlltronJob({ url: 'https://brack.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBrackAlltronJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBrackAlltronJob(null)).toBe(false);
      expect(isBrackAlltronJob(undefined)).toBe(false);
      expect(isBrackAlltronJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://brack.ch/unternehmen/jobs')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.brack.ch/offene-stellen/123')).toBe(true);
    });

    it('trusts the Prospective.ch board host', () => {
      expect(isTrustedDomain('https://jobs.brackalltron.ch/offene-stellen/senior-software-engineer/abc')).toBe(true);
    });

    it('trusts the Alltron and Competec corporate domains', () => {
      expect(isTrustedDomain('https://alltron.ch/de/logistikzentrum')).toBe(true);
      expect(isTrustedDomain('https://jobs.competec.ch/offene-stellen/123')).toBe(true);
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
      expect(slugify('Logistician brack-alltron ch')).toBe('logistician-brack-alltron-ch');
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
      id: 'brack-alltron-abc123',
      slug: 'test-position-brack-alltron-ag-maegenwil',
      slugByLocale: { de: 'test-position-brack-alltron-ag-maegenwil' },
      company: 'Brack.Alltron AG',
      companyKey: 'brack-alltron',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Mägenwil',
      canton: 'AG',
      postalCode: '5506',
      streetAddress: 'Hintermättlistrasse 3',
      url: 'https://jobs.brackalltron.ch/offene-stellen/test-position/abc',
      source: 'Brack.Alltron AG Dedicated Parser (Prospective medium 1005615)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'postalCode', 'streetAddress',
        'url', 'source', 'sourceLang', 'crawledAt',
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
      expect(validJob.id).toMatch(/^brack-alltron-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
