import { describe, it, expect } from 'vitest';
import {
  ETE_KEY,
  ETE_COMPANY_NAME,
  isEteJob,
  isTrustedDomain,
} from '../scripts/lib/ete-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Emil Egger AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ETE_KEY).toBe('ete');
    expect(ETE_COMPANY_NAME).toBe('Emil Egger AG');
  });

  // ── isCompanyJob ──
  describe('isEteJob', () => {
    it('matches by companyKey', () => {
      expect(isEteJob({ companyKey: 'ete' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEteJob({ company: 'Emil Egger AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEteJob({ url: 'https://ete.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEteJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEteJob(null)).toBe(false);
      expect(isEteJob(undefined)).toBe(false);
      expect(isEteJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ete.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ete.ch/job/456')).toBe(true);
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
      expect(slugify('Developer ete ch')).toBe('developer-ete-ch');
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
      id: 'ete-abc123',
      slug: 'test-position-ete-ch',
      slugByLocale: { de: 'test-position-ete-ch' },
      company: 'Emil Egger AG',
      companyKey: 'ete',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ete.ch/jobs/test',
      source: 'Emil Egger AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ete-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
