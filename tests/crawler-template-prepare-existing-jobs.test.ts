import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same module mocks as crawler-template-authoritative-empty.test.ts: the
// pipeline runs for real up to the merge, without I/O or network.
const mocks = vi.hoisted(() => ({
  archiveRemovedJobsToSlice: vi.fn(() => 1),
  assembleJobsDataset: vi.fn(async () => undefined),
  readExistingCrawlerJobs: vi.fn(() => [{
    id: 'stored-1',
    slug: 'stored-job',
    url: 'https://example.com/stored-job',
    companyKey: 'prepare-existing-test',
    sourceLang: 'de',
    description: 'Die Klinik ist ein Zentrum. Stelle: Pflege.',
    descriptionByLocale: {
      de: 'Die Klinik ist ein Zentrum. Stelle: Pflege.',
      it: 'La clinica è un centro. Posto: cura.',
    },
  }]),
  runDedicatedBaseCrawler: vi.fn(async () => undefined),
  mergePreserveLocaleData: vi.fn((existing: object[], fresh: object[], opts: { retainMissingJobs?: boolean } = {}) => (
    opts.retainMissingJobs === false ? fresh : [...fresh, ...existing]
  )),
  validateDedicatedLocaleCoverage: vi.fn(() => undefined),
  writeJobsCrawlerSliceVerified: vi.fn(async () => ({ written: true, shrinkAccepted: false })),
  writeSummaryCrawlerSlice: vi.fn(() => undefined),
  registerCrawlerSummaryGuard: vi.fn(),
  markCrawlerSummaryAbortKind: vi.fn(),
  isConnectionLevelFetchError: vi.fn(() => false),
  detectBoilerplateDescriptions: vi.fn(() => ({ boilerplateJobs: [], totalJobs: 1, boilerplateCount: 0, ratio: 0 })),
  isSystemicBoilerplateFailure: vi.fn(() => false),
}));

vi.mock('../scripts/jobs-url-helper.mjs', () => ({
  snapshotJobSlugs: (jobs: Array<{ id?: string }>) => new Map(jobs.map((job) => [job.id, job])),
  computeCrawlDiff: (before: Map<string, object>, after: Map<string, object>) => ({
    newJobs: [],
    updatedJobs: [],
    removedJobs: [...before.entries()]
      .filter(([id]) => !after.has(id))
      .map(([, job]) => job),
    unchangedJobs: [],
    unchangedCount: 0,
  }),
  printCrawlChangeSummary: vi.fn(),
  writeCrawlChangeSummaryToGH: vi.fn(),
  printPublishedJobUrls: vi.fn(),
  writeJobsSummary: vi.fn(),
  setCrawlerStartTime: vi.fn(),
  getCrawlerElapsedMs: vi.fn(() => 25),
}));

vi.mock('../scripts/assemble-jobs-dataset.mjs', () => ({
  writeJobsCrawlerSlice: vi.fn(),
  writeJobsCrawlerSliceVerified: mocks.writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice: mocks.writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard: mocks.registerCrawlerSummaryGuard,
  markCrawlerSummaryAbortKind: mocks.markCrawlerSummaryAbortKind,
  assembleJobsDataset: mocks.assembleJobsDataset,
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
  detectBoilerplateDescriptions: mocks.detectBoilerplateDescriptions,
  isSystemicBoilerplateFailure: mocks.isSystemicBoilerplateFailure,
}));

vi.mock('../scripts/lib/dedicated-crawler-common.mjs', () => ({
  runDedicatedBaseCrawler: mocks.runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage: mocks.validateDedicatedLocaleCoverage,
  mergePreserveLocaleData: mocks.mergePreserveLocaleData,
  detectLang: vi.fn(() => 'it'),
  deriveLocalizedSlug: vi.fn(() => 'slug'),
}));

vi.mock('../scripts/lib/expired-jobs-archive.mjs', () => ({
  archiveRemovedJobsToSlice: mocks.archiveRemovedJobsToSlice,
}));

vi.mock('../scripts/lib/transient-fetch.mjs', () => ({
  RETRYABLE_STATUS: new Set([500, 502, 503, 504]),
  WAF_IP_BLOCK_STATUS: new Set([403]),
  isTransientFetchError: vi.fn(() => false),
  isConnectionLevelFetchError: mocks.isConnectionLevelFetchError,
  fetchWithRetry: vi.fn(),
}));

