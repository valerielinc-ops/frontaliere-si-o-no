/**
 * Tests for the Weisse Arena Gruppe dedicated job crawler.
 *
 * Verifies:
 *   - TalentLink API response parsing
 *   - Job object construction from listing data
 *   - Contract type mapping (Festanstellung, Saisonanstellung, etc.)
 *   - Pensum parsing (percentage ranges)
 *   - Category detection from title and department
 *   - Detail URL construction
 *   - Company job identification
 *   - Trusted domain detection (weissearena.com + recruitmentplatform.com)
 *   - Slug generation
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { isProvenHousekeepingPrune } from '../scripts/lib/crawler-slice-integrity.mjs';
import {
  WEISSE_ARENA_KEY,
  WEISSE_ARENA_COMPANY_NAME,
  WEISSE_ARENA_COMPANY_DOMAIN,
  fetchAllWeisseArenaJobs,
  isWeisseArenaJob,
  isTrustedDomain,
  detectCategory,
  mapContractType,
  parsePensum,
  buildDetailUrl,
} from '../scripts/lib/weisse-arena-job-parser.mjs';
import {
  verifiedWeisseArenaOmissionProof,
  runStandardCrawlerPipeline,
  slugify,
} from '../scripts/lib/crawler-template.mjs';

const mocks = vi.hoisted(() => ({
  readExistingCrawlerJobs: vi.fn(),
  writeJobsCrawlerSliceVerified: vi.fn(),
  writeSummaryCrawlerSlice: vi.fn(),
  archiveRemovedJobsToSlice: vi.fn(() => 0),
  scratchPath: '',
}));

vi.mock('../scripts/assemble-jobs-dataset.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/assemble-jobs-dataset.mjs')>()),
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
  writeJobsCrawlerSliceVerified: mocks.writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice: mocks.writeSummaryCrawlerSlice,
  assembleJobsDataset: vi.fn(),
  registerCrawlerSummaryGuard: vi.fn(),
}));

vi.mock('../scripts/lib/dedicated-crawler-common.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/dedicated-crawler-common.mjs')>()),
  runDedicatedBaseCrawler: vi.fn(),
  validateDedicatedLocaleCoverage: vi.fn(),
}));

vi.mock('../scripts/lib/expired-jobs-archive.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/expired-jobs-archive.mjs')>()),
  archiveRemovedJobsToSlice: mocks.archiveRemovedJobsToSlice,
  readExpiredSlice: vi.fn(() => []),
}));

vi.mock('../scripts/lib/crawler-scratch-path.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/crawler-scratch-path.mjs')>();
  return { ...original, crawlerScratchPathFor: (key: string) => mocks.scratchPath || original.crawlerScratchPathFor(key) };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Constants ──────────────────────────────────────────────────────────────────

describe('Weisse Arena crawler constants', () => {
  it('has correct company key', () => {
    expect(WEISSE_ARENA_KEY).toBe('weisse-arena');
  });

  it('has correct company name', () => {
    expect(WEISSE_ARENA_COMPANY_NAME).toBe('Weisse Arena Gruppe');
  });

  it('has correct company domain', () => {
    expect(WEISSE_ARENA_COMPANY_DOMAIN).toBe('weissearena.com');
  });
});

// ─── Contract type mapping ──────────────────────────────────────────────────────

describe('mapContractType', () => {
  it('maps Festanstellung to FULL_TIME', () => {
    expect(mapContractType('Festanstellung')).toBe('FULL_TIME');
  });

  it('maps Kaderanstellung to FULL_TIME', () => {
    expect(mapContractType('Kaderanstellung')).toBe('FULL_TIME');
  });

  it('maps Saisonanstellung to CONTRACTOR', () => {
    expect(mapContractType('Saisonanstellung')).toBe('CONTRACTOR');
  });

  it('maps Lehranstellung to INTERN', () => {
    expect(mapContractType('Lehranstellung')).toBe('INTERN');
  });

  it('maps Praktikumsanstellung to INTERN', () => {
    expect(mapContractType('Praktikumsanstellung')).toBe('INTERN');
  });

  it('maps unknown label to OTHER', () => {
    expect(mapContractType('Temporär')).toBe('OTHER');
    expect(mapContractType('')).toBe('OTHER');
  });
});

// ─── Pensum parsing ─────────────────────────────────────────────────────────────

describe('parsePensum', () => {
  it('parses range like 80%-100%', () => {
    expect(parsePensum('80%-100%')).toEqual({ min: 80, max: 100 });
  });

  it('parses range with spaces like 60% - 100%', () => {
    expect(parsePensum('60% - 100%')).toEqual({ min: 60, max: 100 });
  });

  it('parses single value like 100%', () => {
    expect(parsePensum('100%')).toEqual({ min: 100, max: 100 });
  });

  it('parses single value without percent like 80', () => {
    expect(parsePensum('80%')).toEqual({ min: 80, max: 80 });
  });

  it('defaults to 100% for empty input', () => {
    expect(parsePensum('')).toEqual({ min: 100, max: 100 });
  });

  it('defaults to 100% for null/undefined', () => {
    expect(parsePensum(undefined as unknown as string)).toEqual({ min: 100, max: 100 });
  });
});

// ─── Detail URL construction ────────────────────────────────────────────────────

describe('buildDetailUrl', () => {
  it('builds URL with jobId and title', () => {
    const url = buildDetailUrl(4484, 'CRM & Lifecycle Marketing Manager');
    expect(url).toContain('weissearena.com/jobs/details.html');
    expect(url).toContain('jobId=4484');
    expect(url).toContain('jobTitle=CRM');
  });

  it('URL-encodes special characters in title', () => {
    const url = buildDetailUrl(4478, 'Mitarbeiter:in Spülküche');
    expect(url).toContain('jobId=4478');
    // Colon and umlaut should be encoded
    expect(url).not.toContain(' ');
  });

  it('works without title', () => {
    const url = buildDetailUrl(1234);
    expect(url).toContain('jobId=1234');
    expect(url).not.toContain('jobTitle');
  });

  it('URL contains weissearena.com host', () => {
    const url = buildDetailUrl(4484, 'Test');
    expect(url).toContain('weissearena.com');
  });
});

// ─── Category detection ─────────────────────────────────────────────────────────

describe('detectCategory from title and department', () => {
  it('detects gastronomy from Koch/Köchin', () => {
    expect(detectCategory('Pizzaiolo:a / Koch/Köchin', '')).toBe('Ristorazione');
  });

  it('detects gastronomy from Spülküche', () => {
    expect(detectCategory('Mitarbeiter:in Spülküche', 'Restaurant IKIGAI')).toBe('Ristorazione');
  });

  it('detects gastronomy from service staff', () => {
    expect(detectCategory('Servicemitarbeiter:in', 'signinahotel/Ristorante Camino')).toBe('Ristorazione');
  });

  it('detects gastronomy from restaurant leader', () => {
    expect(detectCategory('Restaurantleiter:in Camino', '')).toBe('Ristorazione');
  });

  it('detects marketing from CRM title', () => {
    expect(detectCategory('CRM & Lifecycle Marketing Manager', 'Digitalisation and Data Analytics')).toBe('Marketing');
  });

  it('detects marketing from Content & Growth', () => {
    expect(detectCategory('Content & Growth Manager', 'Customer Experience & Communication')).toBe('Marketing');
  });

  it('detects tech from Techniker Bahnbetrieb', () => {
    expect(detectCategory('Techniker:in Bahnbetrieb', 'Bahntechnik')).toBe('Tecnica');
  });

  it('detects hospitality from Housekeeping', () => {
    expect(detectCategory('Supervisor Housekeeping', 'signinahotel/rocksresort')).toBe('Hotellerie');
  });

  it('detects sport from Skischule', () => {
    expect(detectCategory('Skilehrer:in', 'Skischule')).toBe('Sport');
  });

  it('defaults to Turismo for unknown', () => {
    expect(detectCategory('Generalist:in', '')).toBe('Turismo');
  });
});

// ─── Job identification ─────────────────────────────────────────────────────────

describe('isWeisseArenaJob detection', () => {
  it('identifies by companyKey', () => {
    expect(isWeisseArenaJob({ companyKey: 'weisse-arena' })).toBe(true);
  });

  it('identifies by company name (full)', () => {
    expect(isWeisseArenaJob({ company: 'Weisse Arena Gruppe' })).toBe(true);
  });

  it('identifies by company name (partial)', () => {
    expect(isWeisseArenaJob({ company: 'Weisse Arena' })).toBe(true);
  });

  it('identifies by weissearena.com URL', () => {
    expect(isWeisseArenaJob({ url: 'https://www.weissearena.com/jobs/details.html?jobId=4484' })).toBe(true);
  });

  it('rejects unrelated jobs', () => {
    expect(isWeisseArenaJob({
      companyKey: 'other-company',
      company: 'Other Corp',
      url: 'https://other.com/jobs',
    })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isWeisseArenaJob(null)).toBe(false);
    expect(isWeisseArenaJob(undefined)).toBe(false);
    expect(isWeisseArenaJob({})).toBe(false);
  });
});

// ─── Trusted domain check ───────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts weissearena.com', () => {
    expect(isTrustedDomain('https://weissearena.com/jobs/details.html?jobId=4484')).toBe(true);
  });

  it('trusts www.weissearena.com', () => {
    expect(isTrustedDomain('https://www.weissearena.com/jobs/')).toBe(true);
  });

  it('trusts recruitmentplatform.com (TalentLink ATS)', () => {
    expect(isTrustedDomain('https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4484')).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/weissearena')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
    expect(isTrustedDomain('')).toBe(false);
  });
});

// ─── TalentLink API response structure ──────────────────────────────────────────

describe('TalentLink API response structure', () => {
  const SAMPLE_LISTING = {
    id: 4484,
    jobFields: {
      DPOSTINGSTART: 1774908000000,
      CONTRACTTYPLABEL: 'Festanstellung',
      SLOVLIST17: '80%-100%',
      sJobTitle: 'CRM & Lifecycle Marketing Manager',
      SLOVLIST10: 'Digitalisation and Data Analytics',
      id: 4484,
      siteLangauge: 'DE',
      language: 'DE',
      jobNumber: 'WAG02350',
      jobTitle: 'CRM & Lifecycle Marketing Manager',
      applicationUrl: 'https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4484&langCode=de_DE',
      POSTINGTIMEZONE: 'Europe/Zurich',
    },
    customFields: [
      { title: ' ', content: '<p>Die Weisse Arena Gruppe in LAAX ist Vorreiter im alpinen Tourismus...</p>' },
      { title: ' ', content: '<p>Du möchtest mit digitalen Lösungen dazu beitragen...</p>' },
      { title: 'Was du bewegst', content: '<ul><li>Planung, Aufbau und Umsetzung von Kampagnen</li></ul>' },
      { title: 'Was dich ausmacht', content: '<ul><li>Abgeschlossene Ausbildung im Bereich Marketing</li></ul>' },
      { title: ' ', content: '<p>Ein attraktiver Arbeitsplatz...</p>' },
      { title: ' ', content: '<p>Mountain Vision AG</p>' },
    ],
  };

  const SAMPLE_SEASONAL_LISTING = {
    id: 4478,
    jobFields: {
      DPOSTINGSTART: 1774566000000,
      CONTRACTTYPLABEL: 'Saisonanstellung',
      SLOVLIST17: '60%-100%',
      sJobTitle: 'Mitarbeiter:in Spülküche',
      SLOVLIST10: 'Restaurant IKIGAI',
      id: 4478,
      siteLangauge: 'DE',
      language: 'DE',
      jobNumber: 'WAG02290',
      jobTitle: 'Mitarbeiter:in Spülküche',
      applicationUrl: 'https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4478&langCode=de_DE',
      POSTINGTIMEZONE: 'Europe/Zurich',
    },
    customFields: [
      { title: ' ', content: '<p>Company intro...</p>' },
      { title: ' ', content: '<p>Role intro...</p>' },
      { title: ' ', content: '<p>Extra info...</p>' },
      { title: 'Was du bewegst', content: '<ul><li>Reinigung des Geschirrs</li></ul>' },
      { title: 'Was dich ausmacht', content: '<ul><li>Teamfähigkeit</li></ul>' },
      { title: ' ', content: '<p>Benefits...</p>' },
      { title: ' ', content: '<p>Contact info...</p>' },
    ],
  };

  it('listing has required jobFields', () => {
    const fields = SAMPLE_LISTING.jobFields;
    expect(fields.jobTitle).toBeTruthy();
    expect(fields.id).toBeTruthy();
    expect(fields.jobNumber).toBeTruthy();
    expect(fields.DPOSTINGSTART).toBeGreaterThan(0);
    expect(fields.CONTRACTTYPLABEL).toBeTruthy();
    expect(fields.applicationUrl).toBeTruthy();
  });

  it('listing has customFields array', () => {
    expect(Array.isArray(SAMPLE_LISTING.customFields)).toBe(true);
    expect(SAMPLE_LISTING.customFields.length).toBeGreaterThan(0);
  });

  it('customFields have title and content', () => {
    for (const field of SAMPLE_LISTING.customFields) {
      expect(field).toHaveProperty('title');
      expect(field).toHaveProperty('content');
    }
  });

  it('SLOVLIST10 contains department', () => {
    expect(SAMPLE_LISTING.jobFields.SLOVLIST10).toBe('Digitalisation and Data Analytics');
    expect(SAMPLE_SEASONAL_LISTING.jobFields.SLOVLIST10).toBe('Restaurant IKIGAI');
  });

  it('SLOVLIST17 contains pensum', () => {
    expect(SAMPLE_LISTING.jobFields.SLOVLIST17).toBe('80%-100%');
    expect(SAMPLE_SEASONAL_LISTING.jobFields.SLOVLIST17).toBe('60%-100%');
  });

  it('jobNumber starts with WAG prefix', () => {
    expect(SAMPLE_LISTING.jobFields.jobNumber).toMatch(/^WAG\d+$/);
  });

  it('application URL contains site tech ID', () => {
    expect(SAMPLE_LISTING.jobFields.applicationUrl).toContain('PD6FK026203F3VBQBLO8NV79D');
  });

  it('DPOSTINGSTART is a millisecond timestamp', () => {
    const date = new Date(SAMPLE_LISTING.jobFields.DPOSTINGSTART);
    expect(date.getFullYear()).toBeGreaterThanOrEqual(2025);
    expect(date.getFullYear()).toBeLessThanOrEqual(2030);
  });

  it('seasonal listing has different contract type', () => {
    expect(SAMPLE_SEASONAL_LISTING.jobFields.CONTRACTTYPLABEL).toBe('Saisonanstellung');
  });
});

describe('TalentLink pagination completeness', () => {
  const listing = (id: number, title: string) => ({
    id,
    jobFields: {
      id,
      jobNumber: `WAG${String(id).padStart(5, '0')}`,
      jobTitle: title,
      sJobTitle: title,
      SLOVLIST10: 'Marketing',
      SLOVLIST17: '100%',
      CONTRACTTYPLABEL: 'Festanstellung',
    },
    customFields: [],
  });

  const existingJob = (id: number) => ({
    id: `existing-${id}`,
    companyKey: 'weisse-arena',
    jobNumber: `WAG${String(id).padStart(5, '0')}`,
    url: `https://www.weissearena.com/jobs/details.html?jobId=${id}`,
  });

  const detailNotFound = () => Response.json({
    errorType: 'APPLICATION',
    errorCode: 'Bad Request',
    errorMsg: 'Stelle nicht gefunden',
  }, { status: 400 });

  const detailJobId = (url: URL) => {
    const match = url.pathname.match(/\/fo\/rest\/jobs\/(\d+)\/details$/);
    return match ? Number(match[1]) : null;
  };

  it('continues after a short page until an empty page ends the observation', async () => {
    const pages = new Map([
      [0, [listing(1, 'First role')]],
      [1, [listing(2, 'Second role'), listing(3, 'Third role')]],
    ]);
    const offsets: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('firstResult'));
      offsets.push(offset);
      return new Response(JSON.stringify({ globals: { jobsCount: 3 }, jobs: pages.get(offset) || [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const jobs = await fetchAllWeisseArenaJobs();

    expect(offsets).toEqual([0, 1, 3]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map(({ title }) => title)).toEqual(['First role', 'Second role', 'Third role']);
    expect(jobs.sourceListingSnapshot).toMatchObject({ coverage: 'observed', pageCount: 3 });
  });

  it('continues past an underreported globals.jobsCount', async () => {
    const pages = new Map([
      [0, [listing(1, 'First role'), listing(2, 'Second role')]],
      [2, [listing(3, 'Third role')]],
    ]);
    const offsets: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('firstResult'));
      offsets.push(offset);
      return new Response(JSON.stringify({ globals: { jobsCount: 2 }, jobs: pages.get(offset) || [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const jobs = await fetchAllWeisseArenaJobs();

    expect(offsets).toEqual([0, 2, 3]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map(({ title }) => title)).toEqual(['First role', 'Second role', 'Third role']);
  });

  it('retries a short listing until every persisted ID appears in the observation', async () => {
    const fullListings = Array.from({ length: 11 }, (_, index) => listing(index + 1, `Role ${index + 1}`));
    const existingJobs = Array.from({ length: 11 }, (_, index) => existingJob(index + 1));
    const requests: number[] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const requestedDetailJobId = detailJobId(url);
      if (requestedDetailJobId !== null) {
        return new Response(JSON.stringify({ jobFields: { id: requestedDetailJobId } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const offset = Number(url.searchParams.get('firstResult'));
      requests.push(offset);

      const response = requests.length <= 2
        ? {
          jobs: offset === 0 ? fullListings.slice(0, 2) : [],
          globals: { jobsCount: 2 },
        }
        : {
          jobs: offset === 0 ? fullListings : [],
          globals: { jobsCount: fullListings.length },
        };

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const jobs = await fetchAllWeisseArenaJobs({ existingJobs });

    expect(requests).toEqual([0, 2, 0, 11]);
    expect(jobs).toHaveLength(11);
  });

  it('fails closed after three persistently short listing snapshots', async () => {
    const shortListings = Array.from({ length: 2 }, (_, index) => listing(index + 1, `Role ${index + 1}`));
    const existingJobs = Array.from({ length: 11 }, (_, index) => existingJob(index + 1));
    const requests: number[] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const requestedDetailJobId = detailJobId(url);
      if (requestedDetailJobId !== null) {
        return new Response(JSON.stringify({ jobFields: { id: requestedDetailJobId } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const offset = Number(url.searchParams.get('firstResult'));
      requests.push(offset);
      return new Response(JSON.stringify({
        globals: { jobsCount: 2 },
        jobs: offset === 0 ? shortListings : [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }));

    await expect(fetchAllWeisseArenaJobs({ existingJobs }))
      .rejects.toThrow(/snapshot remained incomplete after 3 attempts.*2\/11.*refusing a partial crawl/i);
    expect(requests).toEqual([0, 2, 0, 2, 0, 2]);
  });

  it('rejects a terminal response that omits a page of still-active baseline jobs', async () => {
    const currentListings = Array.from({ length: 50 }, (_, index) => listing(index + 1, `Role ${index + 1}`));
    const existingJobs = Array.from({ length: 100 }, (_, index) => existingJob(index + 1));
    const listingOffsets: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const id = detailJobId(url);
      if (id !== null) return new Response(JSON.stringify({ jobFields: { id } }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const offset = Number(url.searchParams.get('firstResult'));
      listingOffsets.push(offset);
      return new Response(JSON.stringify(offset === 0
        ? { globals: { jobsCount: 50 }, jobs: currentListings }
        : { globals: { jobsCount: 0 } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    await expect(fetchAllWeisseArenaJobs({ existingJobs })).rejects.toThrow(/omitted still-active TalentLink job/i);
    expect(listingOffsets).toEqual([0, 50, 0, 50, 0, 50]);
    expect(existingJobs).toHaveLength(100);
  });

  it.each([
    { label: 'absent', firstEtag: '', terminalEtag: '' },
    { label: 'equal', firstEtag: '"a"', terminalEtag: '"a"' },
    { label: 'different', firstEtag: '"a"', terminalEtag: '"b"' },
  ])('rejects a mutated offset crawl with $label ETags even if the omitted job now returns not found', async ({ firstEtag, terminalEtag }) => {
    const page = Array.from({ length: 50 }, (_, index) => listing(index + 1, `Role ${index + 1}`));
    const existingJobs = Array.from({ length: 100 }, (_, index) => existingJob(index + 1));
    const offsets: number[] = [];
    const omittedJob51Verdicts: string[] = [];
    let sourceMutated = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const id = detailJobId(url);
      if (id !== null) {
        if (id === 1) sourceMutated = false;
        if (id === 51) omittedJob51Verdicts.push(sourceMutated ? 'absent' : 'active');
        return sourceMutated ? detailNotFound() : Response.json({ jobFields: { id } });
      }

      const offset = Number(url.searchParams.get('firstResult'));
      offsets.push(offset);
      if (offset === 0) {
        sourceMutated = false;
        return Response.json({ globals: { jobsCount: 50 }, jobs: page }, {
          headers: firstEtag ? { ETag: firstEtag } : undefined,
        });
      }
      sourceMutated = true;
      return Response.json({ globals: { jobsCount: 0 } }, {
        headers: terminalEtag ? { ETag: terminalEtag } : undefined,
      });
    }));

    mocks.readExistingCrawlerJobs.mockReturnValueOnce(existingJobs);
    const prepareExistingJobs = vi.fn(() => {
      throw new Error('unversioned omission reached the merge stage');
    });
    await expect(runStandardCrawlerPipeline({
      companyKey: WEISSE_ARENA_KEY,
      companyLabel: WEISSE_ARENA_COMPANY_NAME,
      fetchJobs: fetchAllWeisseArenaJobs,
      isCompanyJob: isWeisseArenaJob,
      prepareExistingJobs,
    })).rejects.toThrow(
      /snapshot remained incomplete.*job 51.*before: active; after: absent/i,
    );
    expect(prepareExistingJobs).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).not.toHaveBeenCalled();
    expect(offsets).toEqual([0, 50, 0, 50, 0, 50]);
    expect(omittedJob51Verdicts).toEqual(['active', 'absent', 'active', 'absent', 'active', 'absent']);
    expect(existingJobs.map(({ url }) => new URL(url).searchParams.get('jobId')))
      .toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1)));
  });

  it('binds each proven omission to exactly one actually omitted baseline job', () => {
    const existingJobs = Array.from({ length: 100 }, (_, index) => existingJob(index + 1));
    const parsedJobs = existingJobs.slice(0, 50);
    const numbers = parsedJobs.map((job) => job.jobNumber);
    const ids = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => String(start + index));
    const snapshot = {
      source: 'weisse-arena', coverage: 'observed', pageCount: 2, listingCount: 50,
      minimumExpectedCount: 50, terminalOffset: 50, terminalJobsCount: 0, terminalJobsOmitted: true,
      listingIdentities: numbers, processedIdentities: numbers, listingJobNumbers: numbers,
      processedJobNumbers: numbers, processedCount: 50,
      baselineJobIds: ids(1, 50), currentJobIds: ids(1, 50), absenceVerifiedJobIds: [],
    };
    const check = (receipt: Record<string, unknown>, prior = existingJobs.slice(0, 50)) => (
      verifiedWeisseArenaOmissionProof({
        companyKey: 'weisse-arena',
        fetchMetadata: { discoveredCount: 50, sourceListingSnapshot: receipt },
        parsedJobs,
        existingJobs: prior,
      })
    );
    const completeProof = { ...snapshot, baselineJobIds: ids(1, 100), absenceVerifiedJobIds: ids(51, 100) };
    expect(check(snapshot)).toEqual([]);
    expect(check(snapshot, existingJobs)).toBeNull();
    expect(check(completeProof, existingJobs)).toEqual(existingJobs.slice(50).map((job) => ({
      job, reason: 'talentlink-detail-confirmed-absence', definitive: true,
    })));
    expect(check({ ...completeProof, absenceVerifiedJobIds: ids(51, 99) }, existingJobs)).toBeNull();
    expect(check({ ...completeProof, absenceVerifiedJobIds: [...ids(51, 99), '99'] }, existingJobs)).toBeNull();
    expect(check({ ...completeProof, absenceVerifiedJobIds: [...ids(51, 99), '1'] }, existingJobs)).toBeNull();
    expect(check({ ...snapshot, coverage: undefined, complete: true })).toBeNull();
    expect(check({ ...snapshot, currentJobIds: ids(2, 51) })).toBeNull();
    expect(check({ ...snapshot, currentJobIds: [...ids(1, 49), '49'] })).toBeNull();
    expect(check({ ...snapshot, currentJobIds: [...ids(1, 49), '050'] })).toBeNull();
  });

  it.each([
    {
      name: 'the omitted job is still active',
      detailResponse: () => new Response(JSON.stringify({ jobFields: { id: 51 } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
      expected: /omitted still-active TalentLink job 51/i,
    },
    {
      name: 'the detail response identifies another job',
      detailResponse: () => new Response(JSON.stringify({ jobFields: { id: 999 } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
      expected: /did not attest the same jobId/i,
    },
    {
      name: 'the 400 envelope is not the source not-found proof',
      detailResponse: () => new Response(JSON.stringify({
        errorType: 'APPLICATION',
        errorCode: 'Bad Request',
        errorMsg: 'Temporary failure',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
      expected: /unrecognized status 400/i,
    },
  ])('rejects a two-page shrink when $name', async ({ detailResponse, expected }) => {
    const currentListings = Array.from({ length: 50 }, (_, index) => listing(index + 1, `Role ${index + 1}`));
    const existingJobs = Array.from({ length: 51 }, (_, index) => existingJob(index + 1));
    const listingOffsets: number[] = [];
    const detailRequests: number[] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const requestedDetailJobId = detailJobId(url);
      if (requestedDetailJobId !== null) {
        if (requestedDetailJobId !== 51) return Response.json({ jobFields: { id: requestedDetailJobId } });
        detailRequests.push(requestedDetailJobId);
        return detailResponse();
      }

      const offset = Number(url.searchParams.get('firstResult'));
      listingOffsets.push(offset);
      const response = offset === 0
        ? { globals: { jobsCount: 50 }, jobs: currentListings }
        : { globals: { jobsCount: 0 } };
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
    }));

    await expect(fetchAllWeisseArenaJobs({ existingJobs })).rejects.toThrow(expected);
    expect(listingOffsets).toEqual([0, 50, 0, 50, 0, 50]);
    expect(detailRequests).toEqual([51, 51, 51, 51, 51, 51]);
  });

  it('archives and passes bracketed omissions to the guarded writer on an 11-to-3 crawl', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weisse-arena-crawler-'));
    mocks.scratchPath = path.join(tmp, 'jobs.json');
    vi.stubEnv('GITHUB_STEP_SUMMARY', path.join(tmp, 'step-summary.md'));

    try {
      const existingJobs = Array.from({ length: 11 }, (_, index) => {
        const id = index + 1;
        const title = `Role ${id}`;
        return {
          ...existingJob(id),
          title,
          slug: slugify(`${title} weisse-arena ch`),
          url: buildDetailUrl(id, title),
        };
      });
      const currentIds = [1, 2, 12];
      const body = Array(60).fill('Ausführliche').join(' ');
      const currentListings = currentIds.map((id) => ({
        ...listing(id, `Role ${id}`),
        customFields: [{ title: 'Aufgaben', content: body }],
      }));
      const requests: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const id = detailJobId(url);
        if (id !== null) {
          requests.push(`detail:${id}`);
          return currentIds.includes(id) ? Response.json({ jobFields: { id } }) : detailNotFound();
        }
        const offset = Number(url.searchParams.get('firstResult'));
        requests.push(`listing:${offset}`);
        return Response.json(offset === 0
          ? { globals: { jobsCount: 3 }, jobs: currentListings }
          : { globals: { jobsCount: 0 } });
      }));

      mocks.readExistingCrawlerJobs.mockReturnValueOnce(existingJobs);
      await runStandardCrawlerPipeline({
        companyKey: WEISSE_ARENA_KEY,
        companyLabel: WEISSE_ARENA_COMPANY_NAME,
        fetchJobs: fetchAllWeisseArenaJobs,
        isCompanyJob: isWeisseArenaJob,
      });

      expect(requests).toEqual([
        ...existingJobs.map((_, index) => `detail:${index + 1}`),
        'listing:0', 'listing:3',
        ...existingJobs.slice(2).map((_, index) => `detail:${index + 3}`),
      ]);
      expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledTimes(1);
      const [, jobs, options] = mocks.writeJobsCrawlerSliceVerified.mock.calls[0];
      expect(jobs.map((job: { url: string }) => Number(new URL(job.url).searchParams.get('jobId'))))
        .toEqual(currentIds);
      expect(options.skipShrinkGuard).toBe(false);
      expect(options.housekeepingProof).toEqual(existingJobs.slice(2).map((job) => ({
        job, reason: 'talentlink-detail-confirmed-absence', definitive: true,
      })));
      expect(isProvenHousekeepingPrune(
        'data/jobs/by-crawler/weisse-arena.json',
        JSON.stringify({ jobs: existingJobs }),
        JSON.stringify({ jobs }),
        options.housekeepingProof,
      )).toBe(true);
      expect(mocks.archiveRemovedJobsToSlice).toHaveBeenCalledWith(
        existingJobs.slice(2), WEISSE_ARENA_KEY, expect.objectContaining({ activeJobs: expect.any(Array) }),
      );
      expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(expect.objectContaining({
        written: 3,
        removedCount: 9,
        snapshotCoverage: 'partial',
        authoritativeEmptySnapshot: false,
      }));
    } finally {
      mocks.scratchPath = '';
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('retries an invalid TalentLink envelope and publishes the next complete snapshot', async () => {
    const requests: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('firstResult'));
      requests.push(offset);
      const response = requests.length === 1
        ? { globals: { jobsCount: 1 } }
        : offset === 0
          ? { globals: { jobsCount: 1 }, jobs: [listing(1, 'Recovered role')] }
          : { globals: { jobsCount: 1 }, jobs: [] };
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
    }));
    const jobs = await fetchAllWeisseArenaJobs();
    expect(jobs.map(({ title }) => title)).toEqual(['Recovered role']);
    expect(requests).toEqual([0, 0, 1]);
  });

  it('fails closed after three invalid TalentLink envelopes', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ globals: { jobsCount: 3 } }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchAllWeisseArenaJobs()).rejects.toThrow(/did not expose a jobs array/i);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('fails closed when an empty page arrives before the declared total', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('firstResult'));
      return new Response(JSON.stringify({
        globals: { jobsCount: 2 },
        jobs: offset === 0 ? [listing(1, 'Only role')] : [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }));

    await expect(fetchAllWeisseArenaJobs()).rejects.toThrow(/pagination incomplete.*1\/2/i);
  });

  it.each(['', '   '])('rejects an empty declared jobsCount (%j)', async (jobsCount) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      globals: { jobsCount },
      jobs: [],
    }), { headers: { 'Content-Type': 'application/json' } })));

    await expect(fetchAllWeisseArenaJobs()).rejects.toThrow(/valid globals\.jobsCount/i);
  });

  it('uses the first non-empty listing identity fallback', async () => {
    const fallbackListing = {
      jobFields: {
        jobNumber: ' ',
        id: '101',
        jobTitle: 'Chef',
      },
      customFields: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('firstResult'));
      return new Response(JSON.stringify({
        globals: { jobsCount: 1 },
        jobs: offset === 0 ? [fallbackListing] : [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }));

    const jobs = await fetchAllWeisseArenaJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toContain('jobId=101');
  });

  it('keeps distinct output IDs when jobNumber is whitespace-only', async () => {
    const first = listing(1, 'First role');
    const second = listing(2, 'Second role');
    first.jobFields.jobNumber = ' ';
    first.jobFields.id = 101;
    first.id = 101;
    second.jobFields.jobNumber = ' ';
    second.jobFields.id = 102;
    second.id = 102;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('firstResult'));
      return new Response(JSON.stringify({
        globals: { jobsCount: 2 },
        jobs: offset === 0 ? [first, second] : [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }));

    const jobs = await fetchAllWeisseArenaJobs();

    expect(jobs.map(({ id }) => id)).toHaveLength(2);
    expect(new Set(jobs.map(({ id }) => id)).size).toBe(2);
  });

  it('uses the first non-empty normalized title fallback', async () => {
    const fallbackTitleListing = listing(1, ' ');
    fallbackTitleListing.jobFields.sJobTitle = 'Chef';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('firstResult'));
      return new Response(JSON.stringify({
        globals: { jobsCount: 1 },
        jobs: offset === 0 ? [fallbackTitleListing] : [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }));

    const jobs = await fetchAllWeisseArenaJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Chef');
  });

  it('rejects non-scalar identity fields before emitting a job', async () => {
    const malformedIdentityListing = {
      id: {},
      jobFields: {
        id: {},
        jobNumber: {},
        jobTitle: 'Chef',
      },
      customFields: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      globals: { jobsCount: 1 },
      jobs: [malformedIdentityListing],
    }), { headers: { 'Content-Type': 'application/json' } })));

    await expect(fetchAllWeisseArenaJobs()).rejects.toThrow(/no stable identity/i);
  });

  it('rejects non-textual title fields before emitting a job', async () => {
    const malformedTitleListing = {
      id: 1,
      jobFields: {
        id: 1,
        jobNumber: 'WAG00001',
        jobTitle: {},
        sJobTitle: '',
      },
      customFields: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      globals: { jobsCount: 1 },
      jobs: [malformedTitleListing],
    }), { headers: { 'Content-Type': 'application/json' } })));

    await expect(fetchAllWeisseArenaJobs()).rejects.toThrow(/no usable job title/i);
  });
});

// ─── Slug generation ────────────────────────────────────────────────────────────

describe('slug generation', () => {
  it('generates slug for German job title with company suffix', () => {
    const slug = slugify('CRM & Lifecycle Marketing Manager weisse-arena ch');
    expect(slug).toBe('crm-lifecycle-marketing-manager-weisse-arena-ch');
  });

  it('handles colons in gender-neutral titles', () => {
    const slug = slugify('Servicemitarbeiter:in weisse-arena ch');
    expect(slug).toBe('servicemitarbeiter-in-weisse-arena-ch');
  });

  it('handles umlauts', () => {
    const slug = slugify('Verantwortliche:r Frühstücksköchin/Koch weisse-arena ch');
    expect(slug).toContain('fruhstuckskochin');
  });

  it('truncates to max 90 characters', () => {
    const longTitle = 'a'.repeat(200);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

// ─── Job Shape Validation ───────────────────────────────────────────────────────

describe('job shape', () => {
  const validJob = {
    id: 'weisse-arena-abc123def456',
    slug: 'crm-lifecycle-marketing-manager-weisse-arena-ch',
    slugByLocale: { de: 'crm-lifecycle-marketing-manager-weisse-arena-ch' },
    company: 'Weisse Arena Gruppe',
    companyKey: 'weisse-arena',
    companyDomain: 'weissearena.com',
    title: 'CRM & Lifecycle Marketing Manager',
    titleByLocale: { de: 'CRM & Lifecycle Marketing Manager' },
    description: 'Planung, Aufbau und Umsetzung von Kampagnen...',
    descriptionByLocale: { de: 'Planung, Aufbau und Umsetzung von Kampagnen...' },
    location: 'Laax',
    canton: 'GR',
    url: 'https://www.weissearena.com/jobs/details.html?jobId=4484&jobTitle=CRM+%26+Lifecycle+Marketing+Manager',
    source: 'Weisse Arena Gruppe Dedicated Parser',
    sourceLang: 'de',
    crawledAt: new Date().toISOString(),
    addressLocality: 'Laax',
    postalCode: '7031',
    addressCountry: 'CH',
    country: 'CH',
    category: 'Marketing',
    contract: 'full-time',
    employmentType: 'FULL_TIME',
    experienceLevel: 'mid',
    sector: 'Turismo / Sport',
    currency: 'CHF',
    featured: false,
    postedDate: '2025-06-28',
    applyUrl: 'https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4484&langCode=de_DE',
    department: 'Digitalisation and Data Analytics',
    jobNumber: 'WAG02350',
    pensum: '80 - 100%',
    contractLabel: 'Festanstellung',
  };

  it('has all required fields', () => {
    const required = [
      'id', 'slug', 'slugByLocale', 'company', 'companyKey', 'companyDomain',
      'title', 'titleByLocale', 'description', 'descriptionByLocale',
      'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
    ];
    for (const field of required) {
      expect(validJob).toHaveProperty(field);
    }
  });

  it('has all recommended fields', () => {
    const recommended = [
      'addressLocality', 'postalCode', 'addressCountry', 'country',
      'category', 'contract', 'employmentType', 'experienceLevel',
      'sector', 'currency', 'postedDate', 'applyUrl',
    ];
    for (const field of recommended) {
      expect(validJob).toHaveProperty(field);
    }
  });

  it('slug only contains source locale', () => {
    const locales = Object.keys(validJob.slugByLocale);
    expect(locales).toHaveLength(1);
    expect(locales[0]).toBe(validJob.sourceLang);
  });

  it('id starts with company key', () => {
    expect(validJob.id).toMatch(/^weisse-arena-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('location is Laax (all jobs are at LAAX resort)', () => {
    expect(validJob.location).toBe('Laax');
    expect(validJob.canton).toBe('GR');
    expect(validJob.postalCode).toBe('7031');
  });

  it('sector is Turismo / Sport', () => {
    expect(validJob.sector).toBe('Turismo / Sport');
  });

  it('source lang is German', () => {
    expect(validJob.sourceLang).toBe('de');
  });
});
