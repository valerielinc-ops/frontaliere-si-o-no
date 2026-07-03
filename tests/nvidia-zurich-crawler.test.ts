import { describe, it, expect } from 'vitest';
import {
  NVIDIA_ZURICH_KEY,
  NVIDIA_ZURICH_COMPANY_NAME,
  isNvidiaZurichJob,
  isTrustedDomain,
} from '../scripts/lib/nvidia-zurich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('NVIDIA (ufficio Zurich) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NVIDIA_ZURICH_KEY).toBe('nvidia-zurich');
    expect(NVIDIA_ZURICH_COMPANY_NAME).toBe('NVIDIA (ufficio Zurich)');
  });

  // ── isCompanyJob ──
  describe('isNvidiaZurichJob', () => {
    it('matches by companyKey', () => {
      expect(isNvidiaZurichJob({ companyKey: 'nvidia-zurich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNvidiaZurichJob({ company: 'NVIDIA (ufficio Zurich)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNvidiaZurichJob({ url: 'https://nvidia.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNvidiaZurichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNvidiaZurichJob(null)).toBe(false);
      expect(isNvidiaZurichJob(undefined)).toBe(false);
      expect(isNvidiaZurichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://nvidia.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.nvidia.com/job/456')).toBe(true);
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
      expect(slugify('Developer nvidia-zurich ch')).toBe('developer-nvidia-zurich-ch');
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
      id: 'nvidia-zurich-abc123',
      slug: 'test-position-nvidia-zurich-ch',
      slugByLocale: { en: 'test-position-nvidia-zurich-ch' },
      company: 'NVIDIA (ufficio Zurich)',
      companyKey: 'nvidia-zurich',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://nvidia.com/jobs/test',
      source: 'NVIDIA (ufficio Zurich) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^nvidia-zurich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
