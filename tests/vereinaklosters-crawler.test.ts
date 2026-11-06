import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  VEREINAKLOSTERS_KEY,
  VEREINAKLOSTERS_COMPANY_NAME,
  VEREINAKLOSTERS_SECONDARY_SPEC,
  fetchAllVereinaklostersJobs,
  fetchPrimaryJobListings,
  isVereinaklostersJob,
  isTrustedDomain,
} from '../scripts/lib/vereinaklosters-job-parser.mjs';
import { evaluateAuthoritativeSnapshot, slugify } from '../scripts/lib/crawler-template.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  authoritativeEmptySnapshotValidator,
  isAuthoritativeEmptySnapshot,
  markAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';

// Hotelcareer's real employer page for Hotel Vereina (fetched 2026-10-01,
// scripts/styles removed, contact data and session ids replaced): no vacancy,
// the explicit empty-state sentence, and the footer "Karriere" chrome link.
const VEREINA_NO_VACANCY_PAGE = fs.readFileSync(
  new URL('./fixtures/hotelcareer/hotel-vereina-52746-no-vacancy.html', import.meta.url),
  'utf8',
);
const VEREINA_SEED = 'https://www.hotelcareer.ch/jobs/hotel-vereina-52746';
const VEREINA_SPEC = {
  companyKey: 'vereinaklosters',
  companyName: 'Vereina',
  companyHost: 'hotelcareer.ch',
  platform: 'hotelcareer.ch',
  mode: 'template',
  seedUrls: [VEREINA_SEED],
  detailTemplate: '/jobs/hotel-vereina-52746/*',
  detailEnrichment: true,
  detailFetchWorkers: 4,
  canton: 'GR',
  sourceLang: 'de',
};

