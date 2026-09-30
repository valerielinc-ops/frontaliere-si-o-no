import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  assertCoopAdapterParity,
  assertCompleteCoopDiscovery,
  assertCoopSingleCompanyKeyScope,
  buildCoopAdapterConfig,
  ensureAdapterSeedUrls,
  fetchCoopJobDetailUrls,
  findUnrecognizedCoopDivisions,
  isCoopJob,
  reconcileCoopLocationCanton,
  coopDetailNeedsQuarantine,
  coopDetailSourceBody,
} from '../scripts/update-coop-jobs.mjs';
import { countDuplicateListings, fingerprintsForCrawler } from '../scripts/audit-parser-quality.mjs';
import { jobLocationRedundancy } from '../scripts/lib/job-location-display.mjs';
import { fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  extractJsonLd,
  coopDescHtmlToMarkdown,
  validateCoopDescription,
  titleOverlap,
  applyCoopJsonLdToJob,
  applyCoopSourceDetailToJob,
  enrichCoopSourceBackedJobs,
  buildCoopTranslationCacheEntry,
  resolveCoopCantonCode,
  collapseRepublishedCoopVacancies,
  withoutRepublishedCoopVacancies,
  composeCoopFamilyDescription,
  extractCoopFamilyPageDetails,
} from '../scripts/lib/coop-job-parser.mjs';

const frenchDetailFixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'coop-french-detail.json'), 'utf8'),
);
// Live Prospective detail pages (Coop store, Fust apprenticeship, fenaco
// generic, Interdiscount branch), minimized to the JSON-LD, the analytics
// workplace field and the content blocks; recruiter names/phones redacted.
const familyPages = Object.fromEntries(JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'coop-family-detail-pages.json'), 'utf8'),
).pages.map((page: { id: string, url: string, html: string }) => [page.id, page]));

// Two Coop apprenticeship ads published at Heiden under two UUIDs (identical
// but for the ATS tracking id), plus the Interdiscount/Jumbo pages of the
// location fixes; minimized, recruiter names redacted.
const republishedPages = Object.fromEntries(JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'coop-family-republished-pages.json'), 'utf8'),
).pages.map((page: { id: string, url: string, html: string }) => [page.id, page]));

