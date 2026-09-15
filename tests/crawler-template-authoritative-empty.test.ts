import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  archiveRemovedJobsToSlice: vi.fn(() => 1),
  assembleJobsDataset: vi.fn(async () => undefined),
  readExistingCrawlerJobs: vi.fn(() => [{
    id: 'test-old-1',
    slug: 'old-job',
    companyKey: 'authoritative-empty-test',
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

import {
  evaluateAuthoritativeSnapshot,
  exitCrawlerOnError,
  runStandardCrawlerPipeline,
} from '../scripts/lib/crawler-template.mjs';

const COMPANY_KEY = 'authoritative-empty-test';
const SCRATCH_PATH = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${COMPANY_KEY}.json`);

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(SCRATCH_PATH, { force: true });
});

describe('standard crawler authoritative-empty policy', () => {
  it('records a connection bail-out in the exit-guard counters (#8376)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-outcome-root-'));
    mocks.isConnectionLevelFetchError.mockReturnValueOnce(true);
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Connection Outcome Test',
        root,
        fetchJobs: async () => {
          throw new TypeError('fetch failed');
        },
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const [, , counts] = mocks.registerCrawlerSummaryGuard.mock.calls.at(-1);
    expect(counts.lastFetchOutcome).toBe('connection_error');
    expect(counts.abortKind).toBe('connection-level-fetch');
  });

  it('classifies an exhausted anti-bot fence as a connection bail-out (#7784)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-bot-abort-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Anti-Bot Abort Test',
        root,
        fetchJobs: async () => {
          throw Object.assign(new Error('HTTP 403 after all anti-bot fallbacks'), {
            antiBotExhausted: true,
          });
        },
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const [, , counts] = mocks.registerCrawlerSummaryGuard.mock.calls.at(-1);
    expect(counts.lastFetchOutcome).toBe('connection_error');
    expect(counts.abortKind).toBe('connection-level-fetch');
  });

  it('pins the fail-closed no-jobs bail-out in the exit-guard counters (#7784)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-jobs-abort-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'No Jobs Abort Test',
        root,
        fetchJobs: async () => [],
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const [, , counts] = mocks.registerCrawlerSummaryGuard.mock.calls.at(-1);
    expect(counts.abortKind).toBe('no-jobs-parsed');
  });

  it('records an unavailable feed endpoint in the exit-guard counters (#8375)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-outcome-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Feed Outcome Test',
        root,
        fetchJobs: async () => {
          const error = new Error('feed redirected to the vendor homepage') as Error & {
            feedEndpointUnavailable?: boolean;
          };
          error.feedEndpointUnavailable = true;
          throw error;
        },
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const [, , counts] = mocks.registerCrawlerSummaryGuard.mock.calls.at(-1);
    expect(counts.lastFetchOutcome).toBe('feed_endpoint_unavailable');
    expect(counts.abortKind).toBe('connection-level-fetch');
  });

  it('records an exhausted retry response in the exit-guard counters (#7854)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exhausted-retry-outcome-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Exhausted Retry Test',
        root,
        fetchJobs: async () => {
          throw Object.assign(new Error('HTTP 503'), {
            status: 503,
            retryBudgetExhausted: true,
          });
        },
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const [, , counts] = mocks.registerCrawlerSummaryGuard.mock.calls.at(-1);
    expect(counts.lastFetchOutcome).toBe('exhausted_retry');
    expect(counts.abortKind).toBe('connection-level-fetch');
  });

  it('marks custom-main soft exits as connection-level fetch failures (#7784)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      expect(() => exitCrawlerOnError(
        Object.assign(new Error('feed unavailable'), { feedEndpointUnavailable: true }),
        'Custom-main feed test',
      )).toThrow('exit:0');
      expect(mocks.markCrawlerSummaryAbortKind).toHaveBeenCalledWith('connection-level-fetch');

      mocks.markCrawlerSummaryAbortKind.mockClear();
      expect(() => exitCrawlerOnError(
        Object.assign(new Error('HTTP 503'), { status: 503, retryBudgetExhausted: true }),
        'Custom-main retry test',
      )).toThrow('exit:0');
      expect(mocks.markCrawlerSummaryAbortKind).toHaveBeenCalledWith('connection-level-fetch');
    } finally {
      exit.mockRestore();
    }
  });

  it('allows zero only when both the source validator and explicit opt-in agree', () => {
    const validator = vi.fn(() => true);
    expect(evaluateAuthoritativeSnapshot([], {
      validateAuthoritativeSnapshot: validator,
      allowAuthoritativeEmptySnapshot: true,
      companyLabel: 'Test',
    })).toEqual({
      authoritativeSnapshotVerified: true,
      authoritativeEmptySnapshot: true,
    });
    expect(validator).toHaveBeenCalledOnce();
  });

  it('publishes a verified zero, archives prior identities, and skips localization', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authoritative-empty-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Authoritative Empty Test',
        root,
        fetchJobs: async () => [],
        isCompanyJob: () => true,
        validateAuthoritativeSnapshot: () => true,
        allowAuthoritativeEmptySnapshot: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.runDedicatedBaseCrawler).not.toHaveBeenCalled();
    expect(mocks.validateDedicatedLocaleCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ failWhenNoJobs: false }),
    );
    expect(mocks.archiveRemovedJobsToSlice).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'test-old-1', slug: 'old-job' })],
      COMPANY_KEY,
    );
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({ skipShrinkGuard: true }),
    );
    expect(mocks.assembleJobsDataset).toHaveBeenCalledOnce();
    // #7324: the proof must reach the summary slice, otherwise
    // check-crawler-health.mjs reads this published zero as a dead selector
    // (`discovered: 0`, so the #5945 filtered-empty rule cannot fire either)
    // and accrues a broken streak no parser fix can clear.
    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({ key: COMPANY_KEY, total: 0, authoritativeEmptySnapshot: true }),
    );
  });

  it('reports the post-parser count so a pipeline-level emptying is not read as filtered-empty (#7707)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-parser-count-root-'));
    // The parser hands 2 jobs to the pipeline; a post-parser stage drops them
    // all. Without `parsed`, the slice reads `discovered > 0, written === 0` —
    // the exact shape of a legitimate geographic filter-empty — and
    // check-crawler-health classifies a broken crawler as healthy.
    mocks.mergePreserveLocaleData.mockImplementationOnce(() => []);
    const parsedJobs = Object.assign(
      [
        { id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' },
        { id: 'test-new-2', slug: 'other-job', url: 'https://example.com/other-job' },
      ],
      { discoveredCount: 7 },
    );
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Authoritative Empty Test',
        root,
        fetchJobs: async () => parsedJobs,
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({ discovered: 7, parsed: 2, written: 0 }),
    );
  });

  it('reports parsed alongside written on a run that published every parsed job', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-parser-count-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Authoritative Empty Test',
        root,
        fetchJobs: async () => [
          { id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' },
        ],
        isCompanyJob: (job: { id?: string }) => job.id === 'test-new-1',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({ parsed: 1, written: 1 }),
    );
  });

  it('carries a Coop detail-drop observation into the standard summary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-drop-summary-root-'));
    const parsedJobs = Object.assign(
      [{ id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' }],
      { detailDrop: { candidates: 10, gone: 1, rejected: 1 } },
    );
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Detail Drop Summary Test',
        root,
        fetchJobs: async () => parsedJobs,
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({
        detailCandidates: 10,
        detailGone: 1,
        detailRejected: 1,
      }),
    );
  });

  it('preserves structured fetch metadata in the summary slice', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-fetch-result-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Structured Fetch Result Test',
        root,
        fetchJobs: async () => ({
          jobs: [{ id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' }],
          fetchOutcome: 'selector_miss',
        }),
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({ lastFetchOutcome: 'selector_miss', parsed: 1, written: 2 }),
    );
  });

  it('keeps the existing slice when missing detail URLs exceed the source-loss quota', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-detail-url-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Missing Detail URL Test',
        root,
        fetchJobs: async () => ({
          jobs: [{ id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' }],
          missingDetailUrlCount: 1,
        }),
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).not.toHaveBeenCalled();
    expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
  });

  it('allows exactly the source-loss quota, but not a larger drop', async () => {
    mocks.readExistingCrawlerJobs.mockReturnValueOnce(
      Array.from({ length: 5 }, (_, index) => ({
        id: `test-old-${index}`,
        slug: `old-job-${index}`,
        companyKey: COMPANY_KEY,
      })),
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-detail-url-boundary-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Missing Detail URL Boundary Test',
        root,
        fetchJobs: async () => ({
          jobs: [{ id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' }],
          missingDetailUrlCount: 2,
        }),
        isCompanyJob: () => true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.mergePreserveLocaleData).toHaveBeenCalled();
  });

  it('does not claim an authoritative empty snapshot on a run that published jobs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authoritative-empty-root-'));
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Authoritative Empty Test',
        root,
        fetchJobs: async () => [{ id: 'test-new-1', slug: 'new-job', url: 'https://example.com/new-job' }],
        isCompanyJob: () => true,
        validateAuthoritativeSnapshot: () => true,
        allowAuthoritativeEmptySnapshot: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeEmptySnapshot: false }),
    );
  });

  it('keeps the legacy zero policy when the caller does not explicitly opt in', () => {
    expect(evaluateAuthoritativeSnapshot([], {
      validateAuthoritativeSnapshot: () => true,
      companyLabel: 'Test',
    })).toEqual({
      authoritativeSnapshotVerified: true,
      authoritativeEmptySnapshot: false,
    });
  });

  it('does not let the opt-in replace source-specific validation', () => {
    expect(evaluateAuthoritativeSnapshot([], {
      allowAuthoritativeEmptySnapshot: true,
      companyLabel: 'Test',
    })).toEqual({
      authoritativeSnapshotVerified: false,
      authoritativeEmptySnapshot: false,
    });
  });

  it('rejects validators that do not prove the snapshot', () => {
    expect(() => evaluateAuthoritativeSnapshot([], {
      validateAuthoritativeSnapshot: () => false,
      allowAuthoritativeEmptySnapshot: true,
      companyLabel: 'Test',
    })).toThrow(/Test: authoritative snapshot validator did not return true/);
  });

  it('never classifies non-empty snapshots as authoritative empty', () => {
    expect(evaluateAuthoritativeSnapshot([{ id: 'job-1' }], {
      validateAuthoritativeSnapshot: () => true,
      allowAuthoritativeEmptySnapshot: true,
      companyLabel: 'Test',
    }).authoritativeEmptySnapshot).toBe(false);
  });

  it('keeps miss grace for non-empty partial batches when authority is empty-only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authoritative-partial-root-'));
    const validator = vi.fn(() => true);
    const freshJob = {
      id: 'test-fresh-1',
      slug: 'fresh-job',
      companyKey: COMPANY_KEY,
      title: 'Fresh job',
      description: 'A sufficiently detailed fresh job description for the fixture.',
      location: 'Lugano',
      canton: 'TI',
      url: 'https://example.com/jobs/fresh',
    };
    try {
      await runStandardCrawlerPipeline({
        companyKey: COMPANY_KEY,
        companyLabel: 'Authoritative Partial Test',
        root,
        fetchJobs: async () => [freshJob],
        isCompanyJob: () => true,
        validateAuthoritativeSnapshot: validator,
        allowAuthoritativeEmptySnapshot: true,
        authoritativeSnapshotScope: 'empty-only',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(mocks.mergePreserveLocaleData).toHaveBeenCalledWith(
      expect.any(Array),
      [freshJob],
      {},
    );
    expect(validator).not.toHaveBeenCalled();
    expect(mocks.archiveRemovedJobsToSlice).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      expect.arrayContaining([
        expect.objectContaining({ id: 'test-fresh-1' }),
        expect.objectContaining({ id: 'test-old-1' }),
      ]),
      expect.any(Object),
    );
  });
});
