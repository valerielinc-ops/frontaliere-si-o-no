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

import { fetchJobListings } from '../scripts/lib/blatters-hotel-job-parser.mjs';

describe("Blatter's Hotelcareer transport rescue", () => {
  beforeEach(() => {
    specCrawlerMocks.fetchHtmlViaBrowser.mockReset();
    specCrawlerMocks.runSpecInProduction.mockReset();
  });

  it('passes browser and unmarked-empty rescue to the production spec runner', async () => {
    specCrawlerMocks.runSpecInProduction.mockResolvedValue([]);
    const spec = {
      companyKey: 'blatters-hotel',
      seedUrls: ['https://www.hotelcareer.ch/jobs/blatter-s-hotel-arosa-4340'],
    };

    await expect(fetchJobListings({ spec: spec as any })).resolves.toEqual([]);

    const [runtimeSpec, runtime] = specCrawlerMocks.runSpecInProduction.mock.calls[0];
    expect(runtimeSpec).toMatchObject({
      rescueOnEmptyListing: true,
      emptyListingOutcome: 'anti_bot_block',
    });
    expect(runtime.browserFetchImpl).toBe(specCrawlerMocks.fetchHtmlViaBrowser);
    expect(runtime.onPageFetched).toEqual(expect.any(Function));
  });

  it('allows deterministic callers to replace the browser rescue', async () => {
    specCrawlerMocks.runSpecInProduction.mockResolvedValue([]);
    const browserFetchImpl = vi.fn();

    await fetchJobListings({
      spec: { companyKey: 'blatters-hotel', seedUrls: [] } as any,
      runtime: { browserFetchImpl },
    });

    const [, runtime] = specCrawlerMocks.runSpecInProduction.mock.calls[0];
    expect(runtime.browserFetchImpl).toBe(browserFetchImpl);
  });
});
