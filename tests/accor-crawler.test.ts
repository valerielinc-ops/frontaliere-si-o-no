import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  ACCOR_KEY,
  ACCOR_COMPANY_NAME,
  accorPageCount,
  accorPageUrl,
  collectAccorPageUrls,
  createAccorSnapshotFetch,
  extractAccorDetailFields,
  isAccorJob,
  isTrustedDomain,
} from '../scripts/lib/accor-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const RICH_DETAIL = fs.readFileSync(
  new URL('./__fixtures__/accor/detail-rich.html', import.meta.url),
  'utf8',
);
const DEGRADED_DETAIL = fs.readFileSync(
  new URL('./__fixtures__/accor/detail-degraded.html', import.meta.url),
  'utf8',
);
const DETAIL_URL = 'https://careers.accor.com/fr/fr/job/receptionniste-in-geneva-switzerland-jid-12345';

describe('Ibis Budget crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ACCOR_KEY).toBe('accor');
    expect(ACCOR_COMPANY_NAME).toBe('Ibis Budget');
  });

  // ── isCompanyJob ──
  describe('isAccorJob', () => {
    it('matches by companyKey', () => {
      expect(isAccorJob({ companyKey: 'accor' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAccorJob({ company: 'Ibis Budget' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAccorJob({ url: 'https://careers.accor.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAccorJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAccorJob(null)).toBe(false);
      expect(isAccorJob(undefined)).toBe(false);
      expect(isAccorJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://careers.accor.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.careers.accor.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('Attrax detail boundary', () => {
    it('extracts only the semantic DescriptionWidget body', () => {
      const detail = extractAccorDetailFields(RICH_DETAIL, DETAIL_URL);

      expect(detail.description).toContain('Vous accueillez les clients');
      expect(detail.description).toContain('Garantir un service attentif');
      expect(detail.description).not.toContain('Postuler Partager');
      expect(detail.description).not.toContain('Director in Paris');
      expect(detail).toMatchObject({
        title: 'Réceptionniste (H/F/X)',
        location: 'Genève, GE',
        addressCountry: 'CH',
      });
    });

    it('quarantines a degraded widget instead of promoting surrounding chrome', () => {
      const detail = extractAccorDetailFields(DEGRADED_DETAIL, DETAIL_URL);

      expect(detail.description).toBe('');
      expect(detail.location).toContain('Genève');
    });
  });

  describe('Swiss listing pagination', () => {
    const pagination = (lastPage: number, total = lastPage * 12) => `
      <span class="attrax-pagination__total-results">${total} résultat(s)</span>
      <span class="attrax-pagination__results-of--2">${lastPage}</span>
      <span class="attrax-pagination__resultsperpage"><a class="active" aria-label="12 results per page"></a></span>`;

    it('builds page URLs without changing the Swiss filters', () => {
      expect(accorPageUrl('https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1', 3))
        .toBe('https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=3');
    });

    it('drains every declared page through the final page', async () => {
      const fetched: number[] = [];
      const urls = await collectAccorPageUrls(
        'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1',
        async (url) => {
          const page = Number(new URL(url).searchParams.get('page'));
          fetched.push(page);
          return pagination(3, 25);
        },
      );

      expect(fetched).toEqual([1, 2, 3]);
      expect(urls.map((url) => Number(new URL(url).searchParams.get('page')))).toEqual([1, 2, 3]);
    });

    it('uses the greater bound when the semantic marker understates the result count', () => {
      expect(accorPageCount(pagination(1, 13))).toBe(2);
    });

    it('keeps walking when jobs reorder and a later page raises the bound', async () => {
      const fetched: number[] = [];
      const htmlByPage = new Map([
        [1, pagination(2, 13)],
        [2, pagination(3, 25)],
        [3, pagination(3, 25)],
      ]);
      const urls = await collectAccorPageUrls(
        'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1',
        async (url) => {
          const page = Number(new URL(url).searchParams.get('page'));
          fetched.push(page);
          return htmlByPage.get(page) || '';
        },
      );

      expect(fetched).toEqual([1, 2, 3]);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('rejects an incomplete zero or multi-page snapshot without authoritative pagination', () => {
      expect(() => accorPageCount('<span class="attrax-pagination__total-results">13 résultat(s)</span><span class="attrax-pagination__resultsperpage"><a class="active" aria-label="12 results per page"></a></span>'))
        .toThrow(/trustworthy last-page marker/);
      expect(() => accorPageCount('')).toThrow(/trustworthy last-page marker/);
      expect(() => accorPageCount('<span class="attrax-pagination__total-results">13 résultat(s)</span><span class="attrax-pagination__results-of--2">2</span>'))
        .toThrow(/unreadable total or page-size metadata/);
      expect(accorPageCount('<span class="attrax-pagination__total-results">0 résultat(s)</span><span class="attrax-pagination__resultsperpage"><a class="active" aria-label="12 results per page"></a></span>'))
        .toBe(1);
    });

    it('rejects a failed intermediate page and a non-terminating page count at the hard cap', async () => {
      await expect(collectAccorPageUrls('https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1',
        async (url) => Number(new URL(url).searchParams.get('page')) === 2
          ? Promise.reject(new Error('HTTP 503'))
          : pagination(3), 20)).rejects.toThrow('HTTP 503');
      await expect(collectAccorPageUrls('https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1',
        async () => pagination(21), 20)).rejects.toThrow(/safe limit 20/);
    });

    it('keys the snapshot by the fetch-reported URL, even when the source normalizes it away from the requested one', async () => {
      const pageSnapshots = new Map();
      const html = pagination(1, 5);
      const urls = await collectAccorPageUrls(
        'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1',
        async (url) => ({
          // Simulates a source-side redirect/normalization hop that resolves
          // the requested URL to a differently-encoded one before responding.
          url: `${url}&normalized=1`,
          status: 200,
          body: html,
        }),
        20,
        pageSnapshots,
      );

      expect(urls).toEqual([
        'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1&normalized=1',
      ]);
      expect([...pageSnapshots.keys()]).toEqual(urls);
    });
  });

  describe('snapshot replay', () => {
    it('replays a captured page when the request URL exactly matches the captured (post-normalization) key', async () => {
      const pageSnapshots = new Map([
        ['https://careers.accor.com/fr/fr/jobs?page=1&normalized=1', {
          body: '<html>captured</html>',
          status: 200,
          contentType: 'text/html; charset=utf-8',
        }],
      ]);
      let fallbackCalled = false;
      const snapshotFetch = createAccorSnapshotFetch(pageSnapshots, async () => {
        fallbackCalled = true;
        return new Response('network');
      });

      const res = await snapshotFetch('https://careers.accor.com/fr/fr/jobs?page=1&normalized=1');

      expect(await res.text()).toBe('<html>captured</html>');
      expect(fallbackCalled).toBe(false);
    });

    it('falls back to live network on any non-identical URL instead of silently matching', async () => {
      const pageSnapshots = new Map([
        ['https://careers.accor.com/fr/fr/jobs?page=1&normalized=1', {
          body: '<html>captured</html>',
          status: 200,
          contentType: 'text/html; charset=utf-8',
        }],
      ]);
      let fallbackCalled = false;
      const snapshotFetch = createAccorSnapshotFetch(pageSnapshots, async () => {
        fallbackCalled = true;
        return new Response('network');
      });

      // Trailing slash difference alone must not match — this is the reviewer
      // concern from #7126: a match here would silently defeat the "single
      // snapshot" guarantee instead of falling back visibly.
      const res = await snapshotFetch('https://careers.accor.com/fr/fr/jobs?page=1&normalized=1/');

      expect(await res.text()).toBe('network');
      expect(fallbackCalled).toBe(true);
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
      expect(slugify('Developer accor ch')).toBe('developer-accor-ch');
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
      id: 'accor-abc123',
      slug: 'test-position-accor-ch',
      slugByLocale: { fr: 'test-position-accor-ch' },
      company: 'Ibis Budget',
      companyKey: 'accor',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://careers.accor.com/jobs/test',
      source: 'Ibis Budget Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^accor-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
