import { describe, it, expect, vi } from 'vitest';
import {
  SPITAL_THURGAU_KEY,
  SPITAL_THURGAU_COMPANY_NAME,
  isSpitalThurgauJob,
  isTrustedDomain,
  parseStgagEmbeddedJson,
} from '../scripts/lib/spital-thurgau-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Spital Thurgau (STGAG) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPITAL_THURGAU_KEY).toBe('spital-thurgau');
    expect(SPITAL_THURGAU_COMPANY_NAME).toBe('Spital Thurgau (STGAG)');
  });

  // ── isCompanyJob ──
  describe('isSpitalThurgauJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalThurgauJob({ companyKey: 'spital-thurgau' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSpitalThurgauJob({ company: 'Spital Thurgau (STGAG)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSpitalThurgauJob({ url: 'https://stgag.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpitalThurgauJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpitalThurgauJob(null)).toBe(false);
      expect(isSpitalThurgauJob(undefined)).toBe(false);
      expect(isSpitalThurgauJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stgag.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stgag.ch/job/456')).toBe(true);
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
      expect(slugify('Developer spital-thurgau ch')).toBe('developer-spital-thurgau-ch');
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
      id: 'spital-thurgau-abc123',
      slug: 'test-position-spital-thurgau-ch',
      slugByLocale: { de: 'test-position-spital-thurgau-ch' },
      company: 'Spital Thurgau (STGAG)',
      companyKey: 'spital-thurgau',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stgag.ch/jobs/test',
      source: 'Spital Thurgau (STGAG) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^spital-thurgau-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── parseStgagEmbeddedJson — JSON-envelope shape guard (#1666) ──
  // STGAG double-encodes: the `<script data-name="jobs">` block is JSON whose
  // `jobs` field is itself a JSON STRING of the job array. A drift in either
  // layer must surface as a LOUD warn, not a silent drop-to-0.
  describe('parseStgagEmbeddedJson — shape guard', () => {
    const wrap = (inner: string) =>
      `<html><body><script data-name="jobs" type="application/json" class="embedded-json-data">${inner}</script></body></html>`;

    it('parses the double-encoded jobs string into the array (happy path, no warn)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const jobsArr = [{ id: '1', title: 'Pflegefachperson' }];
      const html = wrap(JSON.stringify({ count: 1, jobs: JSON.stringify(jobsArr) }));
      expect(parseStgagEmbeddedJson(html)).toEqual(jobsArr);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('handles a plain (non-double-encoded) jobs array too (no warn)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const jobsArr = [{ id: '2', title: 'Arzt' }];
      const html = wrap(JSON.stringify({ count: 1, jobs: jobsArr }));
      expect(parseStgagEmbeddedJson(html)).toEqual(jobsArr);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('warns LOUDLY when the embed block is missing (markup drift, not empty board)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseStgagEmbeddedJson('<html><body>no jobs widget</body></html>')).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('spital-thurgau');
      spy.mockRestore();
    });

    it('warns when the embedded jobs string no longer parses as JSON', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = wrap(JSON.stringify({ count: 1, jobs: '{not json' }));
      expect(parseStgagEmbeddedJson(html)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('spital-thurgau');
      spy.mockRestore();
    });

    it('warns when jobs is neither a string nor an array (renamed/error envelope)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = wrap(JSON.stringify({ count: 0, postings: [] }));
      expect(parseStgagEmbeddedJson(html)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('spital-thurgau');
      spy.mockRestore();
    });
  });
});
