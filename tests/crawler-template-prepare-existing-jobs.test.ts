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
        description: 'Ihre Aufgaben: Pflege der Patientinnen und Patienten.',
        descriptionByLocale: { de: 'Ihre Aufgaben: Pflege der Patientinnen und Patienten.' },
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

  it('does not call the hook on a run that keeps the stored slice (no jobs parsed)', async () => {
    const prepareExistingJobs = vi.fn();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-existing-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Prepare Existing Test',
        root,
        fetchJobs: async () => [],
        isCompanyJob: () => true,
        prepareExistingJobs,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(prepareExistingJobs).not.toHaveBeenCalled();
    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
  });
});
