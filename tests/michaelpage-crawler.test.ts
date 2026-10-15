import { describe, it, expect } from 'vitest';
import {
  MICHAELPAGE_KEY,
  MICHAELPAGE_COMPANY_NAME,
  isMichaelpageJob,
  isTrustedDomain,
} from '../scripts/lib/michaelpage-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('Michael Page crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MICHAELPAGE_KEY).toBe('michaelpage');
    expect(MICHAELPAGE_COMPANY_NAME).toBe('Michael Page');
  });

  // ── isCompanyJob ──
  describe('isMichaelpageJob', () => {
    it('matches by companyKey', () => {
      expect(isMichaelpageJob({ companyKey: 'michaelpage' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMichaelpageJob({ company: 'Michael Page' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMichaelpageJob({ url: 'https://pageexecutive.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMichaelpageJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMichaelpageJob(null)).toBe(false);
      expect(isMichaelpageJob(undefined)).toBe(false);
      expect(isMichaelpageJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pageexecutive.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.pageexecutive.com/job/456')).toBe(true);
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
      expect(slugify('Developer michaelpage ch')).toBe('developer-michaelpage-ch');
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
      id: 'michaelpage-abc123',
      slug: 'test-position-michaelpage-ch',
      slugByLocale: { en: 'test-position-michaelpage-ch' },
      company: 'Michael Page',
      companyKey: 'michaelpage',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://pageexecutive.com/jobs/test',
      source: 'Michael Page Dedicated Parser',
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
      expect(validJob.id).toMatch(/^michaelpage-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  it('preserves distinct IDs, slugs and history for postings sharing the same month tag', () => {
    const urls = [
      'https://www.pageexecutive.com/job-detail/head-legal/ref/jn-082026-7087025',
      'https://www.pageexecutive.com/job-detail/chief-operating-officer/ref/jn-082026-7089682',
    ];
    const existing = urls.map((url, index) => ({
      id: `legacy-${index + 1}`,
      url,
      sourceLang: 'en',
      title: `Role ${index + 1}`,
      titleByLocale: { en: `Role ${index + 1}` },
      description: `Authoritative description for role ${index + 1} with enough stable words for the merge.`,
      descriptionByLocale: { en: `Authoritative description for role ${index + 1} with enough stable words for the merge.` },
      slug: `published-role-${index + 1}`,
      slugByLocale: { en: `published-role-${index + 1}` },
      previousSlugs: [`older-role-${index + 1}`],
    }));
    const fresh = existing.map((job, index) => ({
      ...structuredClone(job),
      id: `fresh-${index + 1}`,
      previousSlugs: [],
    }));

    const merged = mergePreserveLocaleData(existing, fresh);
    expect(merged.map((job) => job.id)).toEqual(['legacy-1', 'legacy-2']);
    expect(merged.map((job) => job.slug)).toEqual(['published-role-1', 'published-role-2']);
    expect(merged.map((job) => job.previousSlugs)).toEqual([['older-role-1'], ['older-role-2']]);
  });
});