const makeCoopApiJob = (index, { canton = 'Zurigo' } = {}) => ({
  links: {
    directlink: `https://jobs.coopjobs.ch/offene-stellen/job-${index}/22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  },
  attributes: { '30': [canton], '70': ['Coop Genossenschaft'] },
});

describe('reconcileCoopLocationCanton', () => {
  const conflictShape = [
    { location: 'Reinach (AG)', canton: 'BL' },
    { location: 'Büren an der Aare, Bern', canton: 'SO' },
    { location: 'Feuerthalen, Zürich', canton: 'SH' },
  ];

  it('prefers the canton encoded in the location over a conflicting stamp', () => {
    const reconciled = reconcileCoopLocationCanton({ location: 'Reinach (AG)', canton: 'BL' });
    expect(reconciled.canton).toBe('AG');
    expect(reconciled.addressRegion).toBe('AG');
    expect(jobLocationRedundancy(reconciled.location, reconciled.canton)?.conflict).toBeFalsy();
  });

  it('drains the ❗ conflict class to 0 on a fixture of the Coop conflict shape', () => {
    expect(conflictShape.filter((job) => jobLocationRedundancy(job.location, job.canton)?.conflict).length).toBe(3);
    const remaining = conflictShape
      .map((job) => reconcileCoopLocationCanton(job))
      .filter((job) => jobLocationRedundancy(job.location, job.canton)?.conflict).length;
    expect(remaining).toBe(0);
  });

  it('does not rewrite a pair that already agrees', () => {
    const job = { location: 'Lugano', canton: 'TI', addressRegion: 'TI' };
    expect(reconcileCoopLocationCanton(job)).toBe(job);
  });
});

describe('Coop authoritative detail routing', () => {
  it('resolves localized canton labels and locality across the full Swiss scope', () => {
    expect(resolveCoopCantonCode('Graubünden', '', '')).toBe('GR');
    expect(resolveCoopCantonCode('Nidwaldo', '', '')).toBe('NW');
    expect(resolveCoopCantonCode('', 'Chur', '')).toBe('GR');
    expect(resolveCoopCantonCode('Principato del Liechtenstein', '', '')).toBe('');
  });

  it('publishes the feed allowlist only through explicit detail seeds', () => {
    const seedDetailUrls = [
      frenchDetailFixture.url,
      'https://jobs.coopjobs.ch/offene-stellen/verkaeuferin-verkaeufer/11111111-1111-4111-8111-111111111111',
      'https://jobs.coopjobs.ch/posti-vacanti/venditrice-venditore/22222222-2222-4222-8222-222222222222',
    ];
    const seedMetaByUrl = Object.fromEntries(seedDetailUrls.map((url) => [url, { canton: 'VD' }]));
    const updatedAt = 'fixed-for-test';
    const adapter = buildCoopAdapterConfig(
      { companyKey: 'coop-ticino', seedUrls: ['https://jobs.coopjobs.ch/stellenangebote'] },
      seedDetailUrls,
      seedMetaByUrl,
      updatedAt,
    );

    expect(adapter.seedUrls).toBeUndefined();
    expect(adapter.seedDetailUrls).toEqual(seedDetailUrls);
    expect(adapter.seedMetaByUrl).toEqual(seedMetaByUrl);
    expect(adapter.authoritativeDetailSnapshot).toBe(true);
    expect(adapter.authoritativeLifecycleDomains).toEqual(['jobs.coopjobs.ch']);
    expect(new Set(adapter.seedDetailUrls).size).toBe(seedDetailUrls.length);
    expect(buildCoopAdapterConfig(adapter, seedDetailUrls, seedMetaByUrl, updatedAt)).toEqual(adapter);
  });

  it('writes the feed allowlist atomically and fails closed on a stale or invalid adapter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-adapter-'));
    const adapterPath = path.join(tmpDir, 'coop-ticino.json');
    const urls = [frenchDetailFixture.url];
    const meta = { [urls[0]]: { canton: 'VD', location: 'Chavornay' } };

    expect(ensureAdapterSeedUrls(urls, meta, adapterPath)).toMatchObject({
      seedDetailUrls: urls,
      seedMetaByUrl: meta,
      authoritativeDetailSnapshot: true,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
    });

    fs.writeFileSync(adapterPath, '{ invalid json');
    expect(() => ensureAdapterSeedUrls(urls, meta, adapterPath)).toThrow();
  });

  it('compares adapter metadata structurally, independent of object key order', () => {
    const urls = [
      'https://jobs.coopjobs.ch/offene-stellen/one/11111111-1111-4111-8111-111111111111',
      'https://jobs.coopjobs.ch/offene-stellen/two/22222222-2222-4222-8222-222222222222',
    ];
    const expectedMeta = {
      [urls[0]]: { canton: 'ZH', location: 'Zurich' },
      [urls[1]]: { canton: 'BE', location: 'Bern' },
    };
    const reversedMeta = {
      [urls[1]]: { location: 'Bern', canton: 'BE' },
      [urls[0]]: { location: 'Zurich', canton: 'ZH' },
    };
    const adapter = buildCoopAdapterConfig({}, urls, reversedMeta, 'fixed-for-test');
    expect(assertCoopAdapterParity(adapter, urls, expectedMeta)).toBe(true);
  });

  it('accounts each unique source record and explicit drops', async () => {
    const canonicalUrl = 'https://jobs.coopjobs.ch/offene-stellen/one/11111111-1111-4111-8111-111111111111';
    const secondUrl = 'https://jobs.coopjobs.ch/offene-stellen/two/22222222-2222-4222-8222-222222222222';
    const offHostUrl = 'https://careers.example.com/offene-stellen/three/33333333-3333-4333-8333-333333333333';
    const foreignUrl = 'https://jobs.coopjobs.ch/offene-stellen/four/44444444-4444-4444-8444-444444444444';
    const swissJob = (directlink) => ({
      links: { directlink },
      attributes: { '30': ['Zurigo'], '70': ['Coop Genossenschaft'] },
    });
    const jobs = [
      swissJob(canonicalUrl),
      swissJob(secondUrl),
      swissJob(offHostUrl),
      { ...swissJob(foreignUrl), attributes: { '30': ['Principato del Liechtenstein'] } },
    ];
    const discovery = await fetchCoopJobDetailUrls({
      fetchImpl: async () => new Response(JSON.stringify({ total: jobs.length, jobs }), { status: 200 }),
    });

    expect(discovery).toMatchObject({
      apiTotal: 4,
      fetched: 4,
      urls: [canonicalUrl, secondUrl],
      droppedNonCh: 1,
      droppedMalformedUrl: 1,
      droppedDuplicateUrl: 0,
      droppedDuplicateIdentity: 0,
    });
    expect(assertCompleteCoopDiscovery(discovery)).toBe(true);
  });

  it('prefers a canton encoded in the listing location over a conflicting attr-30 stamp', async () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/reinach/11111111-1111-4111-8111-111111111111';
    const jobs = [{
      links: { directlink: url },
      location: 'Reinach (AG)',
      attributes: { '30': ['Basilea Campagna'], '70': ['Coop Genossenschaft'] },
    }];
    const discovery = await fetchCoopJobDetailUrls({
      fetchImpl: async () => new Response(JSON.stringify({ total: 1, jobs }), { status: 200 }),
    });
    expect(discovery.seedMetaByUrl[url]).toMatchObject({ location: 'Reinach (AG)', canton: 'AG' });
    expect(jobLocationRedundancy(
      discovery.seedMetaByUrl[url].location,
      discovery.seedMetaByUrl[url].canton,
    )?.conflict).toBeFalsy();
  });

  it('prefers the explicit workplace city over the generic API location', async () => {
    const url = 'https://jobs.coopjobs.ch/posti-vacanti/addetto-vendita/11111111-1111-4111-8111-111111111111';
    const jobs = [{
      links: { directlink: url },
      location: 'Gossau',
      attributes: { '30': ['Ticino'], '70': ['Coop Genossenschaft'] },
      szas: {
        'sza_workplace.city': 'Mendrisio',
        'sza_workplace.zip': '6850',
        'sza_workplace.street': 'Via Ligornetto 1',
      },
    }];
    const discovery = await fetchCoopJobDetailUrls({
      fetchImpl: async () => new Response(JSON.stringify({ total: 1, jobs }), { status: 200 }),
    });

    expect(discovery.seedMetaByUrl[url]).toMatchObject({
      location: 'Mendrisio',
      canton: 'TI',
      preferWorkplaceLocation: true,
    });
  });

  it('reconciles a Coop regional label ending in an Aargau code', () => {
    const reconciled = reconcileCoopLocationCanton({ location: 'Region Muri AG', canton: 'BS' });
    expect(reconciled).toMatchObject({
      location: 'Region Muri AG',
      canton: 'AG',
      addressRegion: 'AG',
    });
    expect(jobLocationRedundancy(reconciled.location, reconciled.canton)?.conflict).toBeFalsy();
  });

  it('accepts the live Prospective location-city field variant', async () => {
    const url = 'https://jobs.coopjobs.ch/posti-vacanti/addetto-vendita/22222222-2222-4222-8222-222222222222';
    const jobs = [{
      links: { directlink: url },
      location: 'Gossau',
      attributes: { '30': ['Ticino'], '70': ['Coop Genossenschaft'] },
      szas: { 'sza_location.city': 'Bioggio' },
    }];
    const discovery = await fetchCoopJobDetailUrls({
      fetchImpl: async () => new Response(JSON.stringify({ total: 1, jobs }), { status: 200 }),
    });

    expect(discovery.seedMetaByUrl[url]).toMatchObject({
      location: 'Bioggio',
      canton: 'TI',
      preferWorkplaceLocation: true,
    });
  });

  it('fails closed when a partially repeated page cannot prove unique progress', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => makeCoopApiJob(index));
    const mixedPage = [...firstPage.slice(1), makeCoopApiJob(500)];
    const fetchImpl = vi.fn(async (url) => {
      const offset = new URL(url).searchParams.get('offset');
      const jobs = offset === '0' ? firstPage : offset === '500' ? mixedPage : [];
      return new Response(JSON.stringify({ total: 1000, jobs }), { status: 200 });
    });

    await expect(fetchCoopJobDetailUrls({ fetchImpl }))
      .rejects.toThrow(/incomplete/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed when a page adds no unique source records', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => makeCoopApiJob(index));
    const fetchImpl = vi.fn(async (url) => {
      const offset = new URL(url).searchParams.get('offset');
      const jobs = offset === '0' || offset === '500' ? firstPage : [];
      return new Response(JSON.stringify({ total: 1000, jobs }), { status: 200 });
    });

    await expect(fetchCoopJobDetailUrls({ fetchImpl }))
      .rejects.toThrow(/added no unique source records/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a partial or internally inconsistent authoritative feed', () => {
    expect(() => assertCompleteCoopDiscovery({
      apiTotal: null,
      fetched: 0,
      droppedNonCh: 0,
      urls: [],
      seedMetaByUrl: {},
    })).toThrow(/did not expose a non-negative integer total/);

    expect(() => assertCompleteCoopDiscovery({
      apiTotal: 500,
      fetched: 499,
      droppedNonCh: 0,
      urls: Array.from({ length: 499 }, (_, index) => `https://jobs.coopjobs.ch/job/${index}`),
      seedMetaByUrl: {},
    })).toThrow(/fetched 499\/500/);

    expect(() => assertCompleteCoopDiscovery({
      apiTotal: 2,
      fetched: 2,
      droppedNonCh: 0,
      urls: ['https://jobs.coopjobs.ch/job/one'],
      seedMetaByUrl: { 'https://jobs.coopjobs.ch/job/one': { canton: 'ZH' } },
    })).toThrow(/discovery invariant failed/);

    const offHost = 'https://careers.example.com/job/55555555-5555-4555-8555-555555555555';
    expect(() => assertCompleteCoopDiscovery({
      apiTotal: 1,
      fetched: 1,
      droppedNonCh: 0,
      urls: [offHost],
      seedMetaByUrl: { [offHost]: { canton: 'ZH' } },
    })).toThrow(/trusted-hosts=false/);
  });

  it('fails closed on API total drift and on the pagination safety ceiling', () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/one/88888888-8888-4888-8888-888888888888';
    const complete = {
      apiTotal: 1,
      fetched: 1,
      droppedNonCh: 0,
      droppedMalformedUrl: 0,
      droppedDuplicateUrl: 0,
      droppedDuplicateIdentity: 0,
      urls: [url],
      seedMetaByUrl: { [url]: { canton: 'ZH' } },
    };
    expect(() => assertCompleteCoopDiscovery({ ...complete, apiTotals: [1, 2] }))
      .toThrow(/totals=1,2/);
    expect(() => assertCompleteCoopDiscovery({
      ...complete,
      apiTotal: 10_001,
      apiTotals: [10_001],
      fetched: 10_000,
    })).toThrow(/fetched 10000\/10001/);
  });

  it('ages only feed-absent Coop identities across the homepage-to-ATS boundary', () => {
    const presentOldUrl = 'https://jobs.coopjobs.ch/offene-stellen/old-title/11111111-1111-4111-8111-111111111111';
    const presentFeedUrl = 'https://jobs.coopjobs.ch/postes-vacantes/new-title/11111111-1111-4111-8111-111111111111';
    const absentUrl = 'https://jobs.coopjobs.ch/offene-stellen/closed/22222222-2222-4222-8222-222222222222';
    const existing = [
      {
        id: 'present',
        companyKey: 'coop-ticino',
        source: 'Company Careers Crawler',
        url: presentOldUrl,
        crawlerMissStreak: 1,
        slug: 'present-route',
        previousSlugs: ['present-legacy-route'],
      },
      {
        id: 'absent',
        companyKey: 'coop-ticino',
        source: 'Company Careers Crawler',
        url: absentUrl,
        slug: 'absent-route',
        previousSlugs: ['absent-legacy-route'],
        previousSlugsByLocale: { fr: ['ancienne-route'] },
      },
      {
        id: 'sibling',
        companyKey: 'fust',
        source: 'Company Careers Crawler',
        url: 'https://jobs.coopjobs.ch/offene-stellen/fust/33333333-3333-4333-8333-333333333333',
      },
    ];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url: presentFeedUrl })],
      },
    };
    expect(fingerprintJob({ url: presentOldUrl })).toBe(fingerprintJob({ url: presentFeedUrl }));

    const first = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(first.removed).toBe(0);
    expect(first.prunedExisting).toEqual([
      expect.objectContaining({ id: 'present', slug: 'present-route', previousSlugs: ['present-legacy-route'] }),
      expect.objectContaining({
        id: 'absent',
        crawlerMissStreak: 1,
        slug: 'absent-route',
        previousSlugs: ['absent-legacy-route'],
        previousSlugsByLocale: { fr: ['ancienne-route'] },
      }),
      existing[2],
    ]);
    expect(first.prunedExisting[0]).not.toHaveProperty('crawlerMissStreak');

    const second = sharedCrawlerTestables.pruneStaleCrawlerJobs(first.prunedExisting, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(second.prunedExisting.find((job) => job.id === 'absent')?.crawlerMissStreak).toBe(2);
    const third = sharedCrawlerTestables.pruneStaleCrawlerJobs(second.prunedExisting, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(third.removed).toBe(1);
    expect(third.prunedExisting.map((job) => job.id)).toEqual(['present', 'sibling']);
  });

  it('maps a legacy record without companyKey to the only scoped crawler key', () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/legacy/55555555-5555-4555-8555-555555555555';
    const existing = [{
      id: 'legacy',
      company: 'Coop Genossenschaft',
      source: 'Company Careers Crawler',
      url,
      crawlerMissStreak: 1,
      previousSlugs: ['legacy-route'],
    }];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeLegacyCompanyAliases: ['coop genossenschaft'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url })],
      },
    };
    const { prunedExisting, removed } = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(removed).toBe(0);
    expect(prunedExisting).toEqual([expect.objectContaining({ id: 'legacy', previousSlugs: ['legacy-route'] })]);
    expect(prunedExisting[0]).not.toHaveProperty('crawlerMissStreak');
    expect(prunedExisting[0].previousSlugs).toEqual(['legacy-route']);
  });

  it('never reassigns a legacy record without companyKey when scopeCompanyKeys is empty (unscoped run)', () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/legacy/55555555-5555-4555-8555-555555555555';
    const existing = [{
      id: 'legacy',
      company: 'Coop Genossenschaft',
      source: 'Company Careers Crawler',
      url,
      previousSlugs: ['legacy-route'],
    }];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeLegacyCompanyAliases: ['coop genossenschaft'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url })],
      },
    };
    const { prunedExisting, removed } = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: [],
    });
    expect(removed).toBe(0);
    expect(prunedExisting).toHaveLength(1);
    expect(prunedExisting[0]).not.toHaveProperty('companyKey');
    expect(prunedExisting[0].previousSlugs).toEqual(['legacy-route']);
  });

  it('never reassigns a legacy record without companyKey when scopeCompanyKeys has multiple entries', () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/legacy/55555555-5555-4555-8555-555555555555';
    const existing = [{
      id: 'legacy',
      company: 'Coop Genossenschaft',
      source: 'Company Careers Crawler',
      url,
      previousSlugs: ['legacy-route'],
    }];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeLegacyCompanyAliases: ['coop genossenschaft'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url })],
      },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { prunedExisting, removed } = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino', 'fust'],
    });
    expect(removed).toBe(0);
    expect(prunedExisting).toEqual([existing[0]]);
    expect(prunedExisting[0]).not.toHaveProperty('companyKey');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('legacy alias fallback'));
    warnSpy.mockRestore();
  });

  it('does not scope a legacy sibling without companyKey to Coop', () => {
    const sibling = {
      id: 'legacy-jumbo',
      company: 'Jumbo, Division der Coop Genossenschaft',
      source: 'Company Careers Crawler',
      url: 'https://jobs.coopjobs.ch/offene-stellen/jumbo/99999999-9999-4999-8999-999999999999',
      previousSlugs: ['jumbo-legacy-route'],
    };
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeLegacyCompanyAliases: ['coop', 'coop genossenschaft', 'coop city'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': ['id|coopjobs.ch|11111111-1111-4111-8111-111111111111'],
      },
    };
    expect(sharedCrawlerTestables.pruneStaleCrawlerJobs([sibling], [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    })).toEqual({ prunedExisting: [sibling], removed: 0 });
  });

  it('keeps authoritative fingerprints separated by lifecycle domain', () => {
    const coopUrl = 'https://jobs.coopjobs.ch/offene-stellen/coop/66666666-6666-4666-8666-666666666666';
    const otherUrl = 'https://careers.example.ch/job/77777777-7777-4777-8777-777777777777';
    const existing = [{
      id: 'coop-domain-only',
      companyKey: 'coop-ticino',
      source: 'Company Careers Crawler',
      url: coopUrl,
    }];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch', 'careers.example.ch'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url: otherUrl })],
        'careers.example.ch': [fingerprintJob({ url: coopUrl })],
      },
    };
    const { prunedExisting } = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(prunedExisting[0].crawlerMissStreak).toBe(1);
  });

  it('does not apply cross-domain lifecycle to a non-authoritative feed', () => {
    const existing = [{
      id: 'kept',
      companyKey: 'coop-ticino',
      source: 'Company Careers Crawler',
      url: 'https://jobs.coopjobs.ch/offene-stellen/kept/44444444-4444-4444-8444-444444444444',
    }];
    const result = { companyKey: 'coop-ticino', companyDomain: 'coop.ch', processedCandidates: 1 };
    expect(sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    })).toEqual({ prunedExisting: existing, removed: 0 });
  });

  it('routes the representative French detail only when the feed declares it', () => {
    const seedMeta = { location: 'Chavornay', canton: 'VD', company: 'Coop Genossenschaft' };
    expect(sharedCrawlerTestables.toJobFromJsonLd(
      frenchDetailFixture.jsonLd,
      'Coop',
      frenchDetailFixture.url,
      { seedMeta },
    )).toMatchObject({ job: null, reason: 'jsonld_not_detail_url' });

    expect(sharedCrawlerTestables.toJobFromJsonLd(
      frenchDetailFixture.jsonLd,
      'Coop',
      frenchDetailFixture.url,
      { seedMeta, isSeedDetail: true },
    )).toMatchObject({
      reason: null,
      job: {
        url: frenchDetailFixture.url,
        company: 'Coop Genossenschaft',
        location: 'Chavornay, Vaud',
        canton: 'VD',
      },
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Real HTML fixtures from Coop detail pages
// ──────────────────────────────────────────────────────────────

const FIXTURE_DETAIL1_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Detailhandelsfachfrau:mann / -assistent:in",
  "datePosted": "2025-09-26",
  "employmentType": "FULL_TIME",
  "description": "<p><div>Deine Aufgaben</div><br><ul><li>Du erhältst an 2 Tagen einen abwechslungsreichen Einblick in den Beruf.</li><li>Du darfst aktiv mitarbeiten.</li><li>Du lernst das Unternehmen kennen.</li></ul></p><br><p><div>Das bringst du mit</div><br><ul><li>Du bist interessiert den Lehrberuf kennen zu lernen.</li><li>Du bist motiviert und hast Freude am Umgang mit Kund:innen.</li><li>Du befindest dich in der 7. oder 8. Schulstufe.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Spannende Einblicke in die Welt des Detailhandels.</li><li>Persönliche Betreuung während der Schnupperlehre.</li><li>Die Möglichkeit, erste Berufserfahrungen zu sammeln.</li></ul></p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Coop"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "Schweiz",
      "addressLocality": "Dietlikon",
      "addressRegion": "Dietlikon"
    }
  }
}
</script>`;

const FIXTURE_DETAIL2_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Verkaufsberater:in Textil",
  "datePosted": "2026-03-05",
  "employmentType": "PART_TIME",
  "description": "<p><div>Aufgaben</div><br><ul><li>Mit deiner freundlichen und fachkompetenten Beratung begeisterst du unsere Kundschaft.</li><li>Du hältst dich an die internen Vorgaben und so stellst du sicher, dass die Waren attraktiv präsentiert sind.</li><li>Mit der Ware auf unserer Verkaufsfläche und im Lager gehst du sorgfältig um und du erledigst die anfallenden Unterhaltsarbeiten.</li></ul></p><br><p><div>Anforderungen</div><br><ul><li>Du besitzt eine abgeschlossene Grundbildung und hast Erfahrung im Detailhandel, vorzugsweise im Bekleidungsbereich.</li><li>Du bist eine kundenorientierte Persönlichkeit, die sich für Mode begeistert.</li><li>Du kommunizierst stilsicher in Deutsch und verfügst über weitere Sprachkenntnisse.</li><li>Du bist flexibel, motiviert und ein:e Teamplayer:in.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Abwechslungsreiche und verantwortungsvolle Tätigkeit.</li><li>Zeitgemässe Anstellungsbedingungen mit Personalrabatt und weiteren Benefits.</li><li>Gute Sozialleistungen und mindestens fünf Wochen Ferien.</li><li>Möglichkeiten sich persönlich und fachlich weiterzuentwickeln.</li></ul></p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Coop City"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "Schweiz",
      "addressLocality": "Chur",
      "addressRegion": "Graubünden"
    }
  }
}
</script>`;

const FIXTURE_DESC_HTML_1 = `<p><div>Deine Aufgaben</div><br><ul><li>Du erhältst an 2 Tagen einen abwechslungsreichen Einblick in den Beruf.</li><li>Du darfst aktiv mitarbeiten.</li><li>Du lernst das Unternehmen kennen.</li></ul></p><br><p><div>Das bringst du mit</div><br><ul><li>Du bist interessiert den Lehrberuf kennen zu lernen.</li><li>Du bist motiviert und hast Freude am Umgang mit Kund:innen.</li><li>Du befindest dich in der 7. oder 8. Schulstufe.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Spannende Einblicke in die Welt des Detailhandels.</li><li>Persönliche Betreuung während der Schnupperlehre.</li><li>Die Möglichkeit, erste Berufserfahrungen zu sammeln.</li></ul></p>`;

const FIXTURE_DESC_HTML_2 = `<p><div>Aufgaben</div><br><ul><li>Mit deiner freundlichen und fachkompetenten Beratung begeisterst du unsere Kundschaft.</li><li>Du hältst dich an die internen Vorgaben und so stellst du sicher, dass die Waren attraktiv präsentiert sind.</li><li>Mit der Ware auf unserer Verkaufsfläche und im Lager gehst du sorgfältig um und du erledigst die anfallenden Unterhaltsarbeiten.</li></ul></p><br><p><div>Anforderungen</div><br><ul><li>Du besitzt eine abgeschlossene Grundbildung und hast Erfahrung im Detailhandel, vorzugsweise im Bekleidungsbereich.</li><li>Du bist eine kundenorientierte Persönlichkeit, die sich für Mode begeistert.</li><li>Du kommunizierst stilsicher in Deutsch und verfügst über weitere Sprachkenntnisse.</li><li>Du bist flexibel, motiviert und ein:e Teamplayer:in.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Abwechslungsreiche und verantwortungsvolle Tätigkeit.</li><li>Zeitgemässe Anstellungsbedingungen mit Personalrabatt und weiteren Benefits.</li><li>Gute Sozialleistungen und mindestens fünf Wochen Ferien.</li><li>Möglichkeiten sich persönlich und fachlich weiterzuentwickeln.</li></ul></p>`;

// ──────────────────────────────────────────────────────────────
// extractJsonLd tests
// ──────────────────────────────────────────────────────────────

describe('extractJsonLd — Coop pages', () => {
  it('extracts JobPosting from detail page 1', () => {
    const ld = extractJsonLd(FIXTURE_DETAIL1_JSONLD);
    expect(ld).not.toBeNull();
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.title).toBe('Detailhandelsfachfrau:mann / -assistent:in');
  });

  it('extracts JobPosting from detail page 2', () => {
    const ld = extractJsonLd(FIXTURE_DETAIL2_JSONLD);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Verkaufsberater:in Textil');
    expect(ld.hiringOrganization.name).toBe('Coop City');
  });

  it('returns null for pages without JSON-LD', () => {
    expect(extractJsonLd('<html><body>No JSON-LD here</body></html>')).toBeNull();
  });

  // Markup-drift resilience — mirrors the permissive Straumann extractor so a
  // silent regex/`@type` miss never drops a recoverable Coop listing (#1792).
  it('tolerates single-quoted type attribute and reordered attributes', () => {
    const html = `<script data-x="1" type='application/ld+json'>
      {"@type":"JobPosting","title":"Single-quoted","description":"x"}
    </script>`;
    const ld = extractJsonLd(html);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Single-quoted');
  });

  it('matches @type as an array', () => {
    const html = `<script type="application/ld+json">
      {"@type":["JobPosting","WPHeader"],"title":"Array type"}
    </script>`;
    const ld = extractJsonLd(html);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Array type');
  });

  it('extracts JobPosting nested in @graph', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebPage"},{"@type":"JobPosting","title":"Graph job"}]}
    </script>`;
    const ld = extractJsonLd(html);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Graph job');
  });
});

// ──────────────────────────────────────────────────────────────
// coopDescHtmlToMarkdown tests
// ──────────────────────────────────────────────────────────────

describe('coopDescHtmlToMarkdown', () => {
  it('converts detail 1 description to markdown ≥ 350 chars', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md.length).toBeGreaterThanOrEqual(350);
  });

  it('preserves section headers from detail 1', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).toContain('## Deine Aufgaben');
    expect(md).toContain('## Das bringst du mit');
    expect(md).toContain('## Was wir bieten');
  });

  it('preserves list items from detail 1', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).toContain('- Du erhältst an 2 Tagen');
    expect(md).toContain('- Du darfst aktiv mitarbeiten');
    expect(md).toContain('- Spannende Einblicke');
  });

  it('converts detail 2 description to markdown ≥ 400 chars', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md.length).toBeGreaterThanOrEqual(400);
  });

  it('preserves detail 2 sections', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md).toContain('## Aufgaben');
    expect(md).toContain('## Anforderungen');
    expect(md).toContain('## Was wir bieten');
  });

  it('preserves detail 2 content', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md).toContain('Beratung begeisterst du unsere Kundschaft');
    expect(md).toContain('Bekleidungsbereich');
    expect(md).toContain('Personalrabatt');
  });

  it('does not contain raw HTML tags', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).not.toMatch(/<(div|span|p|ul|li|br)\b/);
  });

  it('returns empty for empty input', () => {
    expect(coopDescHtmlToMarkdown('')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// validateCoopDescription tests
// ──────────────────────────────────────────────────────────────

describe('validateCoopDescription', () => {
  it('passes for detail 1 markdown', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    const result = validateCoopDescription(md, FIXTURE_DESC_HTML_1.length);
    expect(result.ok).toBe(true);
  });

  it('passes for detail 2 markdown', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    const result = validateCoopDescription(md, FIXTURE_DESC_HTML_2.length);
    expect(result.ok).toBe(true);
  });

  it('fails for very short description', () => {
    const result = validateCoopDescription('Short text', 1000);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('too short'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// titleOverlap tests
// ──────────────────────────────────────────────────────────────

describe('titleOverlap — Coop titles', () => {
  it('returns 1 for exact match', () => {
    expect(titleOverlap('Verkaufsberater:in Textil', 'Verkaufsberater:in Textil')).toBe(1);
  });

  it('handles colon-style Swiss German titles', () => {
    expect(
      titleOverlap('Detailhandelsfachfrau:mann / -assistent:in', 'Detailhandelsfachfrau:mann / -assistent:in')
    ).toBe(1);
  });

  it('returns high overlap when OG title adds company prefix', () => {
    // OG: "Coop City: Verkaufsberater:in Textil" vs stored: "Verkaufsberater:in Textil"
    expect(titleOverlap('Verkaufsberater:in Textil', 'Coop City: Verkaufsberater:in Textil')).toBeGreaterThanOrEqual(0.6);
  });

  it('returns low overlap for different roles', () => {
    expect(titleOverlap('Logistiker:in EBA', 'Verkaufsberater:in Textil')).toBeLessThan(0.5);
  });

  it('returns 1 for empty expected', () => {
    expect(titleOverlap('', 'anything')).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────
// applyCoopJsonLdToJob tests
// ──────────────────────────────────────────────────────────────

describe('applyCoopJsonLdToJob — location update from JSON-LD', () => {
  it('updates location and addressLocality when JSON-LD has different locality', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Castione',
      addressLocality: 'Castione',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Canobbio',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.location).toBe('Canobbio');
    expect(updated.addressLocality).toBe('Canobbio');
    // Canton stays TI since "Ticino" normalizes to TI (same as before)
    expect(updated.canton).toBe('TI');
  });

  it('updates canton when JSON-LD addressRegion differs', () => {
    const job = {
      title: 'Logistiker:in',
      location: 'Ticino',
      addressLocality: 'Ticino',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Chur',
          addressRegion: 'Graubünden',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.location).toBe('Chur');
    expect(updated.addressLocality).toBe('Chur');
    expect(updated.canton).toBe('GR');
    expect(updated.addressRegion).toBe('GR');
  });

  it('keeps an explicit adapter workplace when detail JSON-LD carries the employer address', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Basel',
      addressLocality: 'Basel',
      canton: 'BS',
      addressRegion: 'BS',
      company: 'Coop',
      _targetScope: {
        type: 'adapter_seed_meta',
        location: 'Region Zürich (Sihlcity und Umgebung)',
        canton: 'ZH',
      },
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Basel',
          addressRegion: 'Basel-Stadt',
          addressCountry: 'CH',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };

    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);

    expect(changed).toBe(true);
    expect(updated.location).toBe('Region Zürich (Sihlcity und Umgebung)');
    expect(updated.addressLocality).toBe('Region Zürich (Sihlcity und Umgebung)');
    expect(updated.canton).toBe('ZH');
    expect(updated.addressRegion).toBe('ZH');
  });

  it('keeps the adapter canton when the same locality resolves differently in detail JSON-LD', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Muri',
      addressLocality: 'Muri',
      canton: 'BE',
      addressRegion: 'BE',
      company: 'Coop',
      _targetScope: {
        type: 'adapter_seed_meta',
        location: 'Muri',
        canton: 'BE',
      },
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Muri',
          addressRegion: 'AG',
          addressCountry: 'CH',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };

    const { job: updated } = applyCoopJsonLdToJob(job, jsonLd);

    expect(updated.location).toBe('Muri');
    expect(updated.canton).toBe('BE');
    expect(updated.addressRegion).toBe('BE');
  });

  it('keeps a source-backed regional wrapper when the generic resolver cannot reduce it to one city', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Basel',
      addressLocality: 'Basel',
      canton: 'BS',
      addressRegion: 'BS',
      company: 'Coop',
      _targetScope: {
        type: 'adapter_seed_meta',
        location: 'Region Muri AG',
        canton: 'AG',
      },
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Basel',
          addressRegion: 'Basel-Stadt',
          addressCountry: 'CH',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };

    const { job: updated } = applyCoopJsonLdToJob(job, jsonLd);

    expect(updated.location).toBe('Region Muri AG');
    expect(updated.addressLocality).toBe('Region Muri AG');
    expect(updated.canton).toBe('AG');
    expect(updated.addressRegion).toBe('AG');
  });

  it('updates company when JSON-LD has a more specific store name', () => {
    const job = {
      title: 'Verkaufsberater:in Textil',
      location: 'Chur',
      addressLocality: 'Chur',
      canton: 'GR',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Chur',
          addressRegion: 'Graubünden',
        },
      },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.company).toBe('Coop City');
  });

  it('does not update company when JSON-LD name is short (<=4 chars)', () => {
    const job = {
      title: 'Logistiker:in',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      company: 'Coop Ticino',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Lugano',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    // "Coop" is only 4 chars, should not replace "Coop Ticino"
    expect(updated.company).toBe('Coop Ticino');
  });

  it('returns changed=false when JSON-LD matches existing job data', () => {
    const job = {
      title: 'Test Job',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop City',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Lugano',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Lugano');
    expect(updated.company).toBe('Coop City');
  });

  it('handles null/missing JSON-LD gracefully', () => {
    const job = {
      title: 'Test',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      company: 'Coop',
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, null);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Lugano');
  });

  it('handles JSON-LD with empty jobLocation', () => {
    const job = {
      title: 'Test',
      location: 'Bellinzona',
      addressLocality: 'Bellinzona',
      canton: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {},
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Bellinzona');
  });
});

// ──────────────────────────────────────────────────────────────
// applyCoopJsonLdToJob — concurrency safety (follow-up #1883 item 2)
//
// The Coop post-process pass fetches/repairs jobs from a bounded pool of
// up to 12 concurrent workers (JOBS_COOP_DETAIL_CONCURRENCY in
// scripts/update-coop-jobs.mjs). That is only safe if applyCoopJsonLdToJob
// holds NO module-level mutable state (Map/Set/cache) and NEVER mutates the
// caller's `job` object — otherwise two workers could corrupt each other's
// jobs → wrong description/location assigned to the wrong listing across
// ~2200 pages. The function is currently a pure transform (shallow-copies via
// `{...job}` and returns `{ job, changed }`); these tests lock that invariant
// so a future refactor that introduces a shared cache fails loudly.
// ──────────────────────────────────────────────────────────────

describe('applyCoopJsonLdToJob — concurrency safety', () => {
  it('does not mutate the input job (returns a distinct object)', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Castione',
      addressLocality: 'Castione',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const snapshot = JSON.parse(JSON.stringify(job));
    const jsonLd = {
      jobLocation: { address: { addressLocality: 'Chur', addressRegion: 'Graubünden' } },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated } = applyCoopJsonLdToJob(job, jsonLd);
    // Original is untouched…
    expect(job).toEqual(snapshot);
    // …and the returned object is a different reference carrying the changes.
    expect(updated).not.toBe(job);
    expect(updated.addressLocality).toBe('Chur');
    expect(updated.company).toBe('Coop City');
  });

  it('keeps interleaved calls independent (no cross-call state leakage)', () => {
    // Simulate two pool workers whose calls interleave: build both inputs,
    // apply in alternating order, and assert neither result bleeds into the
    // other. A module-level cache keyed by anything shared would fail here.
    const jobA = { title: 'A', location: 'Lugano', addressLocality: 'Lugano', canton: 'TI', addressRegion: 'TI', company: 'Coop' };
    const jobB = { title: 'B', location: 'Bellinzona', addressLocality: 'Bellinzona', canton: 'TI', addressRegion: 'TI', company: 'Coop' };
    const ldA = { jobLocation: { address: { addressLocality: 'Chur', addressRegion: 'Graubünden' } }, hiringOrganization: { name: 'Coop City' } };
    const ldB = { jobLocation: { address: { addressLocality: 'Canobbio', addressRegion: 'Ticino' } }, hiringOrganization: { name: 'Coop Pronto' } };

    const r1 = applyCoopJsonLdToJob(jobA, ldA);
    const r2 = applyCoopJsonLdToJob(jobB, ldB);
    const r3 = applyCoopJsonLdToJob(jobA, ldA); // re-run A after B ran

    expect(r1.job.addressLocality).toBe('Chur');
    expect(r1.job.canton).toBe('GR');
    expect(r1.job.company).toBe('Coop City');

    expect(r2.job.addressLocality).toBe('Canobbio');
    expect(r2.job.canton).toBe('TI');
    expect(r2.job.company).toBe('Coop Pronto');

    // Deterministic: A produces the same result regardless of B running between.
    expect(r3.job).toEqual(r1.job);
  });
});

describe('Coop-family source-detail contract (#5253)', () => {
  const cases = [
    ['fust', 'https://jobs.fust.ch/offene-stellen/test/11111111-1111-4111-8111-111111111111', 'Oberbüren', 'St. Gallen', 'SG'],
    ['interdiscount', 'https://jobs.coopjobs.ch/offene-stellen/test/22222222-2222-4222-8222-222222222222', 'Jegenstorf', 'Jegenstorf', 'BE'],
    ['jumbo', 'https://jobs.coopjobs.ch/offene-stellen/test/33333333-3333-4333-8333-333333333333', 'Dietikon', 'Zürich', 'ZH'],
    ['volg-fenaco', 'https://jobs.fenaco.com/offene-stellen/test/44444444-4444-4444-8444-444444444444', 'Höri', 'Zürcher Unterland/Limmattal', 'ZH'],
  ] as const;
  const detailDescription = `<h2>Deine Aufgaben</h2><ul>${Array.from({ length: 26 }, (_, index) => `<li>Source-backed Aufgabe ${index + 1} mit Verantwortung und sorgfältiger Zusammenarbeit im Team.</li>`).join('')}</ul>`;

  function jsonLd(title: string, locality: string, region: string) {
    return {
      '@type': 'JobPosting',
      title,
      description: detailDescription,
      jobLocation: { address: { addressLocality: locality, addressRegion: region, addressCountry: 'Schweiz', postalCode: '3000', streetAddress: 'Detailstrasse 1' } },
    };
  }

  it('includes word and text counts when validation emits warnings (#7884)', () => {
    const [companyKey, url, locality, region] = cases[0];
    const listing = {
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    const detail = { ...jsonLd(listing.title, locality, region), description: '<p>Kurze Anzeige.</p>' };

    expect(() => applyCoopSourceDetailToJob(listing, detail)).toThrow(
      /2 words, \d+ chars\): Description too short/,
    );
  });

  // The floor is the shared source-body WORD floor (source-body-floor.mjs):
  // 49 long words clear the former 200-character minimum by far and are still
  // not published; 50 are. Markdown markers ("##", "-") are not words.
  it('rejects a 49-word body however many characters it has, and publishes 50 words (#7884)', () => {
    const [companyKey, url, locality, region] = cases[0];
    const listing = {
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    const detailWith = (words: number) => ({
      ...jsonLd(listing.title, locality, region),
      // "Aufgaben" + (words - 1) long tokens.
      description: `<h2>Aufgaben</h2><ul><li>${Array.from({ length: words - 1 }, (_, index) => `Verantwortungsbereich${index + 1}`).join(' ')}</li></ul>`,
    });
    const fortyNine = detailWith(49);
    expect(coopDescHtmlToMarkdown(fortyNine.description).length).toBeGreaterThan(1000);

    expect(() => applyCoopSourceDetailToJob(listing, fortyNine)).toThrow(
      /49 words, \d+ chars\): Description too short: 49 words \(minimum 50\)/,
    );
    expect(applyCoopSourceDetailToJob(listing, detailWith(50))).toMatchObject({ _enrichedFromDetail: true });
  });

  it.each(cases)('%s replaces listing fallbacks without changing identity or route history', (companyKey, url, locality, region, canton) => {
    const listing = {
      id: `${companyKey}-stable`, url, companyKey, title: 'Verkäuferin Verkäufer',
      description: 'Listing boilerplate that must disappear',
      descriptionByLocale: { de: 'Listing boilerplate that must disappear' },
      location: 'Fallback Hauptsitz', canton: 'TI', slug: `${companyKey}-stable-route`,
      slugByLocale: { de: `${companyKey}-stable-route` }, previousSlugs: [`${companyKey}-legacy`],
      previousSlugsByLocale: { de: [`${companyKey}-legacy-de`] }, sourceLang: 'de',
    };
    const identity = Object.fromEntries(['id', 'url', 'slug', 'slugByLocale', 'previousSlugs', 'previousSlugsByLocale'].map((key) => [key, structuredClone(listing[key as keyof typeof listing])]));
    const result = applyCoopSourceDetailToJob(listing, jsonLd(listing.title, locality, region));

    expect(result).toMatchObject({ location: locality, addressLocality: locality, canton, addressRegion: canton });
    expect(result.description).not.toContain('Listing boilerplate');
    expect(result.description.trim().split(/\s+/).length).toBeGreaterThanOrEqual(50);
    for (const [key, value] of Object.entries(identity)) expect(result[key]).toEqual(value);
  });

  it('fails the whole enrichment before publishing a partial or malformed detail batch', async () => {
    // A batch-wide loss of the JSON-LD is the ATS drift the enricher exists to
    // catch: below the drift share a bad payload is dropped one vacancy at a
    // time (#7179), above it the batch still fails closed.
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => String(input).includes('11111111')
      ? new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 })
      : new Response('<html>missing JSON-LD</html>', { status: 200 });

    await expect(enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2 }))
      .rejects.toThrow(/3\/4 rejected/);
    expect(jobs.every((job) => job.description === 'listing fallback')).toBe(true);
  });

  it('drops a single unusable detail payload instead of failing the whole crawl (#7179)', async () => {
    // One 37-word fenaco posting among 677 made `Run volg` fail on every run:
    // the vacancy is unpublishable, the other 676 are not.
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const thin = { ...jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'), description: '<p>Kurze Anzeige.</p>' };
    const fetchImpl = async (input: URL) => new Response(
      `<script type="application/ld+json">${JSON.stringify(String(input).includes('44444444') ? thin : jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`,
      { status: 200 },
    );

    const rejected: string[] = [];
    const enriched = await enrichCoopSourceBackedJobs(jobs, {
      fetchImpl, concurrency: 2, onRejected: (urls) => rejected.push(...urls),
    });
    expect(enriched).toHaveLength(jobs.length - 1);
    expect(enriched.map((job) => job.id)).not.toContain('volg-fenaco-stable');
    expect(rejected).toEqual([jobs.find((job) => job.url.includes('44444444'))!.url]);
    // Survivors are still source-backed, never the listing fallback.
    expect(enriched.every((job) => job.location === 'Oberbüren' && job._enrichedFromDetail)).toBe(true);
  });

  it('counts gone and rejected pages against one drift budget', async () => {
    // Split evenly, neither half crosses the ratio on its own — but the batch
    // has lost half its detail payloads, which is drift either way.
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => {
      if (String(input).includes('11111111') || String(input).includes('22222222')) {
        return new Response(null, { status: 410 });
      }
      return new Response('<html>missing JSON-LD</html>', { status: 200 });
    };

    await expect(enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2 }))
      .rejects.toThrow(/2\/4 pages gone .*, 2\/4 rejected/);
  });

  it('uses an explicit drop denominator while keeping the input-length default (#7887)', async () => {
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => {
      if (String(input).includes('11111111') || String(input).includes('22222222')) {
        return new Response(null, { status: 410 });
      }
      return new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 });
    };

    await expect(enrichCoopSourceBackedJobs(jobs, {
      fetchImpl,
      concurrency: 2,
      dropBudgetDenominator: 2,
    })).rejects.toThrow(/2\/4 pages gone/);

    const defaultEnriched = await enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2 });
    expect(defaultEnriched).toHaveLength(2);
    expect(defaultEnriched.detailDrop).toEqual({ candidates: 4, gone: 2, rejected: 0, dropped: 2 });
  });

  it('drops a withdrawn vacancy (HTTP 410) instead of failing the whole crawl (#6659)', async () => {
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => String(input).includes('22222222')
      ? new Response(null, { status: 410 })
      : new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 });

    const enriched = await enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2 });
    expect(enriched).toHaveLength(jobs.length - 1);
    expect(enriched.map((job) => job.id)).not.toContain('interdiscount-stable');
    // Survivors are source-backed, never the listing fallback.
    expect(enriched.every((job) => job.location === 'Oberbüren' && job._enrichedFromDetail)).toBe(true);
  });

  it('reports the gone detail URLs so a listing-derived source-of-truth can retire them', async () => {
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => String(input).includes('22222222')
      ? new Response(null, { status: 410 })
      : new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 });

    const gone: string[] = [];
    await enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2, onGone: (urls) => gone.push(...urls) });
    expect(gone).toEqual([jobs.find((job) => job.url.includes('22222222'))!.url]);
  });

  it('reports collected drops before rethrowing an untagged worker error (#7886)', async () => {
    const jobs = cases.slice(0, 2).map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    jobs[1].url = 'https://untrusted.example/jobs/untrusted';
    const gone: string[] = [];
    const rejected: string[] = [];
    let observed: unknown = null;
    const fetchImpl = async () => new Response(null, { status: 410 });

    await expect(enrichCoopSourceBackedJobs(jobs, {
      fetchImpl,
      concurrency: 2,
      onDropSummary: (drop) => { observed = drop; },
      onGone: (urls) => gone.push(...urls),
      onRejected: (urls) => rejected.push(...urls),
    })).rejects.toThrow(/Untrusted Coop-family detail host/);

    expect(observed).toEqual({ candidates: 2, gone: 1, rejected: 0, dropped: 1 });
    expect(gone).toEqual([jobs[0].url]);
    expect(rejected).toEqual([]);
  });

  it('publishes one finite drop observation for both gone and rejected details (#7885)', async () => {
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const thin = { ...jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'), description: '<p>Kurze Anzeige.</p>' };
    const fetchImpl = async (input: unknown, _init?: unknown) => {
      if (String(input).includes('22222222')) return new Response(null, { status: 410 });
      const detail = String(input).includes('44444444') ? thin : jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen');
      return new Response(`<script type="application/ld+json">${JSON.stringify(detail)}</script>`, { status: 200 });
    };

    let observed: unknown = null;
    const enriched = await enrichCoopSourceBackedJobs(jobs, {
      fetchImpl: fetchImpl as any,
      concurrency: 2,
      onDropSummary: (drop) => { observed = drop; },
    });

    expect(observed).toEqual({ candidates: 4, gone: 1, rejected: 1, dropped: 2 });
    expect(enriched.detailDrop).toEqual(observed);
    expect(Object.keys(enriched)).not.toContain('detailDrop');
  });

  it('reads a single gone page on a tiny batch as expiry, not drift', async () => {
    // One withdrawn vacancy out of one is 100% of the batch: the ratio alone
    // would abort the crawl on the most banal case the drop exists to survive.
    const [companyKey, url] = cases[2];
    const job = {
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    const fetchImpl = async () => new Response(null, { status: 410 });

    const gone: string[] = [];
    const enriched = await enrichCoopSourceBackedJobs([job], {
      fetchImpl, allowedHosts: ['jobs.coopjobs.ch'], onGone: (urls) => gone.push(...urls),
    });
    expect(enriched).toEqual([]);
    expect(gone).toEqual([url]);
  });

  it('reads a fully withdrawn two-vacancy batch as expiry, not drift (#7545)', async () => {
    // The floor is on the batch size, not on the drop count: two withdrawn
    // vacancies out of two used to clear a floor of 1 and the ratio at once,
    // so the crawl still died with «source drift» on a slice that just expired.
    const jobs = cases.slice(0, 2).map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async () => new Response(null, { status: 410 });

    const gone: string[] = [];
    const enriched = await enrichCoopSourceBackedJobs(jobs, {
      fetchImpl, concurrency: 2, onGone: (urls) => gone.push(...urls),
    });
    expect(enriched).toEqual([]);
    expect(gone).toHaveLength(2);
  });

  it('fails closed when most detail pages are gone — source drift, not expiry', async () => {
    const jobs = cases.map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => String(input).includes('11111111')
      ? new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 })
      : new Response(null, { status: 404 });

    let observed: unknown = null;
    const gone: string[] = [];
    const rejected: string[] = [];

    await expect(enrichCoopSourceBackedJobs(jobs, {
      fetchImpl,
      concurrency: 2,
      onDropSummary: (drop) => { observed = drop; },
      onGone: (urls) => gone.push(...urls),
      onRejected: (urls) => rejected.push(...urls),
    }))
      .rejects.toThrow(/3\/4 pages gone/);
    expect(observed).toEqual({ candidates: 4, gone: 3, rejected: 0, dropped: 3 });
    expect(gone).toEqual([]);
    expect(rejected).toEqual([]);
    expect(jobs.every((job) => job.description === 'listing fallback')).toBe(true);
  });

  it('still fails the batch on a non-gone error status', async () => {
    const jobs = cases.slice(0, 2).map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => String(input).includes('22222222')
      ? new Response(null, { status: 403 })
      : new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 });

    await expect(enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2 }))
      .rejects.toThrow(/HTTP 403/);
  });

  it('keeps the listing fallback when a Volg detail request exhausts transient retries (#8117)', async () => {
    const [companyKey, url] = cases[3];
    const job = {
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return new Response(null, { status: 503 });
    };
    const previousRetries = process.env.JOBS_CRAWLER_RETRIES;
    const previousBaseMs = process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    process.env.JOBS_CRAWLER_RETRIES = '0';
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    try {
      const enriched = await enrichCoopSourceBackedJobs([job], {
        fetchImpl,
        allowedHosts: ['jobs.fenaco.com'],
        preserveListingOnTransientFailure: true,
      });
      expect(enriched).toEqual([job]);
      expect(enriched[0]._enrichedFromDetail).toBeUndefined();
      expect(attempts).toBe(1);
    } finally {
      if (previousRetries === undefined) delete process.env.JOBS_CRAWLER_RETRIES;
      else process.env.JOBS_CRAWLER_RETRIES = previousRetries;
      if (previousBaseMs === undefined) delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
      else process.env.JOBS_CRAWLER_RETRY_BASE_MS = previousBaseMs;
    }
  });

  it('fails closed instead of preserving a listing after a terminal DNS failure', async () => {
    const [companyKey, url] = cases[3];
    const job = {
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    const fetchImpl = async () => {
      const error = Object.assign(new Error('getaddrinfo ENOTFOUND jobs.fenaco.com'), { code: 'ENOTFOUND' });
      throw error;
    };
    const previousRetries = process.env.JOBS_CRAWLER_RETRIES;
    const previousBaseMs = process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    process.env.JOBS_CRAWLER_RETRIES = '0';
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    try {
      await expect(enrichCoopSourceBackedJobs([job], {
        fetchImpl,
        allowedHosts: ['jobs.fenaco.com'],
        preserveListingOnTransientFailure: true,
      })).rejects.toThrow(/ENOTFOUND/);
    } finally {
      if (previousRetries === undefined) delete process.env.JOBS_CRAWLER_RETRIES;
      else process.env.JOBS_CRAWLER_RETRIES = previousRetries;
      if (previousBaseMs === undefined) delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
      else process.env.JOBS_CRAWLER_RETRY_BASE_MS = previousBaseMs;
    }
  });

  it('rejects a cross-host redirect before fetching or publishing its payload', async () => {
    const job = {
      id: 'stable', companyKey: 'jumbo', url: cases[2][1], title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    const requests: string[] = [];
    const fetchImpl = async (input: string | URL) => {
      requests.push(String(input));
      return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/jobs/one' } });
    };

    await expect(enrichCoopSourceBackedJobs([job], { fetchImpl, allowedHosts: ['jobs.coopjobs.ch'] }))
      .rejects.toThrow(/origin not allowed/);
    expect(requests).toEqual([job.url]);
    expect(job.description).toBe('listing fallback');
  });

  it('accepts ISO CH/CHE country evidence when addressRegion is an ATS district', () => {
    const [companyKey, url, locality, region] = cases[3];
    const listing = { id: 'stable', companyKey, url, title: 'Verkäuferin Verkäufer', description: 'listing', location: 'fallback', canton: 'TI', sourceLang: 'de' };
    for (const country of ['CH', 'CHE']) {
      const detail = jsonLd(listing.title, locality, region);
      detail.jobLocation.address.addressCountry = country;
      expect(applyCoopSourceDetailToJob(listing, detail)).toMatchObject({ location: locality, canton: 'ZH' });
    }
  });

  it('is idempotent for an already source-backed payload', () => {
    const [companyKey, url, locality, region] = cases[3];
    const listing = { id: 'stable', companyKey, url, title: 'Verkäuferin Verkäufer', description: 'listing', location: 'fallback', canton: 'TI', sourceLang: 'de' };
    const detail = jsonLd(listing.title, locality, region);
    const first = applyCoopSourceDetailToJob(listing, detail);
    expect(applyCoopSourceDetailToJob(first, detail)).toEqual(first);
  });
});

// ──────────────────────────────────────────────────────────────
// Translation-cache redirect-history preservation (issue #2962)
//
// All 9 URLs flagged by the daily 404-risk audit were Coop jobs whose old
// (sitemap-referenced) slugs were left unserved. The Coop translation cache is
// the only crawler-specific persistence layer, and it must carry redirect
// history (previousSlugs / previousSlugsByLocale) so that, when the cache
// re-injects a job into data/jobs.json, the build plugin can still emit bridge
// pages for the old URLs instead of letting them 404.
// ──────────────────────────────────────────────────────────────
describe('buildCoopTranslationCacheEntry — redirect-history preservation (#2962)', () => {
  const jobWithHistory = {
    url: 'https://jobs.coopjobs.ch/offene-stellen/metzger/abc-123',
    slug: 'metzger-in-fleischfachfrau-fleischfachmann-coop-genossenschaft-goldach-sankt-gallen-i5fg9z',
    company: 'Coop Genossenschaft',
    companyKey: 'coop',
    location: 'Goldach',
    canton: 'SG',
    titleByLocale: { it: 'Macellaio', en: 'Butcher', de: 'Metzger', fr: 'Boucher' },
    slugByLocale: {
      it: 'metzger-in-fleischfachfrau-fleischfachmann-coop-genossenschaft-goldach-sankt-gallen-i5fg9z',
      en: 'butcher-meat-specialist-coop-genossenschaft-goldach-i5fg9z',
      de: 'metzger-in-fleischfachfrau-fleischfachmann-coop-genossenschaft-goldach-sankt-gallen-i5fg9z',
      fr: 'boucher-specialiste-de-la-viande-coop-genossenschaft-goldach-i5fg9z',
    },
    previousSlugs: ['butcher-meat-specialist-coop-genossenschaft-goldach'],
    previousSlugsByLocale: {
      en: ['butcher-meat-specialist-coop-genossenschaft-goldach'],
      fr: ['boucher-specialiste-de-la-viande-coop-genossenschaft-goldach'],
    },
  };

  it('carries previousSlugs and previousSlugsByLocale through the cache entry', () => {
    const entry = buildCoopTranslationCacheEntry(jobWithHistory);
    expect(entry.previousSlugs).toEqual(jobWithHistory.previousSlugs);
    expect(entry.previousSlugsByLocale).toEqual(jobWithHistory.previousSlugsByLocale);
    // Existing translation fields still preserved.
    expect(entry.slugByLocale).toEqual(jobWithHistory.slugByLocale);
    expect(entry.titleByLocale).toEqual(jobWithHistory.titleByLocale);
  });

  it('omits redirect-history keys entirely when there is no history (no empty-placeholder churn)', () => {
    const entry = buildCoopTranslationCacheEntry({
      url: 'https://jobs.coopjobs.ch/offene-stellen/x/1',
      slug: 'fresh-job-coop-lugano',
      slugByLocale: { it: 'fresh-job-coop-lugano' },
      // no previousSlugs / previousSlugsByLocale
    });
    expect(entry).not.toHaveProperty('previousSlugs');
    expect(entry).not.toHaveProperty('previousSlugsByLocale');
    // Empty objects/arrays are not treated as history.
    const entryEmpty = buildCoopTranslationCacheEntry({
      url: 'u', slug: 's', previousSlugs: [], previousSlugsByLocale: {},
    });
    expect(entryEmpty).not.toHaveProperty('previousSlugs');
    expect(entryEmpty).not.toHaveProperty('previousSlugsByLocale');
  });

  it('is pure/deterministic (does not stamp cachedAt itself)', () => {
    const a = buildCoopTranslationCacheEntry(jobWithHistory);
    const b = buildCoopTranslationCacheEntry(jobWithHistory);
    expect(a).toEqual(b);
    expect(a).not.toHaveProperty('cachedAt');
  });
});

describe('findUnrecognizedCoopDivisions (#6945 item 1)', () => {
  it('flags a Coop-scoped job whose company text is not in the allowlist', () => {
    const jobs = [
      { companyKey: 'coop-ticino', company: 'Coop' },
      { companyKey: 'coop-ticino', company: 'Some New Coop Division AG' },
    ];
    expect(isCoopJob(jobs[0])).toBe(true);
    expect(isCoopJob(jobs[1])).toBe(false);
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual(['Some New Coop Division AG']);
  });

  it('ignores jobs scoped to a different crawler', () => {
    const jobs = [
      { companyKey: 'fust', company: 'Fust' },
      { companyKey: 'jumbo', company: 'Jumbo' },
    ];
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual([]);
  });

  it('returns no entries when every Coop-scoped job matches the allowlist', () => {
    const jobs = [
      { companyKey: 'coop-ticino', company: 'Coop City' },
      { companyKey: 'coop-ticino', company: 'coop.ch' },
    ];
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual([]);
  });

  it('dedupes repeated unrecognized company names', () => {
    const jobs = [
      { companyKey: 'coop-ticino', company: 'Mystery Coop Brand' },
      { companyKey: 'coop-ticino', company: 'Mystery Coop Brand' },
    ];
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual(['Mystery Coop Brand']);
  });
});

describe('assertCoopSingleCompanyKeyScope (#6945 item 2)', () => {
  it('passes when no company key scope is pre-set in env', () => {
    expect(() => assertCoopSingleCompanyKeyScope({})).not.toThrow();
  });

  it('passes when the pre-set scope is only coop-ticino itself', () => {
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEYS: 'coop-ticino' })).not.toThrow();
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEY: 'Coop-Ticino' })).not.toThrow();
  });

  it('fails closed when an extraneous company key has leaked into the scope', () => {
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEYS: 'coop-ticino,fust' }))
      .toThrow(/sole company-key scope/);
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEY: 'jumbo' }))
      .toThrow(/sole company-key scope/);
  });
});

// ──────────────────────────────────────────────────────────────
// Detail-page content outside the JSON-LD (parser-quality audit #5253)
// ──────────────────────────────────────────────────────────────

describe('Coop-family detail page content outside the JSON-LD description', () => {
  const pageOf = (id: string) => familyPages[id];
  const detailOf = (id: string) => extractCoopFamilyPageDetails(pageOf(id).html);
  const jsonLdOf = (id: string) => extractJsonLd(pageOf(id).html);

  it('reads the Coop store facts and leaves contact/process chrome out', () => {
    const page = detailOf('coop-store');
    expect(page.facts).toEqual(expect.arrayContaining([
      { label: 'Arbeitsort', value: 'Coop, Albisriederstrasse 334, 8047 Zürich' },
      { label: 'Pensum', value: '8 - 20 Std./Woche' },
      { label: 'Stellenantritt', value: 'per sofort oder nach Vereinbarung' },
    ]));
    expect(page.sections.map((section) => section.heading)).not.toContain('Bewerbungsprozess');
    expect(page.facts.map((fact) => fact.label)).not.toContain('Deine Ansprechperson');
  });

  it('gives two Zürich stores of the same role two different published bodies and addresses', () => {
    const job = {
      title: 'Verkäufer:in Food', company: 'Coop Genossenschaft', location: 'Zürich', addressLocality: 'Zürich',
      canton: 'ZH', addressRegion: 'ZH', sourceLang: 'de',
    };
    const html = pageOf('coop-store').html;
    const otherStoreHtml = html
      .replaceAll('Albisriederstrasse 334', 'Dorflindenstrasse 2')
      .replaceAll('8047', '8050');
    const publish = (pageHtml: string, url: string) => {
      const jsonLd = extractJsonLd(pageHtml);
      const { job: located } = applyCoopJsonLdToJob(job, jsonLd);
      const body = composeCoopFamilyDescription(coopDescHtmlToMarkdown(jsonLd.description), extractCoopFamilyPageDetails(pageHtml));
      return { ...located, url, description: `## ${job.title}\n\n**Coop Genossenschaft** — Zürich, ZH, Svizzera\n\n${body}` };
    };
    const a = publish(html, 'https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/2f1b4fc6-b883-4d7c-963f-a29fd82e6a17');
    const b = publish(otherStoreHtml, 'https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/ef8c87a1-aba4-44e1-971f-503dddba761e');

    expect(a.description).toContain('- Arbeitsort: Coop, Albisriederstrasse 334, 8047 Zürich');
    expect(a.description).toContain('- Pensum: 8 - 20 Std./Woche');
    expect(a.description).toContain('## Aufgaben');
    expect(a).toMatchObject({ location: 'Zürich', postalCode: '8047', streetAddress: 'Albisriederstrasse 334' });
    expect(b).toMatchObject({ location: 'Zürich', postalCode: '8050', streetAddress: 'Dorflindenstrasse 2' });
    const [fpA, fpB] = fingerprintsForCrawler([a, b], 'title-aware');
    expect(fpA).not.toBe(fpB);
  });

  it('drops a stale street when the adapter workplace overrides the detail address', () => {
    const { job: updated } = applyCoopJsonLdToJob({
      title: 'Verkaufsberater:in', location: 'Basel', addressLocality: 'Basel', canton: 'BS', addressRegion: 'BS',
      company: 'Coop', postalCode: '4051', streetAddress: 'Detailstrasse 1',
      _targetScope: { type: 'adapter_seed_meta', location: 'Region Zürich (Sihlcity und Umgebung)', canton: 'ZH' },
    }, {
      jobLocation: { address: { addressLocality: 'Basel', addressRegion: 'Basel-Stadt', addressCountry: 'CH', postalCode: '4051', streetAddress: 'Detailstrasse 1' } },
      hiringOrganization: { name: 'Coop' },
    });
    expect(updated.location).toBe('Region Zürich (Sihlcity und Umgebung)');
    expect(updated.postalCode).toBeUndefined();
    expect(updated.streetAddress).toBeUndefined();
  });

  it('collapses only the same ad republished at the same store address', () => {
    const base = {
      title: 'Transportdisponent:in', location: 'Gossau', postalCode: '9200', streetAddress: 'Industriestrasse 109',
      description: '- Arbeitsort: Coop, Industriestrasse 109, 9200 Gossau\n- Pensum: 100 %\n\n## Aufgaben\n- Touren planen',
    };
    const jobs = [
      { ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/b', firstSeenAt: new Date(Date.now() - 2 * 86400000).toISOString() },
      { ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/a', firstSeenAt: new Date(Date.now() - 30 * 86400000).toISOString() },
      { ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/c', description: base.description.replace('100 %', '60 %') },
      { ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/d', postalCode: '', streetAddress: '' },
      { ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/e', postalCode: '', streetAddress: '' },
    ];
    const { kept, collapsed } = collapseRepublishedCoopVacancies(jobs);

    expect(collapsed).toEqual([{
      url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/b',
      keptUrl: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/a',
    }]);
    expect(kept.map((job) => job.url.slice(-1))).toEqual(['a', 'c', 'd', 'e']);
  });

  it('publishes the fenaco tasks, profile, facts and benefits the JSON-LD leaves out', () => {
    const listing = {
      id: 'volg-fenaco-stable', companyKey: 'volg-fenaco', url: pageOf('fenaco-generic').url,
      title: 'Planungs- und Bauprojektleiterin / Bauprojektleiter (w/m/d)', description: 'listing fallback',
      location: 'Sursee', canton: 'LU', sourceLang: 'de',
    };
    const jsonLd = jsonLdOf('fenaco-generic');
    const jsonLdOnly = coopDescHtmlToMarkdown(jsonLd.description);
    const result = applyCoopSourceDetailToJob(listing, jsonLd, detailOf('fenaco-generic'));

    expect(jsonLdOnly).not.toContain('Fundierte CAD-Kenntnisse');
    expect(result.description).toContain('## Diese Aufgaben begeistern dich');
    expect(result.description).toContain('- Fundierte CAD-Kenntnisse');
    expect(result.description).toContain('- Pensum: 80-100 %');
    expect(result.description).toContain('- Attraktive Ferienregelung: ');
    expect(result.description).not.toContain('Bewerbungsprozess');
    expect(result.description).not.toContain('Online-Formular');
    expect(result.description.length).toBeGreaterThan(jsonLdOnly.length * 4);
    expect(result).toMatchObject({ location: 'Sursee', canton: 'LU', postalCode: '6210' });
  });

  it('does not repeat a benefit list the JSON-LD already carries', () => {
    const markdown = '## Das bieten wir dir\n- Jahresabo "update Fitness"\n- CHF 500 für Laptop oder Tablet\n- SBB Halbtax oder Anteil GA CHF 650';
    const composed = composeCoopFamilyDescription(markdown, {
      workplace: '', facts: [], sections: [],
      benefits: { heading: 'Das bieten wir dir', items: ['Jahresabo "update Fitness"', 'CHF 500 für Laptop oder Tablet', 'Neu: Kinderzulage'] },
    });
    expect(composed).toBe(markdown);
  });

  it('extends an existing benefit heading in place instead of publishing it twice', () => {
    const markdown = '## Das bieten wir dir\n- 6 Wochen Ferien\n\nKontaktperson HR';
    const composed = composeCoopFamilyDescription(markdown, {
      workplace: '', facts: [], sections: [],
      benefits: { heading: 'Das bieten wir dir', items: ['Jahresabo "update Fitness"', 'SBB Halbtax'] },
    });
    expect(composed.match(/## Das bieten wir dir/g)).toHaveLength(1);
    expect(composed).toContain('- 6 Wochen Ferien\n- Jahresabo "update Fitness"\n- SBB Halbtax\n\nKontaktperson HR');
  });

  it('publishes the Fust workplace the page declares instead of the Oberbüren head office', () => {
    const jsonLd = jsonLdOf('fust-apprenticeship');
    // A re-crawled record may still carry the head office from an earlier run.
    const staleListing = {
      id: 'fust-stable', companyKey: 'fust', url: pageOf('fust-apprenticeship').url,
      title: 'Detailhandelsfachfrau:mann EFZ «Gestalten von Einkaufserlebnissen»', description: 'listing fallback',
      location: 'Oberbüren', addressLocality: 'Oberbüren', canton: 'SG', addressRegion: 'SG',
      postalCode: '9245', streetAddress: 'Industrie Haslen 3', sourceLang: 'de',
    };
    expect(jsonLd.jobLocation.address.addressLocality).toBe('Oberbüren');
    const result = applyCoopSourceDetailToJob(staleListing, jsonLd, detailOf('fust-apprenticeship'));

    expect(result).toMatchObject({ location: 'Zuchwil', addressLocality: 'Zuchwil', canton: 'SO', postalCode: '', streetAddress: '' });
    expect(result.description).toContain('- Lehrdauer von 01.08.2027 bis 31.07.2030');
    // Without the page the old head-office behaviour is unchanged.
    expect(applyCoopSourceDetailToJob(staleListing, jsonLd)).toMatchObject({ location: 'Oberbüren', canton: 'SG' });
  });

  it('keeps a non-municipality branch label only when it is coherent with the listing canton', () => {
    const jsonLd = jsonLdOf('interdiscount-branch-label');
    const page = detailOf('interdiscount-branch-label');
    const listing = {
      id: 'interdiscount-stable', companyKey: 'interdiscount', url: pageOf('interdiscount-branch-label').url,
      title: 'Detailhandelsfachfrau:mann EFZ "Gestalten von Einkaufserlebnissen"', description: 'listing fallback',
      location: 'Heerbrugg', addressLocality: 'Heerbrugg', canton: 'SG', addressRegion: 'SG', addressCountry: 'CH', sourceLang: 'de',
    };
    expect(jsonLd.jobLocation.address.addressLocality).toBe('Jegensdorf');
    expect(applyCoopSourceDetailToJob(listing, jsonLd, page)).toMatchObject({
      location: 'Heerbrugg', canton: 'SG', postalCode: '', streetAddress: '',
    });
    // The same label without listing corroboration names no canton: not evidence.
    const { addressLocality, ...regionOnly } = listing;
    expect(applyCoopSourceDetailToJob({ ...regionOnly, location: 'St. Gallen' }, jsonLd, page)).toMatchObject({
      location: 'Jegensdorf', postalCode: '3303',
    });
  });

  it('keeps the detail municipality when the branch label only qualifies it', () => {
    const jsonLd = {
      ...jsonLdOf('fust-apprenticeship'),
      jobLocation: { address: { addressLocality: 'Schaffhausen', addressRegion: 'Schaffhausen', addressCountry: 'Schweiz', postalCode: '8207', streetAddress: 'Herblingerstrasse 1' } },
    };
    const page = { ...detailOf('fust-apprenticeship'), workplace: 'Schaffhausen, Herblingermarkt' };
    const listing = {
      id: 'fust-stable', companyKey: 'fust', url: pageOf('fust-apprenticeship').url,
      title: 'Detailhandelsfachfrau:mann EFZ «Gestalten von Einkaufserlebnissen»', description: 'listing fallback',
      location: 'Schaffhausen', canton: 'SH', sourceLang: 'de',
    };
    expect(applyCoopSourceDetailToJob(listing, jsonLd, page)).toMatchObject({
      location: 'Schaffhausen', postalCode: '8207', streetAddress: 'Herblingerstrasse 1',
    });
  });
});

describe('Coop quarantine gate on the composed source body (review #10333)', () => {
  // Real JSON-LD wording of a Coop sales role, cut to 49 words, and the page's
  // own facts/sections: the composed posting clears the 50-word source floor.
  const WORDS = 'Du liebst die Abwechslung darum bedienst und berätst du unsere Kundschaft in verschiedenen Abteilungen stets freundlich und engagiert Dank deinem aktiven Einsatz verkaufen sich die Waren besser und werden top bewirtschaftet'.split(' ');
  const jsonLd49 = { description: `<p>${Array.from({ length: 49 }, (_, i) => WORDS[i % WORDS.length]).join(' ')}</p>` };
  const page = {
    workplace: '',
    facts: [{ label: 'Arbeitsort', value: 'Coop Supermarkt Zürich Oerlikon, Schaffhauserstrasse 355, 8050 Zürich' }, { label: 'Pensum', value: '40-60%' }],
    sections: [],
    benefits: null,
  };
  const staleJob = { description: '## Verkäufer:in Food\n\nlisting fallback' };

  it('does not quarantine a 49-word JSON-LD whose page details bring the composed body to 50+ words', () => {
    const composed = coopDetailSourceBody(jsonLd49, page);
    expect(composed).toContain('Schaffhauserstrasse 355');
    expect(coopDetailNeedsQuarantine(staleJob, jsonLd49, page)).toBe(false);
  });

  it('still quarantines the same 49-word JSON-LD without page details and without a stored body', () => {
    expect(coopDetailNeedsQuarantine(staleJob, jsonLd49, null)).toBe(true);
    expect(coopDetailNeedsQuarantine(staleJob, null, null)).toBe(true);
  });
});

describe('Coop reposts without a street address (parser-quality audit #5253)', () => {
  const pages = ['coop-heiden-a', 'coop-heiden-b'].map((id) => republishedPages[id]);
  const title = 'Detailhandelsfachfrau:mann EFZ "Gestalten von Einkaufserlebnissen"';

  it('keeps source-backed postings with different datePosted values apart', () => {
    const j = { title: 'Ruolo', description: 'test', location: 'Reiden', company: 'Volg', _enrichedFromDetail: true };
    const { kept, collapsed } = collapseRepublishedCoopVacancies([
      { ...j, url: 'https://x/a', datePosted: '2026-09-01' },
      { ...j, url: 'https://x/b', datePosted: '2026-09-02' },
    ], { allowIdenticalSourcePostingsWithoutAddress: true });

    expect(kept.length).toBe(2);
    expect(collapsed.length).toBe(0);
  });

  it('keeps two UUIDs apart when the source gives no store address, even with identical pages', () => {
    const listings = pages.map(({ url }) => ({
      id: 'coop-family-heiden', companyKey: 'jumbo', url, title, description: 'listing fallback',
      location: 'Heiden', addressLocality: 'Heiden', canton: 'AR', addressRegion: 'AR', addressCountry: 'CH', sourceLang: 'de',
    }));
    const enriched = listings.map((listing, index) => applyCoopSourceDetailToJob(
      listing, extractJsonLd(pages[index].html), extractCoopFamilyPageDetails(pages[index].html),
    ));

    // The page names only "Heiden" (the JSON-LD is the Gossau office): no
    // street, store number or shared URL proves the two are one vacancy, so
    // the audit bucket stays and both live pages stay published.
    expect(enriched[0].description).toBe(enriched[1].description);
    expect(enriched.map((job) => [job.location, job.postalCode, job.streetAddress])).toEqual([['Heiden', '', ''], ['Heiden', '', '']]);
    expect(countDuplicateListings(enriched, fingerprintsForCrawler(enriched, 'title-aware'))).toBe(2);
    expect(collapseRepublishedCoopVacancies(enriched).collapsed).toEqual([]);
    expect(withoutRepublishedCoopVacancies(enriched, 'JUMBO').map((job: { url: string }) => job.url)).toEqual(pages.map(({ url }) => url));
  });

  it('collapses identical source-backed no-address pages and bridges the removed routes', () => {
    const listings = pages.map(({ url }, index) => ({
      id: 'coop-family-heiden', companyKey: 'coop-ticino', url, title, description: 'listing fallback',
      location: 'Heiden', addressLocality: 'Heiden', canton: 'AR', addressRegion: 'AR', addressCountry: 'CH', sourceLang: 'de',
      firstSeenAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      slug: `detailhandelsfachfrau-heiden-${index === 0 ? 'old' : 'new'}`,
      slugByLocale: { de: `detailhandelsfachfrau-heiden-${index === 0 ? 'old' : 'new'}-de` },
    }));
    const enriched = listings.map((listing, index) => applyCoopSourceDetailToJob(
      listing, extractJsonLd(pages[index].html), extractCoopFamilyPageDetails(pages[index].html),
    ));
    const sourceBackedUrls = new Set(enriched.map((job) => job.url));

    const { kept, collapsed } = collapseRepublishedCoopVacancies(enriched, {
      allowIdenticalSourcePostingsWithoutAddress: true,
      sourceBackedUrls,
    });

    expect(collapsed).toEqual([{ url: pages[1].url, keptUrl: pages[0].url }]);
    expect(kept).toHaveLength(1);
    expect(kept[0].previousSlugsByLocale.de).toContain('detailhandelsfachfrau-heiden-new-de');
    expect(countDuplicateListings(kept, fingerprintsForCrawler(kept, 'title-aware'))).toBe(0);
  });

  it('moves every route of a collapsed full-address repost onto the record it keeps', () => {
    const base = {
      title: 'Transportdisponent:in', location: 'Gossau', postalCode: '9200', streetAddress: 'Industriestrasse 109',
      description: '- Arbeitsort: Coop, Industriestrasse 109, 9200 Gossau\n- Pensum: 100 %\n\n## Aufgaben\n- Touren planen',
    };
    const keeper = {
      ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/a',
      firstSeenAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      slug: 'transportdisponent-in-coop-gossau', slugByLocale: { it: 'transportdisponent-in-coop-gossau', de: 'transportdisponent-in-gossau' },
    };
    const repost = {
      ...base, url: 'https://jobs.coopjobs.ch/offene-stellen/transportdisponent-in/b',
      firstSeenAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      // The shared fresh slug is the keeper's own URL, not a route to bridge.
      slug: 'transportdisponent-in-coop-gossau',
      slugByLocale: { it: 'transportdisponent-in-coop-gossau', de: 'transportdisponent-in-gossau-2' },
      previousSlugsByLocale: { it: ['disponent-coop-gossau'] },
    };
    const { kept, collapsed } = collapseRepublishedCoopVacancies([repost, keeper]);

    expect(collapsed).toEqual([{ url: repost.url, keptUrl: keeper.url }]);
    expect(kept).toEqual([keeper]);
    expect(keeper.previousSlugsByLocale.de).toContain('transportdisponent-in-gossau-2');
    expect(keeper.previousSlugsByLocale.it).toContain('disponent-coop-gossau');
    expect(keeper.previousSlugsByLocale.it).not.toContain(keeper.slug);
    expect(countDuplicateListings(kept, fingerprintsForCrawler(kept, 'title-aware'))).toBe(0);
  });
});
