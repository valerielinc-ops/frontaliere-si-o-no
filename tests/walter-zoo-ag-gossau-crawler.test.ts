import { describe, it, expect } from 'vitest';
import {
  WALTER_ZOO_AG_GOSSAU_KEY,
  WALTER_ZOO_AG_GOSSAU_COMPANY_NAME,
  isWalterZooAgGossauJob,
  isTrustedDomain,
} from '../scripts/lib/walter-zoo-ag-gossau-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { loadSpec, runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';

describe('WALTER ZOO AG GOSSAU crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(WALTER_ZOO_AG_GOSSAU_KEY).toBe('walter-zoo-ag-gossau');
    expect(WALTER_ZOO_AG_GOSSAU_COMPANY_NAME).toBe('WALTER ZOO AG GOSSAU');
  });

  it('uses the official jobs listing and rescues blocked empty responses', () => {
    expect(loadSpec(WALTER_ZOO_AG_GOSSAU_KEY)).toMatchObject({
      seedUrls: ['https://www.walterzoo.ch/unser-zoo/'],
      allowedDetailOrigins: ['https://link.ostendis.com/'],
      detailTemplate: '/publication/*/*',
      detailEnrichment: true,
      rescueOnEmptyListing: true,
      emptyListingOutcome: 'anti_bot_block',
    });
  });

  it('discovers allowlisted cross-origin Ostendis vacancies from the official page', async () => {
    const seedUrl = 'https://www.walterzoo.ch/unser-zoo/';
    const detailUrl = 'https://link.ostendis.com/publication/praktikant-in-tierpflege/source-token';
    const unrelatedUrl = 'https://unrelated.example/publication/other-role/source-token';
    const requests: string[] = [];
    const detail = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Praktikant:in Tierpflege',
      description: 'Du pflegst Tiere und unterstützt das erfahrene Team im täglichen Zoobetrieb mit abwechslungsreichen Aufgaben.',
      hiringOrganization: { '@type': 'Organization', name: 'WALTER ZOO AG GOSSAU' },
      jobLocation: {
        '@type': 'Place',
        address: {
          streetAddress: 'Neuchlen 200',
          postalCode: '9200',
          addressLocality: 'Gossau',
          addressRegion: 'SG',
          addressCountry: 'CH',
        },
      },
      url: detailUrl,
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seedUrl) {
        return new Response(
          `<a href="${detailUrl}">Praktikant:in Tierpflege (100 %)</a>`
          + `<a href="${unrelatedUrl}">Unrelated role</a>`,
        );
      }
      if (url === detailUrl) {
        return new Response(
          '<h1>Praktikant:in Tierpflege (m/w/d | 100%)</h1>'
          + `<script type="application/ld+json">${JSON.stringify(detail)}</script>`,
        );
      }
      throw new Error(`unexpected fixture URL ${url}`);
    };

    const rows = await runSpecInProduction({
      ...loadSpec(WALTER_ZOO_AG_GOSSAU_KEY),
      seedUrls: [seedUrl],
      sampleVacancyCount: 1,
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      disableWafProxy: true,
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Praktikant:in Tierpflege',
      url: detailUrl,
      location: 'Gossau, SG',
      canton: 'SG',
    })]);
    expect(requests).not.toContain(unrelatedUrl);
  });

  // ── isCompanyJob ──
  describe('isWalterZooAgGossauJob', () => {
    it('matches by companyKey', () => {
      expect(isWalterZooAgGossauJob({ companyKey: 'walter-zoo-ag-gossau' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isWalterZooAgGossauJob({ company: 'WALTER ZOO AG GOSSAU' })).toBe(true);
    });

    it('does not match an unrelated company hosted on the ATS domain', () => {
      expect(isWalterZooAgGossauJob({
        company: 'Other AG',
        url: 'https://link.ostendis.com/publication/123',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isWalterZooAgGossauJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isWalterZooAgGossauJob(null)).toBe(false);
      expect(isWalterZooAgGossauJob(undefined)).toBe(false);
      expect(isWalterZooAgGossauJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://link.ostendis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.link.ostendis.com/job/456')).toBe(true);
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
      expect(slugify('Developer walter-zoo-ag-gossau ch')).toBe('developer-walter-zoo-ag-gossau-ch');
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
      id: 'walter-zoo-ag-gossau-abc123',
      slug: 'test-position-walter-zoo-ag-gossau-ch',
      slugByLocale: { de: 'test-position-walter-zoo-ag-gossau-ch' },
      company: 'WALTER ZOO AG GOSSAU',
      companyKey: 'walter-zoo-ag-gossau',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://link.ostendis.com/jobs/test',
      source: 'WALTER ZOO AG GOSSAU Dedicated Parser',
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
      expect(validJob.id).toMatch(/^walter-zoo-ag-gossau-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
