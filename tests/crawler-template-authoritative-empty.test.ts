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
  validateDedicatedLocaleCoverage: vi.fn(() => undefined),
  writeJobsCrawlerSliceVerified: vi.fn(async () => ({ written: true, shrinkAccepted: false })),
  writeSummaryCrawlerSlice: vi.fn(() => undefined),
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
  registerCrawlerSummaryGuard: vi.fn(),
  assembleJobsDataset: mocks.assembleJobsDataset,
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
}));

vi.mock('../scripts/lib/dedicated-crawler-common.mjs', () => ({
  runDedicatedBaseCrawler: mocks.runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage: mocks.validateDedicatedLocaleCoverage,
  mergePreserveLocaleData: (_existing: object[], fresh: object[]) => fresh,
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
  isConnectionLevelFetchError: vi.fn(() => false),
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
  runStandardCrawlerPipeline,
} from '../scripts/lib/crawler-template.mjs';

const COMPANY_KEY = 'authoritative-empty-test';
const SCRATCH_PATH = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${COMPANY_KEY}.json`);

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(SCRATCH_PATH, { force: true });
});

describe('standard crawler authoritative-empty policy', () => {
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
});