function response(url: string, status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe('Vereina crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VEREINAKLOSTERS_KEY).toBe('vereinaklosters');
    expect(VEREINAKLOSTERS_COMPANY_NAME).toBe('Vereina');
  });

  // ── isCompanyJob ──
  describe('isVereinaklostersJob', () => {
    it('matches by companyKey', () => {
      expect(isVereinaklostersJob({ companyKey: 'vereinaklosters' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVereinaklostersJob({ company: 'Vereina' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVereinaklostersJob({ url: 'https://hotelcareer.ch/jobs/hotel-vereina-52746/123' })).toBe(true);
    });

    it('rejects unrelated HotelCareer listings', () => {
      expect(isVereinaklostersJob({ url: 'https://hotelcareer.ch/jobs/other-hotel-123' })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isVereinaklostersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVereinaklostersJob(null)).toBe(false);
      expect(isVereinaklostersJob(undefined)).toBe(false);
      expect(isVereinaklostersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hotelcareer.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hotelcareer.ch/job/456')).toBe(true);
    });

    it('trusts the reviewed secondary public job board', () => {
      expect(isTrustedDomain('https://local-job.ch/job/chef-de-rang-m-w-3795033/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  it('filters the secondary multi-employer board on detail evidence, not link text', async () => {
    const seed = 'https://local-job.ch/berufsgruppe/gastronomie-tourismus/graubuenden/serneus/';
    const wanted = 'https://local-job.ch/job/chef-de-partie-m-w-3795033/';
    const unrelated = 'https://local-job.ch/job/chef-de-rang-m-w-3795000/';
    const description = 'Zur Ergänzung unseres Küchenteams suchen wir eine erfahrene Persönlichkeit. '
      + 'Sie führen Ihren eigenen Posten, arbeiten mit dem Küchenteam zusammen und sorgen für Qualität. '
      + 'Wir bieten ein angenehmes Arbeitsklima, Verpflegung und eine moderne Unterkunft.';
    const detail = (url: string, company: string) => `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: url === wanted ? 'Chef de partie (m/w)' : 'Chef de Rang (m/w)',
      url,
      description,
      hiringOrganization: { '@type': 'Organization', name: company },
      jobLocation: { '@type': 'Place', address: {
        addressLocality: 'Serneus', addressRegion: 'GR', addressCountry: 'CH',
      } },
    })}</script>`;
    const listing = `<a href="${new URL(wanted).pathname}">Chef de partie (m/w)</a>`
      + `<a href="${new URL(unrelated).pathname}">Chef de Rang (m/w)</a>`;
    const pages = new Map([
      ['https://local-job.ch/robots.txt', response('https://local-job.ch/robots.txt', 200, 'User-agent: *\nAllow: /')],
      [seed, response(seed, 200, listing)],
      [wanted, response(wanted, 200, detail(wanted, 'Hotel Vereina'))],
      [unrelated, response(unrelated, 200, detail(unrelated, 'Silvretta Parkhotel Klosters'))],
    ]);
    const fetchImpl = vi.fn(async (url: string) => pages.get(url) || response(url, 404));

    const rows = await runSpecInProduction(
      { ...VEREINAKLOSTERS_SECONDARY_SPEC, seedUrls: [seed] } as any,
      {
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        retries: 0,
        jinaRetries: 0,
        sleepImpl: async () => {},
        jinaSleepImpl: async () => {},
      },
    );

    expect(rows).toEqual([expect.objectContaining({
      title: 'Chef de partie (m/w)',
      url: wanted,
      location: 'Serneus, GR',
    })]);
    expect(fetchImpl).toHaveBeenCalledWith(unrelated, expect.objectContaining({ redirect: 'manual' }));
  });

  it('falls back to a source-backed secondary listing after a primary anti-bot zero', async () => {
    const primaryListings = Object.assign([], {
      fetchOutcome: 'anti_bot_block',
      discoveredCount: 0,
    });
    const secondaryListings = [{
      title: 'Chef de Rang (m/w)',
      url: 'https://local-job.ch/job/chef-de-rang-m-w-3795033/',
      location: 'Serneus, GR',
      description: Array(60).fill('Serviceaufgaben und Betreuung der Restaurantgäste im Hotelbetrieb.').join(' '),
    }];
    const primaryFetchImpl = vi.fn(async () => primaryListings);
    const secondaryFetchImpl = vi.fn(async () => secondaryListings);

    const jobs = await fetchAllVereinaklostersJobs({ primaryFetchImpl, secondaryFetchImpl });

    expect(primaryFetchImpl).toHaveBeenCalledOnce();
    expect(secondaryFetchImpl).toHaveBeenCalledOnce();
    expect(jobs).toEqual([expect.objectContaining({
      companyKey: 'vereinaklosters',
      title: 'Chef de Rang (m/w)',
      canton: 'GR',
      url: 'https://local-job.ch/job/chef-de-rang-m-w-3795033/',
    })]);
    expect(jobs).not.toHaveProperty('fetchOutcome');
  });

  it('keeps the primary anti-bot evidence when the fallback is unavailable', async () => {
    const primaryListings = Object.assign([], { fetchOutcome: 'anti_bot_block' });
    const jobs = await fetchAllVereinaklostersJobs({
      primaryFetchImpl: async () => primaryListings,
      secondaryFetchImpl: async () => { throw new Error('secondary unavailable'); },
    });

    expect(jobs).toEqual([]);
    expect(jobs).toHaveProperty('fetchOutcome', 'anti_bot_block');
  });

  describe('source-proven zero on the Hotelcareer employer page', () => {
    const challenge = '<html><head><title>Challenge Validation</title></head>'
      + `<body><meta name="sec-cpt-if" content="provider=crypto">${' blocked'.repeat(30)}</body></html>`;
    const runtimeServing = (seedBody: string) => ({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.endsWith('/robots.txt')) return response(url, 200, 'User-agent: *\nAllow: /');
        if (url === VEREINA_SEED) return response(url, 200, seedBody);
        throw new Error(`unexpected direct URL ${url}`);
      }),
      jinaFetchImpl: vi.fn(async (url: string) => response(url, 200, challenge)),
      browserFetchImpl: vi.fn(async () => null),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      retries: 0,
      jinaRetries: 0,
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    it('publishes the employer page statement as an authoritative zero', async () => {
      const runtime = runtimeServing(VEREINA_NO_VACANCY_PAGE);
      const listings = await fetchPrimaryJobListings({ spec: VEREINA_SPEC as any, runtime });

      expect(isAuthoritativeEmptySnapshot(listings)).toBe(true);
      expect((listings as any).authoritativeEmptyEvidence)
        .toContain('Dieses Unternehmen sucht aktuell nicht nach Verstärkung');
      // The pipeline verdict with the options the runner declares.
      expect(evaluateAuthoritativeSnapshot(listings, {
        validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(VEREINAKLOSTERS_COMPANY_NAME),
        allowAuthoritativeEmptySnapshot: true,
        authoritativeSnapshotScope: 'empty-only',
        companyLabel: VEREINAKLOSTERS_COMPANY_NAME,
      } as any).authoritativeEmptySnapshot).toBe(true);
      // The footer chrome link no longer counts as a listing: the empty-page
      // rescue ran (and found nothing) instead of being skipped.
      expect(runtime.jinaFetchImpl).toHaveBeenCalled();
    });

    it('keeps an unproven zero (challenge served on every path) as anti-bot evidence', async () => {
      const runtime = runtimeServing(challenge);
      const listings = await fetchPrimaryJobListings({ spec: VEREINA_SPEC as any, runtime })
        .catch((error: any) => error);

      // Either the runtime throws the exhausted anti-bot error or it returns a
      // zero carrying the outcome; it is never a proven empty snapshot.
      expect(isAuthoritativeEmptySnapshot(listings)).toBe(false);
      if (Array.isArray(listings)) expect(listings).toHaveProperty('fetchOutcome', 'anti_bot_block');
      else expect(listings).toHaveProperty('antiBotExhausted', true);
    });

    it('does not let the third-party board contradict the official zero', async () => {
      const primary = markAuthoritativeEmptySnapshot([], 'Hotelcareer employer page: no vacancy');
      const secondaryFetchImpl = vi.fn(async () => []);

      const jobs = await fetchAllVereinaklostersJobs({
        primaryFetchImpl: async () => primary,
        secondaryFetchImpl,
      });

      expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
      expect(secondaryFetchImpl).not.toHaveBeenCalled();
    });

    it('asks the pipeline for the source-proven zero', () => {
      const runner = fs.readFileSync(new URL('../scripts/update-vereinaklosters-jobs.mjs', import.meta.url), 'utf8');
      expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(');
      expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
      expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
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
      expect(slugify('Developer vereinaklosters ch')).toBe('developer-vereinaklosters-ch');
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
      id: 'vereinaklosters-abc123',
      slug: 'test-position-vereinaklosters-ch',
      slugByLocale: { de: 'test-position-vereinaklosters-ch' },
      company: 'Vereina',
      companyKey: 'vereinaklosters',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hotelcareer.ch/jobs/test',
      source: 'Vereina Dedicated Parser',
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
      expect(validJob.id).toMatch(/^vereinaklosters-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