vi.mock('../scripts/lib/jina-proxy.mjs', () => ({
  fetchHtmlViaJinaWithRetry: vi.fn(),
  rescueHtmlIfChallenged: vi.fn(),
}));

vi.mock('../scripts/lib/prospector/public-fetch-policy.mjs', () => ({
  fetchFollowingValidatedRedirects: vi.fn(),
}));

vi.mock('../scripts/lib/slug-truncate.mjs', () => ({
  truncateSlugAtWordBoundary: (value: string, maxLength: number) => value.slice(0, maxLength),
}));

import { runStandardCrawlerPipeline } from '../scripts/lib/crawler-template.mjs';
import { dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';

const COMPANY_KEY = 'prepare-existing-test';
const SCRATCH_PATH = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${COMPANY_KEY}.json`);
const SOURCE_BODY = Array(60).fill('source').join(' ');

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(SCRATCH_PATH, { force: true });
});

async function runPipeline(extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-existing-root-'));
  try {
    await runStandardCrawlerPipeline({
      companyKey: COMPANY_KEY,
      companyLabel: 'Prepare Existing Test',
      root,
      fetchJobs: async () => [{
        id: 'fresh-1',
        slug: 'stored-job',
        url: 'https://example.com/stored-job',
        companyKey: COMPANY_KEY,
        sourceLang: 'de',
        description: SOURCE_BODY,
        descriptionByLocale: { de: SOURCE_BODY },
      }],
      isCompanyJob: (job: { companyKey?: string }) => job.companyKey === COMPANY_KEY,
      ...extra,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('runStandardCrawlerPipeline prepareExistingJobs (opt-in)', () => {
  it('merges the stored jobs unchanged when the option is absent', async () => {
    await runPipeline();
    expect(mocks.mergePreserveLocaleData).toHaveBeenCalledTimes(1);
    const [existing] = mocks.mergePreserveLocaleData.mock.calls[0];
    expect(existing).toEqual([expect.objectContaining({
      id: 'stored-1',
      description: 'Die Klinik ist ein Zentrum. Stelle: Pflege.',
      descriptionByLocale: {
        de: 'Die Klinik ist ein Zentrum. Stelle: Pflege.',
        it: 'La clinica è un centro. Posto: cura.',
      },
    })]);
    expect(existing[0]).not.toHaveProperty('needsRetranslation');
  });

  it('hands the stored jobs to the hook before the merge and merges what it returns', async () => {
    const order: string[] = [];
    mocks.mergePreserveLocaleData.mockImplementationOnce((existing: object[], fresh: object[]) => {
      order.push('merge');
      return [...fresh];
    });
    const prepareExistingJobs = vi.fn((jobs: object[]) => {
      order.push('prepare');
      return dropFabricatedDescriptions(jobs, /Stelle: Pflege\./, 'Prepare Existing Test');
    });
    await runPipeline({ prepareExistingJobs });

    expect(order).toEqual(['prepare', 'merge']);
    expect(prepareExistingJobs).toHaveBeenCalledWith([expect.objectContaining({ id: 'stored-1' })]);
    const [existing] = mocks.mergePreserveLocaleData.mock.calls[0];
    expect(existing[0].descriptionByLocale).toEqual({});
    expect(existing[0].description).toBe('');
    expect(existing[0].needsRetranslation).toBe(true);
  });

  it('keeps the stored jobs when the hook repairs them in place and returns nothing', async () => {
    await runPipeline({ prepareExistingJobs: (jobs: Array<{ tag?: string }>) => { jobs[0].tag = 'seen'; } });
    const [existing] = mocks.mergePreserveLocaleData.mock.calls[0];
    expect(existing).toEqual([expect.objectContaining({ id: 'stored-1', tag: 'seen' })]);
  });

  it('quarantines a non-empty standard-pipeline result without a source body', async () => {
    mocks.readExistingCrawlerJobs.mockReturnValueOnce([{
      id: 'stored-1',
      slug: 'stored-job',
      url: 'https://example.com/stored-job',
      companyKey: COMPANY_KEY,
      sourceLang: 'de',
      description: '',
      descriptionByLocale: { de: '' },
    }]);
    await runPipeline({
      fetchJobs: async () => [{
        id: 'fresh-1',
        slug: 'stored-job',
        url: 'https://example.com/stored-job',
        companyKey: COMPANY_KEY,
        sourceLang: 'de',
        description: '',
        descriptionByLocale: { de: '' },
      }],
      prepareExistingJobs: (jobs) => jobs,
    });

    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({
        housekeepingProof: [expect.objectContaining({
          job: expect.objectContaining({ url: 'https://example.com/stored-job', slug: 'stored-job' }),
          reason: 'thin-source-quarantine',
          definitive: true,
        })],
      }),
    );
  });

  it('records a failed PDF without thin-source quarantine and keeps no empty row', async () => {
    mocks.readExistingCrawlerJobs.mockReturnValueOnce([{
      id: 'stored-1',
      slug: 'stored-job',
      url: 'https://example.com/stored-job',
      companyKey: COMPANY_KEY,
      sourceLang: 'de',
      description: '',
      descriptionByLocale: { de: '' },
    }]);
    await runPipeline({
      fetchJobs: async () => [{
        id: 'stored-1',
        slug: 'stored-job',
        url: 'https://example.com/stored-job',
        companyKey: COMPANY_KEY,
        sourceLang: 'de',
        description: '',
        descriptionByLocale: { de: '' },
        sourceBodyFailureReason: 'pdf-extraction-failed',
        sourceBodyFailureMessage: 'no text extracted',
      }],
      prepareExistingJobs: (jobs) => jobs,
    });

    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({
        housekeepingProof: [expect.objectContaining({
          job: expect.objectContaining({ url: 'https://example.com/stored-job' }),
          reason: 'pdf-extraction-failed',
          definitive: true,
        })],
      }),
    );
    expect(mocks.writeJobsCrawlerSliceVerified.mock.calls[0][2].housekeepingProof)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'thin-source-quarantine' }),
      ]));
  });

  it('uses a stored source body when a non-empty standard-pipeline result is thin', async () => {
    mocks.readExistingCrawlerJobs.mockReturnValueOnce([{
      id: 'stored-1',
      slug: 'stored-job',
      url: 'https://example.com/stored-job',
      companyKey: COMPANY_KEY,
      sourceLang: 'de',
      description: SOURCE_BODY,
      descriptionByLocale: { de: SOURCE_BODY },
    }]);
    await runPipeline({
      fetchJobs: async () => [{
        id: 'fresh-1',
        slug: 'stored-job',
        url: 'https://example.com/stored-job',
        companyKey: COMPANY_KEY,
        sourceLang: 'de',
        description: 'short fresh detail',
        descriptionByLocale: { de: 'short fresh detail' },
      }],
    });

    expect(mocks.mergePreserveLocaleData).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ description: SOURCE_BODY })]),
      [expect.objectContaining({ description: SOURCE_BODY, sourceLang: 'de' })],
      {},
    );
  });

  it('proves a thin source removal when a mixed run keeps a publishable sibling', async () => {
    const thinBody = Array(40).fill('stored').join(' ');
    const freshThinBody = Array(35).fill('fresh').join(' ');
    mocks.readExistingCrawlerJobs.mockReturnValueOnce([{
      id: 'stored-thin',
      slug: 'stored-thin',
      url: 'https://example.com/stored-thin',
      companyKey: COMPANY_KEY,
      sourceLang: 'de',
      description: thinBody,
      descriptionByLocale: { de: thinBody },
    }]);
    await runPipeline({
      fetchJobs: async () => [{
        id: 'fresh-thin',
        slug: 'stored-thin',
        url: 'https://example.com/stored-thin',
        companyKey: COMPANY_KEY,
        sourceLang: 'de',
        description: freshThinBody,
        descriptionByLocale: { de: freshThinBody },
      }, {
        id: 'fresh-rich',
        slug: 'fresh-rich',
        url: 'https://example.com/fresh-rich',
        companyKey: COMPANY_KEY,
        sourceLang: 'de',
        description: SOURCE_BODY,
        descriptionByLocale: { de: SOURCE_BODY },
      }],
    });

    const [key, jobs, options] = mocks.writeJobsCrawlerSliceVerified.mock.calls[0];
    expect(key).toBe(COMPANY_KEY);
    expect(jobs).toEqual([expect.objectContaining({ url: 'https://example.com/fresh-rich' })]);
    expect(options).toMatchObject({
      housekeepingProof: [{
        job: expect.objectContaining({ url: 'https://example.com/stored-thin' }),
        reason: 'thin-source-quarantine',
        definitive: true,
      }],
    });
  });
});

// A run that parses no job keeps the stored slice. The hook still runs on the
// stored jobs, so the crawler's own text does not outlive the fix while the
// source stays empty; the slice is rewritten only when the hook changed it.
describe('runStandardCrawlerPipeline prepareExistingJobs on a run that parses no job', () => {
  async function runEmpty(extra: Record<string, unknown> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-existing-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Prepare Existing Test',
        root,
        fetchJobs: async () => [],
        isCompanyJob: (job: { companyKey?: string }) => job.companyKey === COMPANY_KEY,
        ...extra,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const dropStelle = (jobs: object[]) => dropFabricatedDescriptions(jobs, /Stelle: Pflege\./, 'Prepare Existing Test');

  it('rewrites the stored slice without the crawler text, and does nothing else', async () => {
    await runEmpty({ prepareExistingJobs: dropStelle });

    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledTimes(1);
    const [key, jobs, options] = mocks.writeJobsCrawlerSliceVerified.mock.calls[0];
    expect(key).toBe(COMPANY_KEY);
    expect(jobs).toEqual([]);
    expect(options).toMatchObject({
      preserveExistingSlugs: false,
      housekeepingProof: [expect.objectContaining({
        job: expect.objectContaining({ url: 'https://example.com/stored-job', slug: 'stored-job' }),
        reason: 'thin-source-quarantine',
        definitive: true,
      })],
    });
    expect(options).not.toHaveProperty('skipShrinkGuard');
    // Still the soft exit: no merge or direct template retirement/localization;
    // the verified writer receives the proof before the process returns.
    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
    expect(mocks.archiveRemovedJobsToSlice).not.toHaveBeenCalled();
    expect(mocks.runDedicatedBaseCrawler).not.toHaveBeenCalled();
    expect(mocks.assembleJobsDataset).toHaveBeenCalledTimes(1);
  });

  it('quarantines a stored job that has no source body even when the hook finds no crawler text', async () => {
    const prepareExistingJobs = vi.fn((jobs: object[]) => dropFabricatedDescriptions(jobs, /Karriereseite: /, 'Prepare Existing Test'));
    await runEmpty({ prepareExistingJobs });
    expect(prepareExistingJobs).toHaveBeenCalledTimes(1);
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({
        housekeepingProof: [expect.objectContaining({
          job: expect.objectContaining({ url: 'https://example.com/stored-job', slug: 'stored-job' }),
          definitive: true,
        })],
      }),
    );
  });

  it('writes nothing without the option (unchanged behaviour)', async () => {
    await runEmpty();
    expect(mocks.writeJobsCrawlerSliceVerified).not.toHaveBeenCalled();
    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
  });

  it('evaluates the systemic guard on publishable jobs before all-thin quarantine', async () => {
    mocks.detectBoilerplateDescriptions.mockImplementationOnce((jobs: object[]) => {
      expect(jobs).toEqual([]);
      return { boilerplateJobs: [{ slug: 'stored-job' }], totalJobs: 1, boilerplateCount: 1, ratio: 1 };
    });
    mocks.isSystemicBoilerplateFailure.mockReturnValueOnce(true);
    await runEmpty({ prepareExistingJobs: dropStelle });
    expect(mocks.detectBoilerplateDescriptions).toHaveBeenCalledTimes(1);
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({ housekeepingProof: expect.any(Array) }),
    );
  });

  it('stays a soft exit when the rewrite fails', async () => {
    mocks.writeJobsCrawlerSliceVerified.mockRejectedValueOnce(new Error('shrink guard'));
    await expect(runEmpty({ prepareExistingJobs: dropStelle })).resolves.toBeUndefined();
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledTimes(1);
  });
});
