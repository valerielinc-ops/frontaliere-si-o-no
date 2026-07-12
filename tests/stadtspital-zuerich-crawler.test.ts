import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STADTSPITAL_ZUERICH_KEY,
  STADTSPITAL_ZUERICH_COMPANY_NAME,
  isStadtspitalZuerichJob,
  isTrustedDomain,
  fetchAllStadtspitalZuerichJobs,
} from '../scripts/lib/stadtspital-zuerich-job-parser.mjs';
import { parseListingTiles } from '../scripts/lib/stadt-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Trimmed live markup recorded 2026-07-11 from the facet-filtered listing
// https://jobs.stadt-zuerich.ch/search/?q=&optionsFacetsDD_customfield2=Stadtspital%20Z%C3%BCrich
// — 2 Stadtspital tiles + 1 non-Stadtspital tile (Verkehrsbetriebe) from the
// unfiltered listing, to exercise the defensive Dienstabteilung guard.
const FIXTURE = readFileSync(
  join(__dirname, '__fixtures__', 'stadtspital-zuerich-listing.html'),
  'utf8',
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Stadtspital Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADTSPITAL_ZUERICH_KEY).toBe('stadtspital-zuerich');
    expect(STADTSPITAL_ZUERICH_COMPANY_NAME).toBe('Stadtspital Zürich');
  });

  // ── isCompanyJob ──
  describe('isStadtspitalZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtspitalZuerichJob({ companyKey: 'stadtspital-zuerich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtspitalZuerichJob({ company: 'Stadtspital Zürich' })).toBe(true);
    });

    it('matches by legacy URL domain', () => {
      expect(isStadtspitalZuerichJob({ url: 'https://stadtspital.ch/jobs/123' })).toBe(true);
    });

    it('does NOT claim sibling Stadt Zürich jobs from the shared portal host', () => {
      // Both crawlers publish on jobs.stadt-zuerich.ch — matching by that
      // host alone would steal the municipal administration's jobs.
      expect(
        isStadtspitalZuerichJob({
          companyKey: 'stadt-zuerich',
          company: 'Stadt Zürich',
          url: 'https://jobs.stadt-zuerich.ch/job/sachbearbeiter-in/12345/',
        }),
      ).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isStadtspitalZuerichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtspitalZuerichJob(null)).toBe(false);
      expect(isStadtspitalZuerichJob(undefined)).toBe(false);
      expect(isStadtspitalZuerichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the legacy hospital domain and subdomains', () => {
      expect(isTrustedDomain('https://stadtspital.ch/careers/job-123')).toBe(true);
      expect(isTrustedDomain('https://www.stadtspital.ch/karriere')).toBe(true);
    });

    it('trusts the city job portal that now hosts the postings', () => {
      expect(isTrustedDomain('https://jobs.stadt-zuerich.ch/job/Dipl_-Pflegefachperson/1358220057/')).toBe(true);
      expect(isTrustedDomain('https://www.stadt-zuerich.ch/stadtspital')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── Listing tile parsing (shared with the stadt-zuerich parser) ──
  describe('parseListingTiles on recorded live fixture', () => {
    it('extracts all tiles with title/unit/ref/path', () => {
      const rows = parseListingTiles(FIXTURE);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        jobId: '1358220057',
        path: '/job/Dipl_-Pflegefachperson-Chirurgie-AB2-mit-WAIDsicht/1358220057/',
        title: 'Dipl. Pflegefachperson Chirurgie AB2 mit WAIDsicht',
        department: 'Gesundheits- und Umweltdepartement',
        unit: 'Stadtspital Zürich',
        ref: '49951',
      });
      expect(rows[2].unit).toBe('Verkehrsbetriebe');
    });
  });

  // ── fetchAllStadtspitalZuerichJobs (mocked fetch on live fixture) ──
  describe('fetchAllStadtspitalZuerichJobs', () => {
    function stubFetchWith(html: string) {
      const fetchMock = vi.fn(async (url: string) => {
        // First page returns the fixture; further pages are empty.
        const body = String(url).includes('startrow=0') ? html : '<ul></ul>';
        return {
          ok: true,
          status: 200,
          text: async () => body,
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('requests the Dienstabteilung facet filter for Stadtspital Zürich', async () => {
      const fetchMock = stubFetchWith(FIXTURE);
      await fetchAllStadtspitalZuerichJobs();
      const firstUrl = String(fetchMock.mock.calls[0][0]);
      expect(firstUrl).toContain('https://jobs.stadt-zuerich.ch/search/');
      expect(firstUrl).toContain('optionsFacetsDD_customfield2=Stadtspital%20Z%C3%BCrich');
    });

    it('builds valid jobs from Stadtspital tiles and drops non-Stadtspital rows', async () => {
      stubFetchWith(FIXTURE);
      const jobs = await fetchAllStadtspitalZuerichJobs();

      // 3 tiles in fixture, 1 belongs to Verkehrsbetriebe → dropped by the
      // defensive Dienstabteilung guard (owned by the stadt-zuerich crawler).
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j: any) => /stadtspital/i.test(j.unit))).toBe(true);

      const job = jobs[0];
      expect(job).toMatchObject({
        company: 'Stadtspital Zürich',
        companyKey: 'stadtspital-zuerich',
        companyDomain: 'stadtspital.ch',
        title: 'Dipl. Pflegefachperson Chirurgie AB2 mit WAIDsicht',
        location: 'Zürich',
        canton: 'ZH',
        addressCountry: 'CH',
        country: 'CH',
        sourceLang: 'de',
        currency: 'CHF',
        category: 'Sanità',
        referenceNumber: '49951',
      });
      expect(job.url).toBe(
        'https://jobs.stadt-zuerich.ch/job/Dipl_-Pflegefachperson-Chirurgie-AB2-mit-WAIDsicht/1358220057/',
      );
      expect(isTrustedDomain(job.url)).toBe(true);
      expect(isStadtspitalZuerichJob(job)).toBe(true);
    });

    it('produces required fields, safe structured-data defaults and 50+ word descriptions', async () => {
      stubFetchWith(FIXTURE);
      const jobs = await fetchAllStadtspitalZuerichJobs();
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
        // structured-data safe defaults (Non-Negotiable #3)
        'streetAddress', 'postalCode', 'addressLocality', 'employmentType', 'postedDate',
      ];
      for (const job of jobs) {
        for (const field of required) {
          expect(job).toHaveProperty(field);
        }
        // id / slug shape
        expect(job.id).toMatch(/^stadtspital-zuerich-/);
        expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
        // slug only contains source locale
        expect(Object.keys(job.slugByLocale)).toEqual([job.sourceLang]);
        // thin-content floor (Non-Negotiable #4)
        const wordCount = job.description.split(/\s+/).filter(Boolean).length;
        expect(wordCount).toBeGreaterThanOrEqual(50);
      }
      // Repeated titles across wards stay unique via the ref disambiguator.
      expect(new Set(jobs.map((j: any) => j.slug)).size).toBe(jobs.length);
    });

    it('returns [] (no throw) when the portal is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('connect ETIMEDOUT');
      }));
      const jobs = await fetchAllStadtspitalZuerichJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) on HTTP error status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => '',
      } as unknown as Response)));
      const jobs = await fetchAllStadtspitalZuerichJobs();
      expect(jobs).toEqual([]);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Dipl. Pflegefachperson Chirurgie, 80–100 %');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Assistenzärztin Anästhesiologie')).toBe('assistenzarztin-anasthesiologie');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });
});
