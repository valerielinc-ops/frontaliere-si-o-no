import { describe, it, expect, vi } from 'vitest';
import {
  FAULHABER_KEY,
  FAULHABER_COMPANY_NAME,
  fetchAllFaulhaberJobs,
  fetchListingData,
  isFaulhaberJob,
  isTrustedDomain,
} from '../scripts/lib/faulhaber-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const LISTING_DATA_URL = 'https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/Joboffers/GetJoboffersData';
const DETAIL_URL = 'https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/stellenangebot/57372/Tecnico-di-misura';
const SERVER_ERROR_URL = 'https://jobs.faulhaber.com/HPv3.Jobs/Errors/ServerError';
const LISTING_JSON = JSON.stringify({
  JoboffersCount: 1,
  Joboffers: [{
    Id: 57372,
    JobofferName: 'Tecnico di misura',
    LocationName: 'CH - Croglio',
    Department: 'Qualitätsmanagement',
    JobofferUrl: '/HPv3.Jobs/faulhaber/stellenangebot/57372/Tecnico-di-misura',
  }],
});
const JINA_LISTING_BODY = `<html><body><pre>${LISTING_JSON}</pre></body></html>`;
const DETAIL_HTML = `
  <div class="annonce">
    <h1>Tecnico di misura</h1>
    <div id="position" class="content">
      <div class="location">CH - Croglio</div>
      <div class="annonce-row">
        Per il nostro team Quality Management cerchiamo un tecnico di misura con esperienza nella metrologia,
        nel controllo qualità e nella documentazione dei risultati. La posizione collabora con produzione e ingegneria.
      </div>
    </div>
  </div>`;

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('Faulhaber crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FAULHABER_KEY).toBe('faulhaber');
    expect(FAULHABER_COMPANY_NAME).toBe('Faulhaber');
  });

  // ── isCompanyJob ──
  describe('isFaulhaberJob', () => {
    it('matches by companyKey', () => {
      expect(isFaulhaberJob({ companyKey: 'faulhaber' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFaulhaberJob({ company: 'Faulhaber' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFaulhaberJob({ url: 'https://faulhaber.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFaulhaberJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFaulhaberJob(null)).toBe(false);
      expect(isFaulhaberJob(undefined)).toBe(false);
      expect(isFaulhaberJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://faulhaber.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.faulhaber.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('source-specific Jina fallback', () => {
    it('recovers the persistent listing HTTP 500 and publishes only validated detail content', async () => {
      const fetchHtmlImpl = vi.fn(async (url: string, options: { validateRedirectUrl?: (url: string) => void }) => {
        options.validateRedirectUrl?.(url);
        if (url === LISTING_DATA_URL) {
          options.validateRedirectUrl?.(`${SERVER_ERROR_URL}?aspxerrorpath=/HPv3.Jobs/faulhaber/Joboffers/GetJoboffersData`);
          throw httpError(500);
        }
        if (url === DETAIL_URL) {
          options.validateRedirectUrl?.(`${SERVER_ERROR_URL}?aspxerrorpath=/HPv3.Jobs/faulhaber/stellenangebot/57372/Tecnico-di-misura`);
          throw httpError(500);
        }
        throw new Error(`Unexpected URL ${url}`);
      });
      const fetchJinaImpl = vi.fn(async (url: string) => url === LISTING_DATA_URL ? JINA_LISTING_BODY : DETAIL_HTML);

      const jobs = await fetchAllFaulhaberJobs({ fetchHtmlImpl, fetchJinaImpl });

      expect(fetchJinaImpl).toHaveBeenCalledWith(LISTING_DATA_URL, { timeoutMs: 20000 });
      expect(fetchJinaImpl).toHaveBeenCalledWith(DETAIL_URL, { timeoutMs: 15000 });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: 'faulhaber-cd396bb6e76c',
        slug: 'tecnico-di-misura-croglio-faulhaber',
        url: DETAIL_URL,
        applyUrl: DETAIL_URL,
        location: 'Croglio',
      });
      expect(jobs[0].description.length).toBeGreaterThanOrEqual(100);

      const rerun = await fetchAllFaulhaberJobs({ fetchHtmlImpl, fetchJinaImpl });
      const identity = (job: typeof jobs[number]) => ({ id: job.id, slug: job.slug, url: job.url });
      expect(rerun.map(identity)).toEqual(jobs.map(identity));
    });

    it('rethrows when the source-specific fallback is unavailable', async () => {
      const original = httpError(500);
      await expect(fetchListingData({
        fetchHtmlImpl: vi.fn(async () => { throw original; }),
        fetchJinaImpl: vi.fn(async () => null),
      })).rejects.toBe(original);
    });

    it('keeps a complete empty listing envelope distinct from source degradation', async () => {
      await expect(fetchListingData({
        fetchHtmlImpl: vi.fn(async () => JSON.stringify({ JoboffersCount: 0, Joboffers: [] })),
        fetchJinaImpl: vi.fn(),
      })).resolves.toEqual([]);
    });

    it('rejects an unsafe detail URL returned by the fallback', async () => {
      const unsafePayload = JSON.parse(LISTING_JSON);
      unsafePayload.Joboffers[0].JobofferUrl = DETAIL_URL.replace('https://jobs.faulhaber.com', 'https://evil.example');
      const unsafe = `<html><body><pre>${JSON.stringify(unsafePayload)}</pre></body></html>`;
      await expect(fetchListingData({
        fetchHtmlImpl: vi.fn(async () => { throw httpError(500); }),
        fetchJinaImpl: vi.fn(async () => unsafe),
      })).rejects.toThrow(/unsafe detail URL/);
    });

    it('does not widen the fallback to generic upstream 5xx responses', async () => {
      const fetchJinaImpl = vi.fn(async () => JINA_LISTING_BODY);
      await expect(fetchListingData({
        fetchHtmlImpl: vi.fn(async () => { throw httpError(503); }),
        fetchJinaImpl,
      })).rejects.toMatchObject({ status: 503 });
      expect(fetchJinaImpl).not.toHaveBeenCalled();
    });

    it('rejects an unsafe effective listing URL before attempting Jina', async () => {
      const fetchJinaImpl = vi.fn(async () => JINA_LISTING_BODY);
      await expect(fetchListingData({
        fetchHtmlImpl: vi.fn(async (_url: string, options: { validateRedirectUrl: (url: string) => void }) => {
          options.validateRedirectUrl('https://evil.example/redirected');
          return LISTING_JSON;
        }),
        fetchJinaImpl,
      })).rejects.toThrow(/redirect escaped/);
      expect(fetchJinaImpl).not.toHaveBeenCalled();
    });

    it('rejects a redirect to a different trusted Faulhaber vacancy', async () => {
      await expect(fetchAllFaulhaberJobs({
        fetchHtmlImpl: vi.fn(async (url: string, options: { validateRedirectUrl?: (url: string) => void }) => {
          if (url === LISTING_DATA_URL) return LISTING_JSON;
          options.validateRedirectUrl?.(DETAIL_URL.replace('/57372/', '/99999/'));
          return DETAIL_HTML;
        }),
        fetchJinaImpl: vi.fn(),
      })).rejects.toThrow(/escaped the requested vacancy/);
    });

    it('routes a WAF challenge served as HTTP 200 to Jina even with validateRedirectUrl set', async () => {
      const fetchHtmlImpl = vi.fn(async (url: string, options: { validateRedirectUrl?: (url: string) => void }) => {
        options.validateRedirectUrl?.(url);
        if (url === LISTING_DATA_URL) return '<html><body>Just a moment...</body></html>';
        if (url === DETAIL_URL) return DETAIL_HTML;
        throw new Error(`Unexpected URL ${url}`);
      });
      const fetchJinaImpl = vi.fn(async (url: string) => url === LISTING_DATA_URL ? JINA_LISTING_BODY : DETAIL_HTML);

      const jobs = await fetchAllFaulhaberJobs({ fetchHtmlImpl, fetchJinaImpl });

      expect(fetchJinaImpl).toHaveBeenCalledWith(LISTING_DATA_URL, { timeoutMs: 20000 });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].url).toBe(DETAIL_URL);
    });

    it('fails closed instead of publishing a synthetic thin description', async () => {
      const fetchHtmlImpl = vi.fn(async (url: string) => {
        if (url === LISTING_DATA_URL) throw httpError(500);
        if (url === DETAIL_URL) return '<div class="annonce"><div id="position" class="content">Too short</div></div>';
        throw new Error(`Unexpected URL ${url}`);
      });
      await expect(fetchAllFaulhaberJobs({
        fetchHtmlImpl,
        fetchJinaImpl: vi.fn(async (url: string) => url === LISTING_DATA_URL ? JINA_LISTING_BODY : DETAIL_HTML),
      })).rejects.toThrow(/description below 100 characters/);
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
      expect(slugify('Developer faulhaber ch')).toBe('developer-faulhaber-ch');
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
      id: 'faulhaber-abc123',
      slug: 'test-position-faulhaber-ch',
      slugByLocale: { de: 'test-position-faulhaber-ch' },
      company: 'Faulhaber',
      companyKey: 'faulhaber',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://faulhaber.com/jobs/test',
      source: 'Faulhaber Dedicated Parser',
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
      expect(validJob.id).toMatch(/^faulhaber-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
