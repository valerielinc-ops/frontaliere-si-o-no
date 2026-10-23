import { beforeEach, describe, expect, it, vi } from 'vitest';

const specCrawlerMocks = vi.hoisted(() => ({
  fetchHtmlViaBrowser: vi.fn(),
  runSpecInProduction: vi.fn(),
}));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    fetchHtmlViaBrowser: specCrawlerMocks.fetchHtmlViaBrowser,
    runSpecInProduction: specCrawlerMocks.runSpecInProduction,
  };
});

import { fetchJobListings } from '../scripts/lib/sta-job-parser.mjs';

describe('STA transport rescue', () => {
  beforeEach(() => {
    specCrawlerMocks.fetchHtmlViaBrowser.mockReset();
    specCrawlerMocks.runSpecInProduction.mockReset();
  });

  it('passes the bounded browser rescue to the production spec runner', async () => {
    specCrawlerMocks.runSpecInProduction.mockResolvedValue([]);
    const spec = {
      companyKey: 'sta',
      seedUrls: ['https://www.sta.jobs/stellen/'],
    };

    await expect(fetchJobListings({ spec: spec as any })).resolves.toEqual([]);

    const [runtimeSpec, runtime] = specCrawlerMocks.runSpecInProduction.mock.calls[0];
    expect(runtimeSpec).toBe(spec);
    expect(runtime.browserFetchImpl).toBe(specCrawlerMocks.fetchHtmlViaBrowser);
    expect(runtime.listingExtractor).toEqual(expect.any(Function));
  });

  it('allows tests and source-specific callers to replace the browser rescue', async () => {
    specCrawlerMocks.runSpecInProduction.mockResolvedValue([]);
    const browserFetchImpl = vi.fn();

    await fetchJobListings({
      spec: { companyKey: 'sta', seedUrls: [] } as any,
      runtime: { browserFetchImpl },
    });

    const [, runtime] = specCrawlerMocks.runSpecInProduction.mock.calls[0];
    expect(runtime.browserFetchImpl).toBe(browserFetchImpl);
  });
});
