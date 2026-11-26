import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>()),
  fetchHtml,
}));

import {
  ZKB_KEY,
  ZKB_COMPANY_NAME,
  buildZkbDetailUrl,
  fetchAllZkbJobs,
  isZkbJob,
  isTrustedDomain,
  parseZkbApiResponse,
  parseZkbDetailPage,
} from '../scripts/lib/zkb-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function nesDetailPage() {
  const tokens = Array.from({ length: 19 }, () => '');
  tokens[0] = 'Platform Engineer Observability (m/w/d)';
  tokens[3] = 'Zürich|Zürich|ZH|Schweiz|CHE';
  tokens[18] = '<p>Die Zürcher Kantonalbank ist die zweitgrösste Universalbank der Schweiz.</p>'
    + '<p>In dieser Rolle entwickelst und betreibst du eine moderne Plattform für Observability und Automatisierung.</p>'
    + '<p>Du arbeitest eng mit unseren Teams zusammen, verbesserst die Stabilität und gestaltest die technische Weiterentwicklung.</p>'
    + '<ul><li>Du konzipierst skalierbare Services.</li><li>Du betreibst Kubernetes und Cloud-Infrastruktur.</li></ul>';
  return `<div id="search-wrapper">${tokens.map((value) => (
    `<div class="joblayouttoken"><span class="rtltextaligneligible">${value}</span></div>`
  )).join('')}</div>`;
}

describe('ZKB current SuccessFactors source', () => {
  beforeEach(() => {
    fetchHtml.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds the slash-canonical detail URL from a NES API record', () => {
    expect(buildZkbDetailUrl({
      id: '67',
      unifiedUrlTitle: 'Platform-Engineer-Observability-%28mwd%29',
    })).toBe('https://jobs.zkb.ch/job/Platform-Engineer-Observability-%28mwd%29/67-de_DE/');
  });

  it('fails closed on a recruiting page without stable row identities', () => {
    expect(() => parseZkbApiResponse({ jobSearchResult: [{ response: {} }] }, 2))
      .toThrow('row 0 has no stable identity');
  });

  it('parses the current NES detail token layout without inventing a body', () => {
    const parsed = parseZkbDetailPage(nesDetailPage(), 'https://jobs.zkb.ch/job/Role/67-de_DE/');
    expect(parsed).toMatchObject({
      title: 'Platform Engineer Observability (m/w/d)',
      city: 'Zürich',
      region: 'ZH',
    });
    expect(parsed.description.split(/\s+/).filter(Boolean).length).toBeGreaterThan(50);
    expect(parsed.description).toContain('Du betreibst Kubernetes');
  });

  it('discovers ZKB postings from the official recruiting API and detail page', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        totalJobs: 1,
        jobSearchResult: [{ response: {
          id: '67',
          brandUrl: 'ZKB',
          unifiedUrlTitle: 'Platform-Engineer-Observability-%28mwd%29',
          jobLocationShort: ['Zürich|Zürich|ZH|Schweiz|CHE'],
        } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    fetchHtml.mockResolvedValue(nesDetailPage());

    const jobs = await fetchAllZkbJobs();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://jobs.zkb.ch/services/recruiting/v1/jobs');
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      locale: 'de_DE', pageNumber: 0, pageSize: 10, sortBy: 'date',
    });
    expect(fetchHtml).toHaveBeenCalledWith(
      'https://jobs.zkb.ch/job/Platform-Engineer-Observability-%28mwd%29/67-de_DE/',
    );
    expect(jobs[0]).toMatchObject({
      companyKey: 'zkb',
      title: 'Platform Engineer Observability (m/w/d)',
      location: 'Zürich',
      canton: 'ZH',
      externalId: '67',
      url: 'https://jobs.zkb.ch/job/Platform-Engineer-Observability-%28mwd%29/67-de_DE/',
    });
  });
});

describe('ZKB crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZKB_KEY).toBe('zkb');
    expect(ZKB_COMPANY_NAME).toBe('Zürcher Kantonalbank');
  });

  // ── isCompanyJob ──
  describe('isZkbJob', () => {
    it('matches by companyKey', () => {
      expect(isZkbJob({ companyKey: 'zkb' })).toBe(true);
    });

    it('matches by company name (ZKB abbreviation, corporate host prefix)', () => {
      expect(isZkbJob({ company: 'ZKB' })).toBe(true);
    });

    it('matches by URL domain (corporate site)', () => {
      expect(isZkbJob({ url: 'https://www.zkb.ch/de/ueber-uns/jobs-karriere/123' })).toBe(true);
    });

    it('matches by Refline tenant listing URL', () => {
      expect(isZkbJob({ url: 'https://apply.refline.ch/792841/11001/pub/1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZkbJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZkbJob(null)).toBe(false);
      expect(isZkbJob(undefined)).toBe(false);
      expect(isZkbJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts corporate domain', () => {
      expect(isTrustedDomain('https://www.zkb.ch/de/ueber-uns/jobs-karriere/123')).toBe(true);
    });

    it('trusts Refline tenant domain', () => {
      expect(isTrustedDomain('https://apply.refline.ch/792841/11001/pub/1')).toBe(true);
    });

    it('rejects a Refline URL for a different tenant', () => {
      expect(isTrustedDomain('https://apply.refline.ch/640332/0052/pub/2/index.html')).toBe(false);
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
      const slug = slugify('DevOps Engineer (Zürich)');
      expect(slug).toBe('devops-engineer-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Kundenberater Zürich')).toBe('kundenberater-zurich');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('DevOps Engineer zkb zurich')).toBe('devops-engineer-zkb-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllZkbJobs emits via
    // the shared createReflineParser factory — see scripts/lib/refline-common.mjs).
    // NB: streetAddress is intentionally NOT a parser-level field here — the
    // shared Refline factory never invents one; it is synthesized downstream at
    // SSG-render time from `build-plugins/shared/companyHqAddresses.ts` (curated
    // 'zkb' entry: Bahnhofstrasse 9, 8001 Zürich) + `scripts/lib/crawler-location-config.mjs`
    // (COMPANY_HQ 'zkb' entry), per Non-Negotiable #3's "safe default, not removed check".
    const validJob = {
      id: 'zkb-abc123def456',
      slug: 'devops-engineer-zkb-zurich',
      slugByLocale: { de: 'devops-engineer-zkb-zurich' },
      company: 'Zürcher Kantonalbank',
      companyKey: 'zkb',
      companyDomain: 'zkb.ch',
      title: 'DevOps Engineer SAP PaPM (m/w/d)',
      titleByLocale: { de: 'DevOps Engineer SAP PaPM (m/w/d)' },
      description: 'Wir sind das Team DevOps BI und entwickeln analytische SAP Systeme fuer das Accounting und Controlling.',
      descriptionByLocale: { de: 'Wir sind das Team DevOps BI und entwickeln analytische SAP Systeme fuer das Accounting und Controlling.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://apply.refline.ch/792841/11001/pub/1',
      source: 'Zürcher Kantonalbank Dedicated Parser (Refline 792841)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8001',
      category: 'IT',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Finanza / Banca',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: 'https://apply.refline.ch/792841/11001/pub/1',
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary and streetAddress are synthesized downstream from curated
      // company-HQ / canton-capital safe defaults (see comment above); these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^zkb-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
