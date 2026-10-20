import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchBaronieJobUrls: vi.fn(),
  fetchBaronieDetailPage: vi.fn(),
  readExistingCrawlerJobs: vi.fn(),
  registerCrawlerSummaryGuard: vi.fn(),
  writeJobsCrawlerSliceVerified: vi.fn(),
  writeJobsCrawlerSlice: vi.fn(),
  writeSummaryCrawlerSlice: vi.fn(),
  assembleJobsDataset: vi.fn(),
  rewritePreparedStoredJobs: vi.fn(),
}));

vi.mock('../scripts/lib/baronie-job-parser.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/baronie-job-parser.mjs')>()),
  fetchBaronieJobUrls: mocks.fetchBaronieJobUrls,
  fetchBaronieDetailPage: mocks.fetchBaronieDetailPage,
}));

vi.mock('../scripts/assemble-jobs-dataset.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/assemble-jobs-dataset.mjs')>()),
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
  registerCrawlerSummaryGuard: mocks.registerCrawlerSummaryGuard,
  writeJobsCrawlerSliceVerified: mocks.writeJobsCrawlerSliceVerified,
  writeJobsCrawlerSlice: mocks.writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice: mocks.writeSummaryCrawlerSlice,
  assembleJobsDataset: mocks.assembleJobsDataset,
}));

vi.mock('../scripts/lib/stored-jobs-soft-exit.mjs', () => ({
  rewritePreparedStoredJobs: mocks.rewritePreparedStoredJobs,
}));

import { main } from '../scripts/update-baronie-jobs.mjs';

const VALID_URL = 'https://www.baronie.com/en/jobs/production-operator';
const INCOMPLETE_URL = 'https://www.baronie.com/en/jobs/unreadable-detail';
const STORED_JOB = {
  url: VALID_URL,
  slug: 'production-operator-baronie-caslano',
  companyKey: 'baronie',
  company: 'Chocolat Alprose SA',
  description: 'Previously published source-backed description',
};

const VALID_DETAIL = {
  detailTitle: 'Production Operator',
  introText: 'Intro',
  bodyMarkdown: 'Responsibilities\n- Operate the production line safely.',
  markdown: 'Intro\nResponsibilities\n- Operate the production line safely.',
  sectionCount: 1,
  location: 'Caslano',
  addressCountry: 'CH',
  company: 'Chocolat Alprose SA',
};

describe('Baronie crawler snapshot guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.fetchBaronieJobUrls.mockResolvedValue([VALID_URL, INCOMPLETE_URL]);
    mocks.fetchBaronieDetailPage
      .mockResolvedValueOnce(VALID_DETAIL)
      .mockResolvedValueOnce(null);
    mocks.readExistingCrawlerJobs.mockReturnValue([STORED_JOB]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves the stored slice and reports source-extraction-failed for a partial Swiss snapshot', async () => {
    const run = main();
    await vi.runAllTimersAsync();
    await run;

    const counts = mocks.registerCrawlerSummaryGuard.mock.calls[0][2];
    expect(counts).toMatchObject({ parsed: 1, abortKind: 'source-extraction-failed' });
    expect(mocks.readExistingCrawlerJobs).not.toHaveBeenCalled();
    expect(mocks.rewritePreparedStoredJobs).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSlice).not.toHaveBeenCalled();
    expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
    expect(mocks.assembleJobsDataset).not.toHaveBeenCalled();
  });
});
