import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  BCV_KEY,
  BCV_COMPANY_NAME,
  isBcvJob,
  isTrustedDomain,
  fetchAllBcvJobs,
} from '../scripts/lib/bcv-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Banque Cantonale Vaudoise crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BCV_KEY).toBe('bcv');
    expect(BCV_COMPANY_NAME).toBe('Banque Cantonale Vaudoise');
  });

  // ── isCompanyJob ──
  describe('isBcvJob', () => {
    it('matches by companyKey', () => {
      expect(isBcvJob({ companyKey: 'bcv' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBcvJob({ company: 'Banque Cantonale Vaudoise' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBcvJob({ url: 'https://jobs.bcv.ch/job/Lausanne-Analyst/123456/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBcvJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBcvJob(null)).toBe(false);
      expect(isBcvJob(undefined)).toBe(false);
      expect(isBcvJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bcv.ch/emploi')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.bcv.ch/job/Lausanne-Analyst/123456/')).toBe(true);
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
      expect(slugify('Gestionnaire spécialisé')).toBe('gestionnaire-specialise');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Conseiller bcv lausanne')).toBe('conseiller-bcv-lausanne');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference — mirrors the fields fetchAllBcvJobs()
    // actually emits, including the canton-gated address fields
    // (postalCode/streetAddress) per Non-Negotiable #3.
    const validJob = {
      id: 'bcv-abc123',
      slug: 'test-position-bcv-lausanne',
      slugByLocale: { fr: 'test-position-bcv-lausanne' },
      company: 'Banque Cantonale Vaudoise',
      companyKey: 'bcv',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lausanne',
      canton: 'VD',
      url: 'https://jobs.bcv.ch/job/Lausanne-Test-Position/123456/',
      source: 'Banque Cantonale Vaudoise Dedicated Parser (SuccessFactors)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      postalCode: '1003',
      streetAddress: 'Place Saint-François 14',
      employmentType: 'OTHER',
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

    it('includes canton-gated address fields for a Vaud (HQ) location', () => {
      expect(validJob.postalCode).toBe('1003');
      expect(validJob.streetAddress).toBe('Place Saint-François 14');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^bcv-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Only the posting's own text is published (issue 5253). A detail page
// without a description used to go out as "{title} — BCV, {city}.", and a
// short body was padded with a bank summary and a call to apply; neither is
// vacancy text. Page shapes of jobs.bcv.ch (sitemap + itemprop microdata).
describe('fetchAllBcvJobs — published text', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the body as it is and skips a page without one', async () => {
    const sitemap = '<?xml version="1.0"?><urlset>'
      + '<url><loc>https://jobs.bcv.ch/job/Lausanne-Conseiller-clientele/1201/</loc><lastmod>2026-09-20</lastmod></url>'
      + '<url><loc>https://jobs.bcv.ch/job/Lausanne-Analyste/1202/</loc><lastmod>2026-09-21</lastmod></url></urlset>';
    const detail = (title: string, desc: string) => `<html><body><div><span itemprop="title">${title}</span></div>`
      + (desc ? `<div><span itemprop="description"><p>${desc}</p></span></div>` : '') + '</body></html>';
    const body = 'Vous conseillez une clientèle privée exigeante et développez un portefeuille de clients dans la région lausannoise.';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/sitemap.xml')) return new Response(sitemap, { status: 200, headers: { 'content-type': 'application/xml' } });
      if (u.includes('/1201/')) return new Response(detail('Conseiller clientèle privée', body), { status: 200 });
      return new Response(detail('Analyste crédit', ''), { status: 200 });
    }));

    const jobs = await fetchAllBcvJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Conseiller clientèle privée']);
    // A short body is the posting's own text: published without padding.
    expect(jobs[0].description).toBe(body);
  }, 20_000);
});
