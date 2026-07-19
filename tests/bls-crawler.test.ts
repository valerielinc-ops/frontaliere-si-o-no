import { describe, it, expect } from 'vitest';
import {
  BLS_KEY,
  BLS_COMPANY_NAME,
  isBlsJob,
  isTrustedDomain,
  parseJobsApiResponse,
} from '../scripts/lib/bls-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('BLS AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BLS_KEY).toBe('bls');
    expect(BLS_COMPANY_NAME).toBe('BLS AG');
  });

  // ── isCompanyJob ──
  describe('isBlsJob', () => {
    it('matches by companyKey', () => {
      expect(isBlsJob({ companyKey: 'bls' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBlsJob({ company: 'BLS AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBlsJob({ url: 'https://bls.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBlsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBlsJob(null)).toBe(false);
      expect(isBlsJob(undefined)).toBe(false);
      expect(isBlsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bls.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bls.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseJobsApiResponse (JobsInit JSON API — #4523 fix) ──
  describe('parseJobsApiResponse', () => {
    it('parses Jobs[] entries into listing-entry shape', () => {
      const json = {
        Jobs: [
          {
            Title: 'Kältesystemtechniker: in Lüftung und Klima',
            Lead: 'Frutigen, 80-100%',
            Category: 'Skilled manual jobs',
            Region: 'Frutigen',
            URL: 'https://jobs.bls.ch/offene-stellen/kaeltesystemtechniker-in-lueftung-und-klima/2a7b3bed-4367-4ac7-b091-f2a5cbb4e352',
          },
        ],
      };
      const entries = parseJobsApiResponse(json);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        url: json.Jobs[0].URL,
        slug: 'kaeltesystemtechniker-in-lueftung-und-klima',
        uuid: '2a7b3bed-4367-4ac7-b091-f2a5cbb4e352',
        title: 'Kältesystemtechniker: in Lüftung und Klima',
        locationRaw: 'Frutigen',
        pensum: '80-100%',
      });
    });

    it('parses a single-value pensum (no range)', () => {
      const json = {
        Jobs: [{ Title: 'X', Lead: 'Bern, 100%', URL: 'https://jobs.bls.ch/offene-stellen/x/uuid-1' }],
      };
      expect(parseJobsApiResponse(json)[0].pensum).toBe('100%');
    });

    it('falls back to Region when Lead has no location prefix', () => {
      const json = {
        Jobs: [{ Title: 'X', Lead: '80%', Region: 'Bönigen', URL: 'https://jobs.bls.ch/offene-stellen/x/uuid-2' }],
      };
      expect(parseJobsApiResponse(json)[0].locationRaw).toBe('Bönigen');
    });

    it('skips entries whose URL does not match the offene-stellen detail pattern', () => {
      const json = { Jobs: [{ Title: 'X', Lead: 'Bern, 100%', URL: 'https://jobs.bls.ch/1000754/jobabo?lang=en' }] };
      expect(parseJobsApiResponse(json)).toHaveLength(0);
    });

    it('dedupes by uuid', () => {
      const url = 'https://jobs.bls.ch/offene-stellen/x/uuid-3';
      const json = { Jobs: [{ Title: 'X', Lead: 'Bern, 100%', URL: url }, { Title: 'X dup', Lead: 'Bern, 100%', URL: url }] };
      expect(parseJobsApiResponse(json)).toHaveLength(1);
    });

    it('handles missing/malformed Jobs array gracefully', () => {
      expect(parseJobsApiResponse({})).toEqual([]);
      expect(parseJobsApiResponse(null)).toEqual([]);
      expect(parseJobsApiResponse({ Jobs: null })).toEqual([]);
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
      expect(slugify('Developer bls ch')).toBe('developer-bls-ch');
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
      id: 'bls-abc123',
      slug: 'test-position-bls-ch',
      slugByLocale: { de: 'test-position-bls-ch' },
      company: 'BLS AG',
      companyKey: 'bls',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bls.ch/jobs/test',
      source: 'BLS AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bls-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
