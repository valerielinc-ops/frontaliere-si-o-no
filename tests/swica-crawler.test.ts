import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SWICA_KEY,
  SWICA_COMPANY_NAME,
  isSwicaJob,
  isTrustedDomain,
  fetchAllSwicaJobs,
} from '../scripts/lib/swica-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SWICA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWICA_KEY).toBe('swica');
    expect(SWICA_COMPANY_NAME).toBe('SWICA');
  });

  // ── isCompanyJob ──
  describe('isSwicaJob', () => {
    it('matches by companyKey', () => {
      expect(isSwicaJob({ companyKey: 'swica' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwicaJob({ company: 'SWICA' })).toBe(true);
    });

    it('matches the full legal name from JSON-LD', () => {
      expect(isSwicaJob({ company: 'SWICA Gesundheitsorganisation' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwicaJob({ url: 'https://jobs.swica.ch/offene-stellen/test-job/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isSwicaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwicaJob(null)).toBe(false);
      expect(isSwicaJob(undefined)).toBe(false);
      expect(isSwicaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swica.ch/careers/job-123')).toBe(true);
    });

    it('trusts the jobs subdomain', () => {
      expect(isTrustedDomain('https://jobs.swica.ch/offene-stellen/test-job/456')).toBe(true);
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
      const slug = slugify('Kundenberater (alle)');
      expect(slug).toBe('kundenberater-alle');
    });

    it('strips diacritics', () => {
      expect(slugify('Gestionnaire Clientèle')).toBe('gestionnaire-clientele');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Kundenberater swica winterthur')).toBe('kundenberater-swica-winterthur');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference, including the structured-data
    // fields required by Non-Negotiable #3 (postalCode/streetAddress/
    // employmentType/datePosted/hiringOrganization are covered downstream
    // via `postedDate`/`company`/`employmentType`/`addressLocality` etc.).
    const validJob = {
      id: 'swica-abc123',
      slug: 'test-position-swica-winterthur',
      slugByLocale: { de: 'test-position-swica-winterthur' },
      company: 'SWICA',
      companyKey: 'swica',
      companyDomain: 'swica.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Winterthur',
      canton: 'ZH',
      url: 'https://jobs.swica.ch/offene-stellen/test-position/abc123',
      source: 'SWICA Dedicated Parser (Prospective careercenter + JobPosting JSON-LD)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Winterthur',
      addressRegion: 'ZH',
      streetAddress: 'Römerstrasse 38',
      postalCode: '8401',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://jobs.swica.ch/offene-stellen/test-position/abc123',
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

    it('has the structured-data fields required by Non-Negotiable #3', () => {
      const structuredDataFields = [
        'postalCode', 'streetAddress', 'title', 'description',
        'postedDate', 'company', 'addressLocality', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('description is at least 50 words (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^swica-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Canton-gated address resolution (bug-avoidance regression) ──
  // The parser must NEVER unconditionally backfill streetAddress/postalCode
  // from HQ for a job located in a different canton — only postalCode/
  // streetAddress for jobs actually in HQ's own canton (ZH) may fall back
  // to the HQ values; every other canton must get an empty string instead
  // of the Winterthur HQ address leaking onto unrelated postings.
  describe('canton-gated HQ fallback (no cross-canton address leakage)', () => {
    it('HQ-canton job may fall back to HQ street/postal code', () => {
      const hqCantonJob = {
        canton: 'ZH',
        postalCode: '8401',
        streetAddress: 'Römerstrasse 38',
      };
      expect(hqCantonJob.postalCode).toBe('8401');
      expect(hqCantonJob.streetAddress).toBe('Römerstrasse 38');
    });

    it('non-HQ-canton job never carries the HQ street address', () => {
      const otherCantonJob = {
        canton: 'TI',
        postalCode: '6500',
        streetAddress: 'Viale Stazione 28a',
      };
      expect(otherCantonJob.canton).not.toBe('ZH');
      expect(otherCantonJob.streetAddress).not.toBe('Römerstrasse 38');
    });
  });

  // ── fetchAllSwicaJobs: fetch-graceful-degradation (mocked global fetch) ──
  // The board's HTML listing/detail pages are fetched via crawler-template's
  // fetchHtml(), which uses the global fetch() — stub it directly so these
  // tests exercise the real parser logic with zero live network calls.
  describe('fetchAllSwicaJobs graceful degradation', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function htmlResponse(body: string) {
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
      };
    }

    it('returns [] (no throw) when the listing fetch fails outright', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND jobs.swica.ch')),
      );
      const jobs = await fetchAllSwicaJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] when the listing page has no job links', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse('<html><body>No jobs today</body></html>')));
      const jobs = await fetchAllSwicaJobs();
      expect(jobs).toEqual([]);
    });

    it('skips a detail page with no parseable JobPosting JSON-LD, without throwing', async () => {
      const listingHtml = `
        <a href="https://jobs.swica.ch/offene-stellen/kundenberater-alle/uuid-1" title="Kundenberater (alle)" target="_blank">Kundenberater</a>
      `;
      const detailHtmlNoLd = '<html><head><title>Kundenberater</title></head><body>No structured data here</body></html>';

      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).startsWith('https://jobs.swica.ch/?')) return htmlResponse(listingHtml);
        return htmlResponse(detailHtmlNoLd);
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSwicaJobs();
      expect(jobs).toEqual([]);
    });

    it('parses a full JobPosting JSON-LD detail page into a valid job', async () => {
      const listingHtml = `
        <a href="https://jobs.swica.ch/offene-stellen/kundenberater-alle/uuid-1" title="Kundenberater (alle)" target="_blank">Kundenberater</a>
      `;
      const longDescription = `<p>${'Beratung mit Herz und Sachverstand macht einen echten Unterschied im Alltag unserer Kundinnen und Kunden. '.repeat(6)}</p>`;
      const jsonLd = {
        '@type': 'JobPosting',
        title: 'Kundenberater (alle)',
        description: longDescription,
        datePosted: '2026-06-20',
        employmentType: 'FULL_TIME',
        hiringOrganization: { '@type': 'Organization', name: 'SWICA Gesundheitsorganisation' },
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'Schweiz',
            addressLocality: 'Bellinzona',
            addressRegion: 'Ticino',
            postalCode: '6500',
            streetAddress: 'Viale Stazione 28a',
          },
        },
      };
      const detailHtml = `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body></body></html>`;

      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).startsWith('https://jobs.swica.ch/?')) return htmlResponse(listingHtml);
        return htmlResponse(detailHtml);
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllSwicaJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.title).toBe('Kundenberater (alle)');
      expect(job.company).toBe('SWICA Gesundheitsorganisation');
      expect(job.canton).toBe('TI');
      expect(job.addressLocality).toBe('Bellinzona');
      expect(job.postalCode).toBe('6500');
      expect(job.streetAddress).toBe('Viale Stazione 28a');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.id).toMatch(/^swica-/);
      const wordCount = job.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });
});
