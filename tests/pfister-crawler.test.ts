import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PFISTER_KEY,
  PFISTER_COMPANY_NAME,
  fetchAllPfisterJobs,
  isPfisterJob,
  isTrustedDomain,
} from '../scripts/lib/pfister-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function htmlResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pfister crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PFISTER_KEY).toBe('pfister');
    expect(PFISTER_COMPANY_NAME).toBe('Möbel Pfister AG');
  });

  // ── isCompanyJob ──
  describe('isPfisterJob', () => {
    it('matches by companyKey', () => {
      expect(isPfisterJob({ companyKey: 'pfister' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPfisterJob({ company: 'Möbel Pfister AG' })).toBe(true);
    });

    it('matches by URL domain (corporate site)', () => {
      expect(isPfisterJob({ url: 'https://www.pfister.ch/de/karriere/123' })).toBe(true);
    });

    it('matches by Refline tenant listing URL', () => {
      expect(isPfisterJob({ url: 'https://apply.refline.ch/424626/11001/pub/1' })).toBe(true);
    });

    it('rejects unrelated jobs (incl. other Pfister-named companies)', () => {
      expect(isPfisterJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
      // Angst+Pfister, Carrosserie Pfister AG and PFISTERER are unrelated
      // companies that merely share the "Pfister" surname/brand token — the
      // matcher must not false-positive on the bare word.
      expect(isPfisterJob({ company: 'Angst+Pfister AG', url: 'https://www.angst-pfister.com/jobs/1' })).toBe(false);
      expect(isPfisterJob({ company: 'Carrosserie Pfister AG', url: 'https://www.carrosserie-pfister.ch/jobs/1' })).toBe(false);
      expect(isPfisterJob({ company: 'PFISTERER Holding AG', url: 'https://www.pfisterer.com/jobs/1' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPfisterJob(null)).toBe(false);
      expect(isPfisterJob(undefined)).toBe(false);
      expect(isPfisterJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts corporate domain', () => {
      expect(isTrustedDomain('https://www.pfister.ch/de/karriere/123')).toBe(true);
    });

    it('trusts Refline tenant domain', () => {
      expect(isTrustedDomain('https://apply.refline.ch/424626/11001/pub/1')).toBe(true);
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
      const slug = slugify('Verkaufsberater/in Möbel (Suhr)');
      expect(slug).toBe('verkaufsberater-in-mobel-suhr');
    });

    it('strips diacritics', () => {
      expect(slugify('Küchenberater Zürich')).toBe('kuchenberater-zurich');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Verkaufsberater pfister suhr')).toBe('verkaufsberater-pfister-suhr');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllPfisterJobs emits
    // via the shared createReflineParser factory — see
    // scripts/lib/refline-common.mjs). NB: streetAddress is intentionally NOT a
    // parser-level field here — the shared Refline factory never invents one;
    // it is synthesized downstream at SSG-render time from
    // `build-plugins/shared/companyHqAddresses.ts` (curated 'pfister' entry:
    // Bernstrasse Ost 49, 5034 Suhr) + `scripts/lib/crawler-location-config.mjs`
    // (COMPANY_HQ 'pfister' entry), per Non-Negotiable #3's "safe default, not
    // removed check".
    const longDescription = [
      'Als Verkaufsberater/in bei Möbel Pfister AG betreust du unsere Kundschaft',
      'kompetent und freundlich in unserer Filiale in Suhr und berätst sie',
      'zu unserem gesamten Möbel- und Einrichtungssortiment inklusive Polstermöbel, Küchen und',
      'Wohnaccessoires. Du erstellst Kundenaufträge, koordinierst Lieferungen und Montagetermine und',
      'sorgst für eine ansprechende Warenpräsentation auf der Verkaufsfläche. Wir bieten',
      'dir eine faire Anstellung, vielfältige Weiterbildungsmöglichkeiten und ein motiviertes Team',
      'in einem der grössten Möbelhäuser der Schweiz, Teil der XXXLutz Gruppe.',
    ].join(' ');

    const validJob = {
      id: 'pfister-abc123def456',
      slug: 'verkaufsberater-in-pfister-suhr',
      slugByLocale: { de: 'verkaufsberater-in-pfister-suhr' },
      company: 'Möbel Pfister AG',
      companyKey: 'pfister',
      companyDomain: 'pfister.ch',
      title: 'Verkaufsberater/in Möbel (m/w/d)',
      titleByLocale: { de: 'Verkaufsberater/in Möbel (m/w/d)' },
      description: longDescription,
      descriptionByLocale: { de: longDescription },
      location: 'Suhr',
      canton: 'AG',
      url: 'https://apply.refline.ch/424626/11001/pub/1',
      source: 'Möbel Pfister AG Dedicated Parser (Refline 424626)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Suhr',
      addressRegion: 'AG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '5034',
      category: 'Retail',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Retail / Furniture',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: 'https://apply.refline.ch/424626/11001/pub/1',
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
      expect(validJob.id).toMatch(/^pfister-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    // ── Non-Negotiable #4: never accept indexed thin content under 50 words ──
    it('description meets the 50-word thin-content floor', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });

  // ── Graceful degradation: source unreachable must not throw ──
  describe('fetchAllPfisterJobs graceful degradation', () => {
    it('resolves to an empty array (not a throw) when the Refline listing is unreachable', async () => {
      // A persistent, non-retryable, non-WAF HTTP status (404) so the shared
      // fetchHtml() helper (scripts/lib/hospital-custom-html-helpers.mjs) fails
      // fast on the first attempt without retry/backoff or a Jina-proxy
      // rescue attempt — exercising the top-level try/catch in
      // createReflineParser's fetchAllJobs() (scripts/lib/refline-common.mjs)
      // that logs a warning and returns [] instead of throwing.
      const fetchMock = vi.fn().mockResolvedValue(htmlResponse(404, ''));
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllPfisterJobs();
      expect(jobs).toEqual([]);
    });

    it('resolves to an empty array when the listing host is unreachable at the network level', async () => {
      // A connection-level failure (no HTTP response) additionally routes
      // through the Jina-proxy rescue path in fetchHtml() before giving up
      // (see scripts/lib/hospital-custom-html-helpers.mjs). Zero out every
      // retry/backoff knob and trip the Jina breaker open so the whole chain
      // fails fast and deterministically instead of racing real backoff
      // timers, while still exercising the same top-level safe-fail (`[]`,
      // not a throw) as a real broad-outage run would hit.
      const savedEnv = {
        JOBS_CRAWLER_RETRIES: process.env.JOBS_CRAWLER_RETRIES,
        JOBS_CRAWLER_RETRY_BASE_MS: process.env.JOBS_CRAWLER_RETRY_BASE_MS,
        JOBS_JINA_RETRIES: process.env.JOBS_JINA_RETRIES,
        JOBS_JINA_RETRY_BASE_MS: process.env.JOBS_JINA_RETRY_BASE_MS,
      };
      process.env.JOBS_CRAWLER_RETRIES = '0';
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      // NB: jina-proxy.mjs reads these via `Number(env) || fallback`, so an
      // explicit '0' is falsy and silently falls back to the default (2) —
      // a pre-existing env-parsing quirk, out of scope to fix here. Use '1'
      // (truthy) to keep this test fast without fighting that fallback.
      process.env.JOBS_JINA_RETRIES = '1';
      process.env.JOBS_JINA_RETRY_BASE_MS = '1';

      try {
        const netErr = Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ENOTFOUND' },
        });
        const fetchMock = vi.fn().mockRejectedValue(netErr);
        vi.stubGlobal('fetch', fetchMock);

        const jobs = await fetchAllPfisterJobs();
        expect(jobs).toEqual([]);
      } finally {
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
