import { describe, it, expect } from 'vitest';
import {
  VTMPERSONAL_CH_KEY,
  VTMPERSONAL_CH_COMPANY_NAME,
  isVtmpersonalChJob,
  isTrustedDomain,
} from '../scripts/lib/vtmpersonal-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('VTM Dienstleistung AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VTMPERSONAL_CH_KEY).toBe('vtmpersonal-ch');
    expect(VTMPERSONAL_CH_COMPANY_NAME).toBe('VTM Dienstleistung AG');
  });

  // ── isCompanyJob ──
  describe('isVtmpersonalChJob', () => {
    it('matches by companyKey', () => {
      expect(isVtmpersonalChJob({ companyKey: 'vtmpersonal-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVtmpersonalChJob({ company: 'VTM Dienstleistung AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVtmpersonalChJob({ url: 'https://vtmpersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVtmpersonalChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
      expect(isVtmpersonalChJob({ companyKey: 'other', company: 'Other GmbH', url: 'https://other.example/jobs?ref=vtmpersonal.ch' })).toBe(false);
      expect(isVtmpersonalChJob({ companyKey: 'other', company: 'Other GmbH', url: 'https://other.example/vtmpersonal.ch/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVtmpersonalChJob(null)).toBe(false);
      expect(isVtmpersonalChJob(undefined)).toBe(false);
      expect(isVtmpersonalChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vtmpersonal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vtmpersonal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer vtmpersonal-ch ch')).toBe('developer-vtmpersonal-ch-ch');
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
      id: 'vtmpersonal-ch-abc123',
      slug: 'test-position-vtmpersonal-ch-ch',
      slugByLocale: { de: 'test-position-vtmpersonal-ch-ch' },
      company: 'VTM Dienstleistung AG',
      companyKey: 'vtmpersonal-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vtmpersonal.ch/jobs/test',
      source: 'VTM Dienstleistung AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^vtmpersonal-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
